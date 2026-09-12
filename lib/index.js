// dsh-astrbot-ingress
// AstrBot（含 OneBot v11）→ 本机 DeepSeek Harness Agent 的 HTTP 入站。
// 仅监听 127.0.0.1；AstrBot 容器通过 host.docker.internal:3188 访问。

import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFile, copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { downloadUrlToFile, isHttpUrl, probeUrl } from './fetchfile.js'
import {
  BEACON_FILE,
  SENSITIVE_NAMES,
  beaconPayload,
  createFileToken,
  extractSendFiles,
  firstThinkingLine,
  formatQuestions,
  isPathAllowedForSend,
  looksLikeBridgeCommand,
  parseBeacon,
  parseQuestionReply,
  progressDigestLine,
  reasoningOfAssistantMessage,
  resolveExistingFile,
  splitForIm,
  stripInternalHints,
  takeFileToken,
  summarizeToolCall,
  textOfAssistantMessage,
} from './pure.js'

// 不 import @deepseek-ai/dsh-llm：本包以 link: 装在 D:\dswk，Node 会从那里解析
// 依赖，找不到宿主 profile 里的 peer。followup 只需要一个带 id 的 user message。
function createUserMessage({ content, source }) {
  return {
    id: randomUUID(),
    role: 'user',
    content,
    source: source ?? { kind: 'user' },
  }
}

export const name = 'dsh-astrbot-ingress'
export const inject = ['sessions', 'agents', 'approval', 'workspaceRegistry', 'sessionPersistence']

const DEFAULT_PORT = 3188
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_MAX_CHARS = 1500
const DEFAULT_APPROVAL_TIMEOUT_SEC = 600
/** /probe-url 的单次探测超时。 */
const PROBE_URL_TIMEOUT_MS = 5_000
/** 信标刷新间隔；AstrBot 侧超过 10 分钟没刷新就当失效。 */
const BEACON_REFRESH_MS = 30_000

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function dataDir() {
  return join(dshHome(), 'dsh-astrbot-ingress')
}

function configPath() {
  return join(dataDir(), 'config.json')
}

function sessionsPath() {
  return join(dataDir(), 'sessions.json')
}

/** 信标路径：~/.dsh/astrbot-ingress.json（同机 AstrBot 读它拿端口与 token）。 */
function beaconPath() {
  return join(dshHome(), BEACON_FILE)
}

/** 轮次归位的追踪日志：DSH 控制台看不到，写文件方便排查「正文慢一拍」。 */
function tracePath() {
  return join(dataDir(), 'trace.log')
}

/** 本包版本，写进信标方便对侧报版本。 */
function pluginVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return pkg.version ?? null
  } catch {
    return null
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req, limit = 20_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function bearerOf(req) {
  const header = req.headers.authorization || ''
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const alt = req.headers['x-dsh-token']
  return typeof alt === 'string' ? alt.trim() : ''
}

const WIN_SYSTEM_PREFIXES = [
  'windows', 'winnt', 'program files', 'program files (x86)',
  'system volume information', '$recycle.bin', 'recovery', 'boot', 'programdata\\microsoft',
]

async function isSafeWorkspacePath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return { valid: false, error: '路径不能为空' }
  const trimmed = targetPath.trim()
  if (!trimmed || trimmed.includes('\0')) return { valid: false, error: '非法路径' }
  let normalized
  try {
    let raw = trimmed
    if (/^[A-Za-z]:$/.test(raw)) raw = `${raw}\\`
    normalized = normalize(resolve(raw))
  } catch (err) {
    return { valid: false, error: `路径解析失败: ${err.message}` }
  }
  const driveMatch = normalized.match(/^[A-Za-z]:\\(.*)$/)
  if (driveMatch) {
    const rest = driveMatch[1].toLowerCase()
    for (const prefix of WIN_SYSTEM_PREFIXES) {
      if (rest === prefix || rest.startsWith(`${prefix}\\`)) {
        return { valid: false, error: `禁止作为工作区：系统目录（${prefix}）` }
      }
    }
  } else if (normalized.startsWith('\\\\')) {
    return { valid: false, error: '禁止作为工作区：UNC 路径' }
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  for (const part of parts) {
    if (SENSITIVE_NAMES.has(part.toLowerCase())) {
      return { valid: false, error: `禁止作为工作区：敏感目录「${part}」` }
    }
  }
  try {
    const s = await stat(normalized)
    if (!s.isDirectory()) return { valid: false, error: `不是文件夹：${normalized}` }
    await realpath(normalized)
  } catch (err) {
    return { valid: false, error: `无法访问：${err.message}` }
  }
  return { valid: true, path: normalized }
}

async function ensureRegisteredWorkspace(ctx, targetPath) {
  const safety = await isSafeWorkspacePath(targetPath)
  if (!safety.valid) return safety
  const resolved = safety.path
  let entities = []
  try { entities = ctx.workspaceRegistry?.list ? await ctx.workspaceRegistry.list() : [] } catch { /* ignore */ }
  const hit = (entities || []).find((ws) => ws?.path && normalize(ws.path).toLowerCase() === normalize(resolved).toLowerCase())
  if (hit) return { valid: true, path: hit.path, added: false, title: hit.title || basename(hit.path) }
  const title = basename(resolved) || resolved
  try {
    if (ctx.workspaceRegistry?.add) await ctx.workspaceRegistry.add({ path: resolved, title })
    else if (ctx.workspaceRegistry?.register) await ctx.workspaceRegistry.register({ path: resolved, title })
  } catch (err) {
    return { valid: false, error: `登记工作区失败：${err.message}` }
  }
  return { valid: true, path: resolved, added: true, title }
}

function digestLine(events) {
  let turn = 0
  let tools = 0
  let lastTool
  let inTurn = false
  for (const event of events ?? []) {
    if (event.type === 'turn/start') {
      turn = event.data?.turn ?? turn
      inTurn = true
      tools = 0
      lastTool = undefined
    } else if (event.type === 'turn/end') {
      inTurn = false
    } else if (event.type === 'tool/call' && inTurn) {
      tools += 1
      lastTool = event.data?.name
    }
  }
  if (!inTurn || turn === 0) return null
  const steps = tools > 0 ? `${tools} 次工具调用` : '思考中'
  const last = lastTool ? ` | 最近: ${lastTool}` : ''
  return `[处理中] 第 ${turn} 轮 | ${steps}${last}`
}

function summarizeError(error) {
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message).slice(0, 200)
  }
  return String(error).slice(0, 200)
}

async function loadJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    const raw = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const BUNDLED_SKILL_NAME = 'dsh-qq-send-file'
const BUNDLED_SKILL_PROVIDER = 'dsh-astrbot-ingress'
const BUNDLED_SKILL_RANK = 600
const BUNDLED_SKILL_INVOCATION = { modelInvocable: true, userInvocable: true }

/** 权限预设的中文说明。DSH 的预设表默认只有名字，这里补上给 QQ 看的标签。 */
const PERMISSION_PRESET_LABELS = {
  'read-only': { label: '只读', desc: '只能看，不能改文件、不能执行' },
  'workspace-write': { label: '工作区可写', desc: '能改工作区内文件；越界或要执行的操作会问你' },
  'danger-full-access': { label: '完全放行', desc: '沙箱全放开；需要询问的操作直接拒绝，不会问你' },
}

function bundledQqSendSkillProvider() {
  const moduleDirectory = dirname(fileURLToPath(new URL(import.meta.url)))
  const path = resolve(moduleDirectory, '../skills/dsh-qq-send-file/SKILL.md')
  const raw = readFileSync(path, 'utf8')
  const end = raw.indexOf('\n---\n', 4)
  if (!raw.startsWith('---\n') || end < 0) throw new Error('dsh-qq-send-file SKILL.md has invalid frontmatter')
  const fm = raw.slice(4, end)
  const descMatch = fm.match(/^description:\s*"([^"]+)"/m) || fm.match(/^description:\s*(.+)$/m)
  const description = descMatch ? descMatch[1].trim() : 'Send a workspace file back to QQ via the AstrBot DSH bridge.'
  const content = raw.slice(end + 5)
  const meta = {
    name: BUNDLED_SKILL_NAME,
    description,
    invocation: BUNDLED_SKILL_INVOCATION,
    source: 'bundled',
    provider: BUNDLED_SKILL_PROVIDER,
    path,
    resourceBase: { kind: 'directory', path: dirname(path) },
  }
  return {
    name: BUNDLED_SKILL_PROVIDER,
    list: () => Promise.resolve([{ ...meta, rank: BUNDLED_SKILL_RANK, locator: path }]),
    get: () => Promise.resolve({ ...meta, content }),
  }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger(name)
  ctx.inject(['skills'], (skillCtx) => {
    try {
      skillCtx.skills.registerProvider(() => bundledQqSendSkillProvider())
    } catch (err) {
      logger.warn?.('register dsh-qq-send-file skill failed: %s', err?.message ?? err)
    }
  })
  let sessionController = null
  ctx.inject(['sessionController'], (modelCtx) => {
    sessionController = modelCtx.sessionController
    return () => { sessionController = null }
  })

  /** 活会话同步取事件：Session 用 snapshotEvents()/ownEvents()，不读 `session.events` 属性。 */
  function liveEventsOf(session) {
    if (!session) return null
    try {
      if (typeof session.snapshotEvents === 'function') {
        const events = session.snapshotEvents()
        if (Array.isArray(events)) return events
      }
    } catch { /* ignore */ }
    try {
      if (typeof session.ownEvents === 'function') {
        const events = session.ownEvents()
        if (Array.isArray(events)) return events
      }
    } catch { /* ignore */ }
    return Array.isArray(session.events) ? session.events : null
  }

  /**
   * 取一个会话的事件：先活会话，再冷读（sessionController.inspect → sessionPersistence.open）。
   * 注意 `sessionPersistence` 没有 `load()`，只有 create/open/flush/stat/list。
   */
  async function readSessionEvents(sessionId, liveSession) {
    const live = liveSession ?? (() => {
      try { return ctx.sessions?.get?.(sessionId) } catch { return null }
    })()
    const fromLive = liveEventsOf(live)
    if (fromLive) return fromLive
    try {
      if (sessionController?.inspect) {
        const insp = await sessionController.inspect(sessionId)
        if (Array.isArray(insp?.events)) return insp.events
      }
    } catch { /* ignore */ }
    try {
      const persistence = ctx.sessionPersistence
      if (persistence?.open) {
        const handle = await persistence.open(sessionId, 'read')
        try {
          if (Array.isArray(handle?.events)) return handle.events
          const slice = await handle.read()
          if (Array.isArray(slice?.events)) return slice.events
        } finally {
          try { await handle?.close?.() } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return null
  }
  let projections = null
  ctx.inject(['sessionProjections'], (projCtx) => {
    projections = projCtx.sessionProjections
    return () => { projections = null }
  })
  let commands = null
  ctx.inject(['commands'], (cmdCtx) => {
    commands = cmdCtx.commands
    return () => { commands = null }
  })
  let permissionPresets = null
  ctx.inject(['permissionPresets'], (permCtx) => {
    permissionPresets = permCtx.permissionPresets
    return () => { permissionPresets = null }
  })
  const host = config.host || DEFAULT_HOST
  const port = Number(config.port) > 0 ? Number(config.port) : DEFAULT_PORT
  const maxMessageChars = Number(config.maxMessageChars) > 200 ? Number(config.maxMessageChars) : DEFAULT_MAX_CHARS
  const approvalTimeoutSec = Number(config.approvalTimeoutSec) > 10 ? Number(config.approvalTimeoutSec) : DEFAULT_APPROVAL_TIMEOUT_SEC
  // 入站附件的 URL 下载（AstrBot 侧登记一次性 URL，我们自己去取）：体积上限与超时
  const inboundUrlMaxMb = Math.max(1, Math.min(4096, Number(config.inboundUrlMaxMb) || 200))
  const inboundUrlMaxBytes = Math.round(inboundUrlMaxMb * 1024 * 1024)
  const inboundUrlTimeoutMs = Math.max(5_000, Math.min(600_000, Number(config.inboundUrlTimeoutMs) || 60_000))
  // 出站文件「拉取凭证」的单文件上限（AstrBot 侧看不见文件时用它来取）
  const outboundUrlMaxMb = Math.max(1, Math.min(4096, Number(config.outboundUrlMaxMb) || 200))
  const reasoningModeRaw = String(config.reasoningMode || 'first-line').toLowerCase()
  const reasoningMode = ['off', 'first-line', 'full'].includes(reasoningModeRaw) ? reasoningModeRaw : 'first-line'
  const showToolCalls = config.showToolCalls !== false
  const TOOL_LINE_MAX_PER_TURN = 20
  // 多条工具行攒成一条发；1 = 每条单独发（旧行为）
  const toolLineBatch = Math.max(1, Math.min(20, Number(config.toolLineBatch) || 5))
  // 过程显示档位。AstrBot 插件配置会跟着每次请求带过来（body.progress），
  // 这里只是「请求没带」时的兜底，两边默认值保持一致。
  const PROGRESS_MODES = ['full', 'digest', 'minimal']
  const PROGRESS_INTERVAL_RANGE = [10, 300]
  const clampProgressSec = (value) => {
    const sec = Number(value)
    if (!Number.isFinite(sec) || sec <= 0) return 60
    return Math.max(PROGRESS_INTERVAL_RANGE[0], Math.min(PROGRESS_INTERVAL_RANGE[1], Math.round(sec)))
  }
  const progressModeRaw = String(config.progressMode || 'digest').toLowerCase()
  const progressMode = PROGRESS_MODES.includes(progressModeRaw) ? progressModeRaw : 'digest'
  const progressIntervalSec = clampProgressSec(config.progressIntervalSec ?? 60)
  let defaultCwd = typeof config.cwd === 'string' && config.cwd.trim()
    ? config.cwd.trim()
    : ''

  const state = {
    token: '',
    sessions: {}, // umo -> { sessionId, cwd, updatedAt }
    pendingApprovals: new Map(), // sessionId -> { number, resolve, timer, senderId }
    pendingQuestions: new Map(), // sessionId -> { number, resolve, timer, senderId, choices }
    approvalCounter: 0,
    questionCounter: 0,
    turns: new Map(), // sessionId -> { umo, senderId, res, chatType }
    restoring: new Map(),
    heartbeats: new Map(), // sessionId -> interval
    modelFlat: [], // 最近一次列出的模型（编号 → 选择）
  }

  const DIGEST_INTERVAL_MS = 180_000

  function stopHeartbeat(sessionId) {
    const timer = state.heartbeats.get(sessionId)
    if (timer) {
      clearInterval(timer)
      state.heartbeats.delete(sessionId)
    }
  }

  /** 把攒着的工具行一次性发出去。 */
  function flushToolBuffer(turn) {
    const buf = turn?.toolBuf
    if (!buf || buf.length === 0) return
    if (turn.res && !turn.res.writableEnded) {
      sseWrite(turn.res, 'status', { text: buf.join('\n') })
    }
    turn.toolBuf = []
  }

  /** 这个回合用哪档进度：AstrBot 插件配置跟着请求来，没带就用 ingress 配置。 */
  function resolveProgress(raw) {
    const spec = raw && typeof raw === 'object' ? raw : {}
    const mode = PROGRESS_MODES.includes(String(spec.mode || '').toLowerCase())
      ? String(spec.mode).toLowerCase()
      : progressMode
    return { mode, intervalMs: clampProgressSec(spec.intervalSec ?? progressIntervalSec) * 1000 }
  }

  function progressOf(turn) {
    return turn?.progress || { mode: progressMode, intervalMs: progressIntervalSec * 1000 }
  }

  /** digest 档的周期汇报：一条把这段时间的过程说完。 */
  function digestProgressLine(turn) {
    const line = progressDigestLine({
      elapsedMs: Date.now() - (turn.startedAt || Date.now()),
      tools: turn.toolCount || 0,
      recent: turn.recentTools || [],
      lastThinking: turn.lastThinking || '',
      showTools: showToolCalls,
    })
    turn.recentTools = []
    return line
  }

  function startProgressTimer(session, turn) {
    const sessionId = session?.id
    if (!sessionId) return
    stopHeartbeat(sessionId)
    if (turn && !turn.startedAt) turn.startedAt = Date.now()
    const { mode, intervalMs } = progressOf(turn)
    if (mode === 'minimal') {
      // 一个字都不发，但必须有字节流：AstrBot 那边按「读空闲」算超时，纯静默会被掐断。
      const timer = setInterval(() => {
        const live = state.turns.get(sessionId)
        if (!live?.res || live.res.writableEnded) {
          stopHeartbeat(sessionId)
          return
        }
        try { live.res.write(': ping\n\n') } catch { stopHeartbeat(sessionId) }
      }, Math.min(intervalMs, 30_000))
      if (typeof timer.unref === 'function') timer.unref()
      state.heartbeats.set(sessionId, timer)
      return
    }
    if (mode === 'digest') {
      const timer = setInterval(() => {
        const live = state.turns.get(sessionId)
        if (!live?.res || live.res.writableEnded) {
          stopHeartbeat(sessionId)
          return
        }
        // 在等人工批准时别刷屏：那会儿不是「在跑」，是「在等人」。
        if (live.awaitingHuman) return
        sseWrite(live.res, 'status', { text: digestProgressLine(live) })
      }, intervalMs)
      if (typeof timer.unref === 'function') timer.unref()
      state.heartbeats.set(sessionId, timer)
      return
    }
    const timer = setInterval(async () => {
      const live = state.turns.get(sessionId)
      if (!live?.res || live.res.writableEnded) {
        stopHeartbeat(sessionId)
        return
      }
      const line = digestLine(liveEventsOf(session))
      if (!line) {
        stopHeartbeat(sessionId)
        return
      }
      sseWrite(live.res, 'status', { text: line })
    }, DIGEST_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    state.heartbeats.set(sessionId, timer)
  }

  const persistSessions = () => saveJson(sessionsPath(), state.sessions).catch((err) => {
    logger.warn('persist sessions failed: %s', err?.message ?? err)
  })

  let attachmentStore = null
  try {
    ctx.inject(['attachments'], (c) => {
      attachmentStore = c.attachments
      return () => { attachmentStore = null }
    })
  } catch (err) {
    logger.warn?.('attachments inject skipped: %s', err?.message ?? err)
  }

  const init = (async () => {
    await mkdir(dataDir(), { recursive: true })
    const stored = await loadJson(configPath(), {})
    if (typeof stored.token === 'string' && stored.token.length >= 16) {
      state.token = stored.token
    } else {
      state.token = randomBytes(24).toString('hex')
      await saveJson(configPath(), { token: state.token, createdAt: new Date().toISOString() })
      logger.info('generated ingress token at %s', configPath())
    }
    state.sessions = await loadJson(sessionsPath(), {})
    if (!defaultCwd) {
      try {
        const entities = ctx.workspaceRegistry?.list ? await ctx.workspaceRegistry.list() : []
        defaultCwd = entities?.[0]?.path || process.cwd()
      } catch {
        defaultCwd = process.cwd()
      }
      logger.info?.('default cwd: %s', defaultCwd)
    }
  })()

  function defaultAgentOptions() {
    const agentOptions = {}
    try {
      const def = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (def?.provider) agentOptions.provider = def.provider
      if (def?.model) agentOptions.model = def.model
    } catch { /* ignore */ }
    return agentOptions
  }

  async function attachWorkspace(sessionId, cwd) {
    try {
      const reg = ctx.workspaceRegistry
      const entities = reg?.list ? await reg.list() : []
      const norm = normalize(cwd).toLowerCase()
      const match = (entities || []).find((ws) => ws?.path && normalize(ws.path).toLowerCase() === norm)
      if (match?.attachSession) await match.attachSession(sessionId)
    } catch { /* ignore */ }
  }

  async function isPersisted(sessionId) {
    try {
      const headers = await ctx.sessionPersistence?.list?.()
      return Array.isArray(headers) && headers.some((h) => h?.id === sessionId)
    } catch {
      return false
    }
  }

  function shortId(id) {
    return String(id || '').replace(/^session-/, '').slice(0, 8)
  }

  function formatTokens(n) {
    const value = Number(n)
    if (!Number.isFinite(value) || value < 0) return '?'
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
    return String(Math.round(value))
  }

  /** 读取会话的上下文占用与累计 token（会话未挂载时返回 null）。 */
  function readContextUsage(sessionId) {
    try {
      const session = ctx.sessions?.get?.(sessionId)
      if (!session) return { attached: false }
      const reg = projections ?? ctx.sessionProjections
      if (!reg?.snapshot) return { attached: true, available: false }
      const snap = reg.snapshot(session, ['contextPressure', 'tokenUsage', 'contextBreakdown'])
      const pressure = snap?.values?.contextPressure ?? {}
      const used = pressure.projectedTokens ?? pressure.pressureTokens
      return {
        attached: true,
        available: true,
        used: Number.isFinite(used) ? used : undefined,
        window: Number.isFinite(pressure.contextWindow) ? pressure.contextWindow : undefined,
        surface: Number.isFinite(pressure.surfaceTokens) ? pressure.surfaceTokens : undefined,
        totals: snap?.values?.tokenUsage ?? null,
        breakdown: snap?.values?.contextBreakdown ?? null,
      }
    } catch {
      return { attached: true, available: false }
    }
  }

  /** 单行占用摘要，用于压缩前后对比。 */
  function contextLabel(info) {
    if (!info?.attached || !info.available) return '未知'
    if (info.used === undefined) return '未知'
    if (!info.window) return formatTokens(info.used)
    const percent = Math.min(100, Math.round((info.used / info.window) * 100))
    return `${percent}%（${formatTokens(info.used)}/${formatTokens(info.window)}）`
  }

  function formatContextUsage(info) {
    if (!info) return ''
    if (!info.attached) return '\n- 上下文：会话未挂载（先发一条消息再看）'
    if (!info.available) return '\n- 上下文：暂无数据'
    const lines = []
    if (info.used !== undefined && info.window) {
      const percent = Math.min(100, Math.round((info.used / info.window) * 100))
      const warn = percent >= 80 ? '  ⚠️ 接近上限' : ''
      lines.push(`\n- 上下文：${percent}%（${formatTokens(info.used)} / ${formatTokens(info.window)}，剩余 ${formatTokens(Math.max(0, info.window - info.used))}）${warn}`)
    } else if (info.used !== undefined) {
      lines.push(`\n- 上下文：已用 ${formatTokens(info.used)}（上限未知）`)
    } else {
      lines.push('\n- 上下文：暂无数据')
    }
    const totals = info.totals
    if (totals && (totals.uncachedInputTokens || totals.outputTokens || totals.cacheReadTokens)) {
      lines.push(`\n- 累计 token：输入 ${formatTokens(totals.uncachedInputTokens)}`
        + `（缓存读 ${formatTokens(totals.cacheReadTokens)} / 写 ${formatTokens(totals.cacheWriteTokens)}）`
        + ` 输出 ${formatTokens(totals.outputTokens)}`)
    }
    const breakdown = info.breakdown
    if (breakdown) {
      lines.push(`\n- 上下文构成：系统 ${formatTokens(breakdown.systemTokens)}`
        + ` / 工具 ${formatTokens(breakdown.toolsTokens)}`
        + ` / 消息 ${formatTokens(breakdown.messageTokens)}`)
    }
    return lines.join('')
  }

  function foldTitle(events) {
    const list = events ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]
      if (e?.type === 'session/title' && e.data?.title) return String(e.data.title)
    }
    return ''
  }

  function readJsonFile(path) {
    try {
      if (!existsSync(path)) return null
      return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      return null
    }
  }

  function cacheRecordFromFile(data) {
    if (!data || typeof data !== 'object') return null
    if (data.rows) return data
    if (data.record?.rows) return data.record
    return null
  }

  function loadCacheRecord(id) {
    if (!id) return null
    const home = dshHome()
    const aliases = [id]
    if (id.startsWith('session-')) aliases.push(id.slice('session-'.length))
    else aliases.push(`session-${id}`)
    const shardDir = join(home, 'storages', 'session_projcache', 'sessions')
    for (const key of aliases) {
      const shard = cacheRecordFromFile(readJsonFile(join(shardDir, `${key}.json`)))
      if (shard) return shard
    }
    const table = readJsonFile(join(home, 'storages', 'session_projcache.json'))?.tables?.sessions || {}
    for (const key of aliases) {
      if (table[key]) return table[key]
    }
    return null
  }

  function loadProjCache() {
    const table = readJsonFile(join(dshHome(), 'storages', 'session_projcache.json'))?.tables?.sessions || {}
    return table
  }

  function titleFromCache(cache) {
    const title = cache?.rows?.title?.val
    if (typeof title === 'string' && title.trim()) return title.trim()
    const goal = cache?.rows?.goal?.val
    if (typeof goal === 'string' && goal.trim()) return goal.trim()
    if (goal && typeof goal === 'object') {
      const obj = goal.objective ?? goal.goal?.objective ?? goal.title
      if (typeof obj === 'string' && obj.trim()) return obj.trim()
    }
    return ''
  }

  function titleOfSession(id, live, cache) {
    const liveEvents = liveEventsOf(live)
    const fromLive = live?.title || (liveEvents ? foldTitle(liveEvents) : '')
    if (fromLive) return fromLive
    const fromCache = titleFromCache(cache)
    if (fromCache) return fromCache
    return ''
  }

  async function listWorkspaceSessions(cwd) {
    const result = []
    const seen = new Set()
    const norm = cwd ? normalize(cwd).toLowerCase() : ''
    const projCache = loadProjCache()
    try {
      const entities = ctx.workspaceRegistry?.list ? await ctx.workspaceRegistry.list() : []
      const match = (entities || []).find((ws) => ws?.path && normalize(ws.path).toLowerCase() === norm)
      const ids = match?.sessionIds || []
      for (const id of ids) {
        if (!id || seen.has(id)) continue
        seen.add(id)
        const live = ctx.sessions?.get?.(id)
        const cache = projCache[id] || loadCacheRecord(id)
        const isBound = Object.values(state.sessions).some((m) => m?.sessionId === id)
        if (cache?.rows?.sessionListMetadata?.val?.blank === true && !isBound) continue
        let title = titleOfSession(id, live, cache)
        if (!title) {
          try {
            const events = await readSessionEvents(id, live)
            title = foldTitle(events ?? [])
          } catch { /* ignore */ }
        }
        result.push({ id, title: title || '新会话', cwd: match?.path || cwd })
      }
    } catch { /* ignore */ }
    try {
      const liveList = [...(ctx.sessions?.list?.() ?? [])]
      for (const s of liveList) {
        if (!s?.id || seen.has(s.id)) continue
        const sCwd = s.header?.cwd || s.cwd
        if (norm && sCwd && normalize(sCwd).toLowerCase() !== norm) continue
        seen.add(s.id)
        const title = titleOfSession(s.id, s, projCache[s.id] || loadCacheRecord(s.id)) || '新会话'
        result.unshift({ id: s.id, title, cwd: sCwd || cwd })
      }
    } catch { /* ignore */ }
    return result
  }

  function agentPresetsService() {
    try {
      return ctx.get?.('agentPresets') ?? ctx.agentPresets ?? null
    } catch {
      return null
    }
  }

  /**
   * 解析一个当前真实存在的 preset id。
   * 不能写死名字：老代码写死的 routing-suite 已不存在，会让会话头记上无效 preset。
   * 之后任何 resume（含网页打开）都会失败。解析不到就不写进 meta。
   */
  async function resolveAgentPreset() {
    const presets = agentPresetsService()
    if (!presets) return undefined
    const wanted = typeof presets.defaultId === 'string' && presets.defaultId.trim()
      ? presets.defaultId.trim()
      : 'standard'
    try {
      if (typeof presets.resolve === 'function') {
        const resolved = await presets.resolve(wanted)
        if (resolved?.id) return resolved.id
      }
      return wanted
    } catch (err) {
      logger.warn?.('agent preset "%s" unavailable: %s', wanted, err?.message ?? err)
      return undefined
    }
  }

  /** setup 里挂载 preset，让 QQ 会话拿到和网页一致的组合。 */
  function presetSetup(presetId) {
    if (!presetId) return undefined
    return async (agentCtx) => {
      const presets = agentPresetsService()
      if (!presets?.mount) return
      try {
        await presets.mount(agentCtx, presetId)
      } catch (err) {
        logger.warn?.('mount agent preset "%s" failed: %s', presetId, err?.message ?? err)
      }
    }
  }

  /** 取会话最近 N 条助手回复的正文（优先活会话，否则冷读）。 */
  async function lastAssistantTexts(sessionId, count) {
    const events = await readSessionEvents(sessionId)
    if (!Array.isArray(events)) return null
    const out = []
    for (let i = events.length - 1; i >= 0 && out.length < count; i--) {
      const e = events[i]
      if (e?.type !== 'assistant/message') continue
      const text = stripInternalHints(textOfAssistantMessage(e.data?.message)).trim()
      if (text) out.push(text)
    }
    return out.reverse()
  }

  async function bindExistingSession(umo, sessionId, cwd, chatType, senderId) {
    state.sessions[umo] = { sessionId, cwd, updatedAt: Date.now(), chatType, senderId }
    await persistSessions()
    const live = ctx.agents.get?.(sessionId)
    if (live) return live
    const persisted = await isPersisted(sessionId)
    if (!persisted) throw new Error(`会话不存在：${sessionId}，发 /dsh new 新建`)
    const presetId = await resolveAgentPreset()
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: defaultAgentOptions(),
      setup: presetSetup(presetId),
    })
    return handle?.agent ?? handle
  }

  async function getOrCreateAgent(umo, { reset = false, cwd: cwdOverride } = {}) {
    const cwd = cwdOverride || state.sessions[umo]?.cwd || defaultCwd
    let mapped = state.sessions[umo]
    if (reset || !mapped?.sessionId) {
      const sessionId = `session-${randomUUID()}`
      const presetId = await resolveAgentPreset()
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd, ...(presetId ? { agentPreset: presetId } : {}) },
        agentOptions: defaultAgentOptions(),
        setup: presetSetup(presetId),
      })
      const agent = handle?.agent ?? handle
      const realId = agent?.session?.id || handle?.session?.id || sessionId
      mapped = { sessionId: realId, cwd, updatedAt: Date.now() }
      state.sessions[umo] = mapped
      await persistSessions()
      await attachWorkspace(realId, cwd)
      return agent
    }

    const sessionId = mapped.sessionId
    const live = ctx.agents.get?.(sessionId)
    if (live) return live

    if (state.restoring.has(sessionId)) return state.restoring.get(sessionId)
    const restore = (async () => {
      const persisted = await isPersisted(sessionId)
      const presetId = await resolveAgentPreset()
      const handle = persisted
        ? await ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: defaultAgentOptions(),
          setup: presetSetup(presetId),
        })
        : await ctx.agents.create({
          sessionId,
          meta: { cwd: mapped.cwd || cwd, ...(presetId ? { agentPreset: presetId } : {}) },
          agentOptions: defaultAgentOptions(),
          setup: presetSetup(presetId),
        })
      return handle?.agent ?? handle
    })().finally(() => state.restoring.delete(sessionId))
    state.restoring.set(sessionId, restore)
    return restore
  }

  function ownsAgent(agent, sessionId) {
    return Boolean(agent?.session?.id && agent.session.id === sessionId)
  }

  // ── 轮次归位（修「正文慢一拍」） ──────────────────────────────────────────
  // 现象：上一条的正文要等下一段正文才出现（甚至跑进下一轮的流里）。
  // 两个原因：
  //   ① 每条助手消息的**最后一段**被压着等 turn/end，只为拼「—— 本回合结束」，
  //      而 turn/end 之前可能还有很长的工具阶段 → 正文被压几分钟；
  //   ② 新消息进来时旧回合的 SSE 被掐掉，但旧回合**迟到的事件**只会按 sessionId 找回合，
  //      于是被算到新一轮头上（实测：T1 的 "AAAA" 出现在 T2 的流里）。
  // DSH 的每个事件都带 `turn: number`（SessionEventMap），所以能按轮次号丢掉迟到的尾巴。
  state.fileTokens = state.fileTokens || new Map() // 出站拉取凭证 token -> {path,name,size,expiresAt}
  const staleTurns = new Map() // sessionId -> Set<turnNo>（被新消息顶掉的旧轮次）
  /** 只压这么久等 turn/end 来拼结束标记；等不到就把正文先发出去，绝不压着正文。 */
  const endGraceMs = Math.max(200, Math.min(10_000, Number(config.endGraceMs) || 1200))
  /** 诊断追踪：默认**关**（0.3.7 起）。要排障就设 `traceLog: true`，不用了记得关回去。 */
  const traceOn = config.traceLog === true

  /** 一行式追踪：写 ~/.dsh/dsh-astrbot-ingress/trace.log（DSH 控制台看不到，只能落盘）。 */
  function trace(what, extra = '') {
    if (!traceOn) return
    appendFile(tracePath(), `${new Date().toISOString()} ${what} ${extra}\n`, 'utf8').catch(() => {})
  }

  // trace.log 只留最近一段：启动时超过 1MB 就换名归档一份，避免长期无人看着长成几百兆。
  if (traceOn) {
    stat(tracePath())
      .then((st) => (st.size > 1024 * 1024 ? rm(`${tracePath()}.old`, { force: true }).then(() => copyFile(tracePath(), `${tracePath()}.old`)).then(() => writeFile(tracePath(), '', 'utf8')) : null))
      .catch(() => {})
  }

  function shortId(sessionId) {
    return String(sessionId || '').replace(/^session-/, '').slice(0, 8)
  }

  function markStaleTurn(sessionId, turnNo) {
    if (!Number.isFinite(turnNo)) return
    let set = staleTurns.get(sessionId)
    if (!set) {
      set = new Set()
      staleTurns.set(sessionId, set)
    }
    set.add(turnNo)
    if (set.size > 50) set.delete(set.values().next().value)
    trace('supersede', `session=${shortId(sessionId)} turn=${turnNo}`)
  }

  function clearHeldTimer(turn) {
    if (turn?.heldTimer) {
      clearTimeout(turn.heldTimer)
      turn.heldTimer = null
    }
  }

  /** 把压着的那段正文立刻补发（切段/回合结束/被打断时都要先做）。 */
  function flushHeldText(turn, why = '') {
    if (!turn) return
    clearHeldTimer(turn)
    const text = turn.pendingText
    turn.pendingText = ''
    if (text) {
      trace('flush-held', `session=${shortId(turn.sessionId)} chars=${text.length} why=${why || '-'}`)
      if (turn.res && !turn.res.writableEnded) sseWrite(turn.res, 'text', { text })
    }
  }

  function holdLastChunk(turn, text) {
    clearHeldTimer(turn)
    turn.pendingText = text
    turn.heldTimer = setTimeout(() => {
      turn.heldTimer = null
      if (turn.pendingText && turn.res && !turn.res.writableEnded) {
        sseWrite(turn.res, 'text', { text: turn.pendingText })
        trace('grace-flush', `session=${shortId(turn.sessionId)} chars=${turn.pendingText.length} after=${endGraceMs}ms`)
        turn.pendingText = ''
      }
    }, endGraceMs)
    turn.heldTimer.unref?.()
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (!sessionId) return
    const turn = state.turns.get(sessionId)
    if (!turn?.res || turn.res.writableEnded) return
    // 迟到的事件属于被顶掉的旧轮次 → 丢掉，别再串到新一轮
    const turnNo = Number(event?.data?.turn)
    if (Number.isFinite(turnNo)) {
      if (staleTurns.get(sessionId)?.has(turnNo)) {
        trace('drop-stale', `session=${shortId(sessionId)} turn=${turnNo} event=${event.type}`)
        return
      }
      if (turn.turnNo == null) {
        turn.turnNo = turnNo
        trace('adopt-turn', `session=${shortId(sessionId)} turn=${turnNo}`)
      } else if (turnNo < turn.turnNo) {
        markStaleTurn(sessionId, turnNo)
        trace('drop-older', `session=${shortId(sessionId)} turn=${turnNo} < ${turn.turnNo} event=${event.type}`)
        return
      } else turn.turnNo = turnNo
    }

    if (event.type === 'turn/start') {
      startProgressTimer(session, turn)
      return
    }
    if (event.type === 'tool/call') {
      const name = String(event.data?.name || 'tool')
      const summary = summarizeToolCall(name, event.data?.arguments)
      const line = summary ? `🔧 ${name} ${summary}` : `🔧 ${name}`
      if (progressOf(turn).mode !== 'full') {
        // digest/minimal：工具行不实时发，只累计给周期汇报用。
        turn.toolCount = (turn.toolCount || 0) + 1
        const label = summary ? `${name} ${summary}` : name
        const recent = turn.recentTools || (turn.recentTools = [])
        if (recent[recent.length - 1] !== label) recent.push(label)
        if (recent.length > 3) recent.splice(0, recent.length - 3)
        return
      }
      if (!showToolCalls) return
      turn.toolCount = (turn.toolCount || 0) + 1
      if (line === turn.lastToolLine || turn.toolCount > TOOL_LINE_MAX_PER_TURN) return
      turn.lastToolLine = line
      // 多条工具行攒成一条发，避免 QQ 里被刷屏
      if (toolLineBatch > 1) {
        turn.toolBuf = turn.toolBuf || []
        turn.toolBuf.push(line)
        if (turn.toolBuf.length >= toolLineBatch) flushToolBuffer(turn)
      } else {
        sseWrite(turn.res, 'status', { text: line })
      }
      return
    }
    if (event.type === 'assistant/message') {
      flushToolBuffer(turn)
      const mode = progressOf(turn).mode
      const raw = stripInternalHints(textOfAssistantMessage(event.data?.message))
      const thinking = reasoningMode === 'off'
        ? ''
        : (() => {
          const all = stripInternalHints(reasoningOfAssistantMessage(event.data?.message))
          if (!all) return ''
          return reasoningMode === 'full' ? all : firstThinkingLine(all)
        })()
      if (thinking) {
        if (mode === 'full') {
          if (thinking !== turn.lastThinking) {
            turn.lastThinking = thinking
            const mark = reasoningMode === 'full' ? '💭 思考' : '💭'
            sseWrite(turn.res, 'text', { text: `${mark} ${thinking}` })
          }
        } else {
          // 思考首行留着，周期汇报里当「还在干嘛」的线索。
          turn.lastThinking = firstThinkingLine(thinking)
        }
      }
      if (!raw) return
      const cwd = [...Object.values(state.sessions)].find((m) => m?.sessionId === sessionId)?.cwd || defaultCwd || process.cwd()
      const { cleanText, files } = extractSendFiles(raw, cwd)
      if (cleanText) {
        const chunks = splitForIm(cleanText, maxMessageChars)
        flushHeldText(turn, 'next-message') // 上一条助手消息压着的那段，先补发
        for (let i = 0; i < chunks.length - 1; i++) sseWrite(turn.res, 'text', { text: chunks[i] })
        holdLastChunk(turn, chunks[chunks.length - 1])
      }
      for (const filePath of files.slice(0, 4)) {
        if (!isPathAllowedForSend(filePath, cwd)) {
          sseWrite(turn.res, 'status', { text: `拒绝发送工作区外文件：\`${filePath}\`` })
          continue
        }
        try {
          const st = statSync(filePath)
          if (st.size > 12 * 1024 * 1024) {
            sseWrite(turn.res, 'status', { text: `文件过大未发送（>${st.size}）：\`${basename(filePath)}\`` })
            continue
          }
          sseWrite(turn.res, 'file', {
            name: basename(filePath),
            path: filePath,
            size: st.size,
          })
        } catch (err) {
          sseWrite(turn.res, 'status', { text: `发送失败 ${basename(filePath)}：${err.message}` })
        }
      }
      return
    }
    if (event.type === 'turn/end') {
      stopHeartbeat(sessionId)
      flushToolBuffer(turn)
      // 「—— 本回合结束」不是过程噪音，是「跑完了」的信号：发完文件/长任务后尤其需要，
      // 所以**任何档位都发**（minimal 也不例外）。
      clearHeldTimer(turn)
      const held = turn.pendingText || ''
      turn.pendingText = ''
      const reason = event.data?.reason || {}
      if (reason.kind === 'error') {
        if (held) sseWrite(turn.res, 'text', { text: held })
        sseWrite(turn.res, 'error', { message: summarizeError(reason.error) })
      } else if (reason.kind === 'aborted') {
        if (held) sseWrite(turn.res, 'text', { text: held })
        sseWrite(turn.res, 'status', { text: '任务已停止' })
      } else if (held) {
        sseWrite(turn.res, 'text', { text: `${held}\n\n—— 本回合结束` })
      } else {
        sseWrite(turn.res, 'status', { text: '—— 本回合结束' })
      }
      trace('turn-end', `session=${shortId(sessionId)} turn=${turn.turnNo} held=${held.length} reason=${reason.kind || 'ok'}`)
      sseWrite(turn.res, 'done', { sessionId })
      try { turn.res.end() } catch { /* ignore */ }
      state.turns.delete(sessionId)
    }
  })

  ctx.on('approval/request', async (req, next) => {
    const sessionId = req.agent?.session?.id
    const turn = sessionId ? state.turns.get(sessionId) : null
    if (!turn || !ownsAgent(req.agent, sessionId)) return next?.()

    const number = ++state.approvalCounter
    flushToolBuffer(turn)
    const timeoutMin = Math.max(1, Math.round(approvalTimeoutSec / 60))
    const prompt = [
      `## 操作权限确认 (#${number})`,
      '',
      `工具：\`${req.toolName}\``,
      req.reason ? `原因：${String(req.reason)}` : '',
      `等待 ${timeoutMin} 分钟，超时自动拒绝。`,
      '',
      '回复 `1` / `批准` 执行；回复 `2` / `拒绝` 取消（不必加 /dsh）。',
    ].filter(Boolean).join('\n')
    sseWrite(turn.res, 'approval', { number, text: prompt })
    turn.awaitingHuman = true

    let settled = false
    let resolveIm
    const imPromise = new Promise((resolve) => { resolveIm = resolve })
    const settle = (outcome) => {
      if (settled) return
      settled = true
      turn.awaitingHuman = false
      const entry = state.pendingApprovals.get(sessionId)
      if (entry?.timer) clearTimeout(entry.timer)
      state.pendingApprovals.delete(sessionId)
      resolveIm(outcome)
    }
    const timer = setTimeout(() => settle('rejected'), approvalTimeoutSec * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    const onAbort = () => settle('cancelled')
    req.signal?.addEventListener('abort', onAbort, { once: true })
    state.pendingApprovals.set(sessionId, { number, resolve: settle, timer, senderId: turn.senderId })
    try {
      return await imPromise
    } finally {
      req.signal?.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      turn.awaitingHuman = false
    }
  }, { prepend: true })

  /**
   * 「提问」和「审批」是并排的两条 waterfall 事件：
   * 审批走 `approval/request`，`ask_user_question` 走 `user-questions/request`
   * （`@deepseek-ai/dsh-user-questions`，网页端由 dsh-client-ui-user-questions 接）。
   *
   * 这里是**两边并行**，不是独占：先把问题发到 QQ，同时也让网页端照常显示，
   * 谁先回答算谁的。独占过一版，结果群里在跑的时候网页那张卡片点不了（用户会同时开着网页）。
   */
  ctx.on('user-questions/request', async (request, next) => {
    const sessionId = request?.agent?.session?.id
    const turn = sessionId ? state.turns.get(sessionId) : null
    if (!turn || !ownsAgent(request.agent, sessionId)) return next?.()
    const questions = Array.isArray(request.questions) ? request.questions : []
    if (questions.length === 0) return next?.()

    const number = ++state.questionCounter
    flushToolBuffer(turn)
    const { text, choices } = formatQuestions(number, questions, approvalTimeoutSec)
    sseWrite(turn.res, 'question', { number, text })
    turn.awaitingHuman = true

    let settled = false
    let resolveIm
    const imPromise = new Promise((resolve) => { resolveIm = resolve })
    const settle = (outcome) => {
      if (settled) return
      settled = true
      turn.awaitingHuman = false
      const entry = state.pendingQuestions.get(sessionId)
      if (entry?.timer) clearTimeout(entry.timer)
      state.pendingQuestions.delete(sessionId)
      resolveIm(outcome)
    }
    // 超时绝不替人作答：plan-review 的选项里就写着「批准」，乱选等于自动放行。
    const timer = setTimeout(() => settle({ kind: 'timeout' }), approvalTimeoutSec * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    const onAbort = () => settle({ kind: 'timeout' })
    request.signal?.addEventListener('abort', onAbort, { once: true })
    state.pendingQuestions.set(sessionId, { number, resolve: settle, timer, senderId: turn.senderId, choices })

    // 网页那条路：交给下游 answerer（客户端）。它没人接/出错都不该影响 QQ，
    // 所以失败就换成一个永不 settle 的 promise，让 QQ 的结果说了算。
    const NEVER = new Promise(() => {})
    let webAnswer = NEVER
    try {
      const downstream = next?.()
      if (downstream && typeof downstream.then === 'function') webAnswer = downstream.catch(() => NEVER)
    } catch { /* 下游同步抛错：忽略，继续等 QQ */ }

    try {
      const raced = await Promise.race([
        imPromise.then((outcome) => ({ from: 'qq', outcome })),
        webAnswer.then((answer) => ({ from: 'web', answer })),
      ])
      if (raced.from === 'web') {
        settle({ kind: 'answered-elsewhere' }) // 清掉 QQ 这边的待答状态与定时器
        return raced.answer
      }
      const outcome = raced.outcome
      if (outcome?.kind === 'answer') return outcome.answer
      if (outcome?.kind === 'cancel') {
        throw new Error('用户在 QQ 里放弃了这个问题（回复「取消」）。别再追问，按你认为最合理的做法继续，并把关键假设写进最终回复。')
      }
      throw new Error(`等了 ${Math.max(1, Math.round(approvalTimeoutSec / 60))} 分钟没人在 QQ 或网页上回答，问题已作废。别再追问，按你认为最合理的做法继续，并把关键假设写进最终回复。`)
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      turn.awaitingHuman = false
    }
  }, { prepend: true })

  /** QQ 里回了提问：编号 → 选项标签；「答 xx」→ 自定义回答。命令词不算回答。 */
  function tryResolveQuestion(sessionId, senderId, text) {
    const entry = state.pendingQuestions.get(sessionId)
    if (!entry) return false
    // 有提问挂着的时候，`stop`/`status` 这类命令必须照旧生效：
    // 否则用户想停回合，结果被当成「回答：stop」喂给模型。
    if (looksLikeBridgeCommand(text)) return false
    if (entry.senderId && senderId && entry.senderId !== senderId) return false
    const parsed = parseQuestionReply(entry.choices, text)
    if (!parsed) return false
    if (parsed.kind === 'cancel') {
      entry.resolve({ kind: 'cancel' })
      return true
    }
    if (parsed.answers) {
      entry.resolve({ kind: 'answer', answer: { answers: parsed.answers } })
      return true
    }
    // 自定义回答：多问题时落到第一个问题上（QQ 里一次答多题本来就少见）。
    const firstId = entry.choices[0]?.id ?? 'answer'
    entry.resolve({ kind: 'answer', answer: { answers: [{ id: firstId, selected: [], custom: parsed.custom }] } })
    return true
  }

  function tryResolveApproval(sessionId, senderId, text) {
    const entry = state.pendingApprovals.get(sessionId)
    if (!entry) return false
    const t = text.trim().replace(/^\/+/, '')
    const yes = /^(?:yes|y|1|批准|同意)$/i.test(t)
    const no = /^(?:no|n|2|拒绝|不同意)$/i.test(t)
    if (!yes && !no) return false
    if (entry.senderId && senderId && entry.senderId !== senderId) return false
    entry.resolve(yes ? 'allowed-once' : 'rejected')
    return true
  }

  async function handleInbound(body, res) {
    const umo = String(body?.umo || '').trim()
    const text = String(body?.text || '').trim()
    const senderId = String(body?.senderId || '').trim()
    const chatType = body?.chatType === 'group' ? 'group' : 'private'
    if (!umo) {
      json(res, 400, { ok: false, error: 'umo required' })
      return
    }
    const inboundFilesEarly = Array.isArray(body?.files) ? body.files : []
    if (!text && inboundFilesEarly.length === 0) {
      json(res, 400, { ok: false, error: 'text required' })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': ok\n\n')

    const mapped = state.sessions[umo]
    if (mapped?.sessionId && tryResolveApproval(mapped.sessionId, senderId, text)) {
      sseWrite(res, 'status', { text: '已记录审批回复' })
      sseWrite(res, 'done', { sessionId: mapped.sessionId })
      res.end()
      return
    }
    if (mapped?.sessionId && tryResolveQuestion(mapped.sessionId, senderId, text)) {
      sseWrite(res, 'status', { text: '已记录你的回答' })
      sseWrite(res, 'done', { sessionId: mapped.sessionId })
      res.end()
      return
    }
    // 编号/取消只在「有未决提问或审批」时有意义。AstrBot 侧为了能接住答案，
    // 会把纯编号也转发过来；这里兜一句说明，免得被当成新任务丢给模型。
    if (/^\d+(?:[\s,，、]+\d+)*$/.test(text.trim()) || /^(?:取消|算了|跳过|skip|cancel)$/i.test(text.trim())) {
      sseWrite(res, 'status', { text: '现在没有等你回答的提问或审批，编号没生效。要开工就直接说要做什么。' })
      sseWrite(res, 'done', { sessionId: mapped?.sessionId || '(none)' })
      res.end()
      return
    }

    const cmd = text.replace(/^\/+/, '').trim()

    if (/^compact$/i.test(cmd)) {
      const sessionId = mapped?.sessionId
      if (!sessionId) {
        sseWrite(res, 'error', { message: '还没有会话，先 /dsh <任务> 或 /dsh new' })
        sseWrite(res, 'done', { sessionId: '(none)' })
        res.end()
        return
      }
      const agent = ctx.agents.get?.(sessionId)
      if (!agent) {
        sseWrite(res, 'error', { message: '会话未挂载（先发一条消息唤醒它），再试 /dsh compact' })
        sseWrite(res, 'done', { sessionId })
        res.end()
        return
      }
      const runtime = commands ?? ctx.commands
      if (!runtime?.execute) {
        sseWrite(res, 'error', { message: '当前 DSH 没有命令服务（commands 未就绪），重启 dsh web 后再试' })
        sseWrite(res, 'done', { sessionId })
        res.end()
        return
      }
      if (agent.status === 'running' || state.turns.get(sessionId)) {
        sseWrite(res, 'error', { message: '当前有回合在跑，压缩只能在空闲时做：等它结束或先 /dsh stop' })
        sseWrite(res, 'done', { sessionId })
        res.end()
        return
      }
      const before = readContextUsage(sessionId)
      sseWrite(res, 'status', { text: `正在压缩上下文…（当前 ${contextLabel(before)}）` })
      const controller = new AbortController()
      res.on('close', () => controller.abort())
      try {
        const exec = await runtime.execute(agent, '/compact', [], controller.signal)
        if (!exec) {
          sseWrite(res, 'error', { message: 'DSH 没有 /compact 命令（command-compact 可能没挂载）' })
        } else {
          const after = readContextUsage(sessionId)
          const prefix = exec.result.kind === 'success' ? '✅' : '⚠️'
          sseWrite(res, 'text', {
            text: `${prefix} ${exec.result.text || '(无说明)'}\n上下文：${contextLabel(before)} → ${contextLabel(after)}`,
          })
        }
      } catch (err) {
        sseWrite(res, 'error', { message: `压缩失败：${err?.message ?? err}` })
      }
      sseWrite(res, 'done', { sessionId })
      res.end()
      return
    }

    const permArg = /^perm(?:\s|$)/i.test(cmd) ? (cmd.replace(/^perm\s*/i, '') || '').trim() : null
    if (permArg !== null) {
      const sessionId = mapped?.sessionId
      const presets = (() => {
        try { return permissionPresets ?? ctx.permissionPresets ?? null } catch { return null }
      })()
      if (!presets?.names) {
        sseWrite(res, 'error', { message: '当前 DSH 没有权限预设服务（permissionPresets 未就绪），重启 dsh web 后再试' })
        sseWrite(res, 'done', { sessionId: sessionId || '(none)' })
        res.end()
        return
      }
      const names = [...presets.names]
      const label = (name) => PERMISSION_PRESET_LABELS[name]?.label || name
      const describe = (name) => {
        const local = PERMISSION_PRESET_LABELS[name]
        if (local?.desc) return local.desc
        try {
          const option = presets.optionOf?.(name)
          return option?.description || ''
        } catch { return '' }
      }
      const liveSession = sessionId && sessionId !== '(none)' ? ctx.sessions?.get?.(sessionId) : null
      const currentOf = () => {
        if (!liveSession) return ''
        try { return presets.current(liveSession) } catch { return '' }
      }

      if (!permArg || /^list$/i.test(permArg)) {
        const current = currentOf()
        const lines = names.map((name, i) => {
          const desc = describe(name)
          const mark = name === current ? '  ← 当前' : ''
          return `${i + 1}. ${label(name)} \`${name}\`${desc ? ` — ${desc}` : ''}${mark}`
        })
        const head = current
          ? `权限预设（当前：${label(current)}${current === 'custom' ? '' : ` \`${current}\``}）`
          : '权限预设（当前：会话未挂载，先发一条消息）'
        sseWrite(res, 'text', {
          text: `${head}\n\n${lines.join('\n')}\n\n切换：\`/dsh perm 2\` 或 \`/dsh perm ${names[names.length - 1] || 'workspace-write'}\``,
        })
        sseWrite(res, 'done', { sessionId: sessionId || '(none)' })
        res.end()
        return
      }

      if (!sessionId || sessionId === '(none)') {
        sseWrite(res, 'error', { message: '还没有会话，先 /dsh <任务> 或 /dsh new' })
        sseWrite(res, 'done', { sessionId: '(none)' })
        res.end()
        return
      }
      let target = names.includes(permArg) ? permArg : null
      if (!target && /^\d+$/.test(permArg)) target = names[Number(permArg) - 1] ?? null
      if (!target) {
        sseWrite(res, 'error', { message: `未知预设：${permArg}。先发 /dsh perm 看列表` })
        sseWrite(res, 'done', { sessionId })
        res.end()
        return
      }
      const session = liveSession
      const agent = ctx.agents.get?.(sessionId)
      if (!session || !agent) {
        sseWrite(res, 'error', { message: '会话未挂载（先发一条消息唤醒它），再试 /dsh perm' })
        sseWrite(res, 'done', { sessionId })
        res.end()
        return
      }
      const runtimeCmd = commands ?? ctx.commands
      try {
        // 优先走 DSH 自带的 /permission：它用活会话写入器，会把政策变更也告诉模型。
        let viaCommand = false
        if (runtimeCmd?.execute) {
          const controller = new AbortController()
          res.on('close', () => controller.abort())
          const exec = await runtimeCmd.execute(agent, `/permission ${target}`, [], controller.signal)
          if (exec) {
            viaCommand = true
            if (exec.result.kind === 'error') {
              sseWrite(res, 'error', { message: `切换失败：${exec.result.text}` })
            }
          }
        }
        if (!viaCommand) {
          if (!presets.set) throw new Error('permissionPresets.set 不可用')
          presets.set(session, target)
        }
        const now = (() => { try { return presets.current(session) } catch { return target } })()
        const spec = (() => { try { return presets.resolve?.(now) ?? null } catch { return null } })()
        const detail = spec ? `\n- sandbox：\`${spec.sandbox}\`\n- 审批：\`${spec.approval}\`` : ''
        const note = spec?.approval === 'never' ? '\n（审批为 never：需要询问的操作会被直接拒绝，不会来问你）' : ''
        sseWrite(res, 'text', {
          text: `已切换权限预设：${label(now)} \`${now}\`${detail}${note}\n下一条工具调用起生效。`,
        })
      } catch (err) {
        sseWrite(res, 'error', { message: `切换失败：${err?.message ?? err}` })
      }
      sseWrite(res, 'done', { sessionId })
      res.end()
      return
    }

    const lastMatch = cmd.match(/^last(?:\s+(\d+))?$/i)
    if (lastMatch) {
      const sessionId = mapped?.sessionId
      if (!sessionId) {
        sseWrite(res, 'error', { message: '还没有会话，先 /dsh <任务> 或 /dsh new' })
        sseWrite(res, 'done', { sessionId: '(none)' })
        res.end()
        return
      }
      const want = Math.min(5, Math.max(1, Number(lastMatch[1] || 1) || 1))
      const texts = await lastAssistantTexts(sessionId, want)
      if (!texts || texts.length === 0) {
        sseWrite(res, 'text', { text: '这个会话还没有助手回复。' })
        sseWrite(res, 'done', { sessionId })
        res.end()
        return
      }
      const running = ctx.agents.get?.(sessionId)?.status === 'running' || Boolean(state.turns.get(sessionId))
      if (running) sseWrite(res, 'status', { text: '注意：当前回合还在跑，下面是已记录的最后一条。' })
      for (const text of texts) {
        for (const chunk of splitForIm(text, maxMessageChars)) {
          sseWrite(res, 'text', { text: chunk })
        }
      }
      sseWrite(res, 'done', { sessionId })
      res.end()
      return
    }

    if (/^status$/i.test(cmd)) {
      const sessionId = mapped?.sessionId || '(none)'
      let title = ''
      if (mapped?.sessionId) {
        const live = ctx.sessions?.get?.(mapped.sessionId)
        title = titleOfSession(mapped.sessionId, live, loadCacheRecord(mapped.sessionId))
      }
      const modelLine = mapped?.model ? `\n- 模型：\`${mapped.model.provider}/${mapped.model.model}\`` : ''
      const usageLine = mapped?.sessionId && sessionId !== '(none)'
        ? formatContextUsage(readContextUsage(mapped.sessionId))
        : ''
      sseWrite(res, 'text', { text: `DSH 入站正常\n- 会话：${title || '(无标题)'} \`${sessionId === '(none)' ? sessionId : shortId(sessionId)}\`\n- cwd: ${mapped?.cwd || defaultCwd}${modelLine}${usageLine}\n- umo: ${umo}` })
      sseWrite(res, 'done', { sessionId })
      res.end()
      return
    }

    if (/^(?:help|commands)$/i.test(cmd)) {
      sseWrite(res, 'text', { text: [
        '用法（QQ 里只打一个斜杠）：',
        '`/dsh <任务>` 交给 Harness',
        '`/dsh status` 当前会话和工作区',
        '`/dsh ws` 列出工作区',
        '`/dsh ws 1` 或 `/dsh ws <绝对路径>` 切换（未登记的路径会写入工作区列表）',
        '`/dsh new` 同一工作区新开会话',
        '`/dsh ls` 列出当前工作区会话',
        '`/dsh use 1` 或 `/dsh use c0857d1a` 切到已有会话',
        '`/dsh stop` 停止当前回合',
        '`/dsh steer 改用那个方案` 给正在跑的回合补一句',
        '`/dsh rename 新标题` 给当前会话改名',
        '`/dsh end` 解开当前 QQ 会话绑定（不删 DSH 历史）',
        '`/dsh send <路径>` 把工作区内文件发到 QQ',
        '`/dsh model` 列出模型；`/dsh model 3` 或 `/dsh model <provider>/<model>` 切换',
        '`/dsh compact` 手动压缩上下文（会话空闲时）',
        '`/dsh last` 补发最后一条回复（`/dsh last 3` 取最近三条）',
        '`/dsh perm` 查看/切换权限预设（只读 / 工作区可写 / 完全放行）',
        '审批回复：`批准` / `拒绝`（不必再加 /dsh）',
        '群里引用机器人的 DSH 回复，可直接续聊，不必每句 /dsh',
      ].join('\n') })
      sseWrite(res, 'done', { sessionId: mapped?.sessionId || '(none)' })
      res.end()
      return
    }

    const modelArg = /^model(?:\s|$)/i.test(cmd) ? (cmd.replace(/^model\s*/i, '') || '').trim() : null
    const modelFirst = modelArg ? (modelArg.split(/\s+/)[0] || '') : ''
    const looksLikeModelCmd = modelArg !== null && (
      modelArg === ''
      || /^\d+$/.test(modelFirst)
      || modelFirst.includes('/')
      || modelArg.split(/\s+/).length === 1
    )
    if (looksLikeModelCmd) {
      const arg = modelArg
      const sessionId = mapped?.sessionId
      if (!sessionController?.modelCatalog) {
        sseWrite(res, 'error', { message: '当前 DSH 没有模型服务（sessionController 未就绪），重启 dsh web 后再试' })
        sseWrite(res, 'done', { sessionId: sessionId || '(none)' })
        res.end()
        return
      }
      let catalog
      try {
        catalog = await sessionController.modelCatalog()
      } catch (err) {
        sseWrite(res, 'error', { message: `读取模型目录失败：${err?.message ?? err}` })
        sseWrite(res, 'done', { sessionId: sessionId || '(none)' })
        res.end()
        return
      }
      const flat = []
      for (const group of catalog?.groups ?? []) {
        for (const model of group.models ?? []) {
          flat.push({
            provider: group.id,
            providerName: group.name || group.id,
            model: model.id,
            name: model.name || model.id,
            efforts: model.reasoning?.efforts ?? [],
          })
        }
      }
      state.modelFlat = flat

      if (!flat.length) {
        const fails = (catalog?.failures ?? []).map((f) => `${f.name || f.id}: ${f.message}`).join('\n')
        sseWrite(res, 'text', { text: `没有可用模型。${fails ? `\n${fails}` : ''}` })
        sseWrite(res, 'done', { sessionId: sessionId || '(none)' })
        res.end()
        return
      }

      const current = mapped?.model
        ? `${mapped.model.provider}/${mapped.model.model}`
        : catalog?.default
          ? `${catalog.default.provider}/${catalog.default.model}（默认）`
          : '(未知)'

      if (!arg) {
        const shown = flat.slice(0, 60).map((m, i) => {
          const effort = m.efforts.length ? `  [${m.efforts.map((e) => e.id).join('/')}]` : ''
          return `${i + 1}. \`${m.provider}/${m.model}\`${effort}`
        })
        const more = flat.length > 60 ? `\n…还有 ${flat.length - 60} 个` : ''
        const fails = (catalog?.failures ?? []).map((f) => `${f.name || f.id}: ${f.message}`).join('\n')
        sseWrite(res, 'text', {
          text: `当前模型：\`${current}\`\n\n${shown.join('\n')}${more}${fails ? `\n\n不可用：\n${fails}` : ''}\n\n切换：\`/dsh model 3\`、\`/dsh model ${flat[0].provider}/${flat[0].model}\``,
        })
        sseWrite(res, 'done', { sessionId: sessionId || '(none)' })
        res.end()
        return
      }

      if (!sessionId) {
        sseWrite(res, 'error', { message: '还没有会话，先 /dsh new 或 /dsh <任务>' })
        sseWrite(res, 'done', { sessionId: '(none)' })
        res.end()
        return
      }

      const [specRaw, effortRaw] = arg.split(/\s+/)
      const spec = (specRaw || '').trim()
      let hit = null
      if (/^\d+$/.test(spec)) {
        hit = flat[Number(spec) - 1] ?? null
      } else if (spec.includes('/')) {
        const idx = spec.indexOf('/')
        const provider = spec.slice(0, idx)
        const model = spec.slice(idx + 1)
        hit = flat.find((m) => m.provider === provider && m.model === model)
          ?? flat.find((m) => m.provider.toLowerCase() === provider.toLowerCase() && m.model.toLowerCase() === model.toLowerCase())
          ?? null
      } else {
        const exact = flat.filter((m) => m.model === spec)
        const loose = exact.length ? exact : flat.filter((m) => m.model.toLowerCase().includes(spec.toLowerCase()))
        if (loose.length === 1) hit = loose[0]
        else if (loose.length > 1) {
          const names = loose.slice(0, 10).map((m) => `\`${m.provider}/${m.model}\``).join('\n')
          sseWrite(res, 'error', { message: `匹配到多个模型，请写全：\n${names}` })
          sseWrite(res, 'done', { sessionId })
          res.end()
          return
        }
      }

      if (!hit) {
        sseWrite(res, 'error', { message: `找不到模型：${spec}。先发 /dsh model 看列表` })
        sseWrite(res, 'done', { sessionId })
        res.end()
        return
      }

      const effort = effortRaw
        ? (hit.efforts.find((e) => e.id === effortRaw)?.id
          ?? hit.efforts.find((e) => e.name === effortRaw)?.id
          ?? effortRaw)
        : undefined

      try {
        const out = await sessionController.selectModel({
          sessionId,
          provider: hit.provider,
          model: hit.model,
          ...(effort ? { reasoningEffort: effort } : {}),
        })
        const sel = out?.selected ?? { provider: hit.provider, model: hit.model }
        mapped.model = sel
        mapped.updatedAt = Date.now()
        await persistSessions()
        sseWrite(res, 'text', {
          text: `已切换模型：\`${sel.provider}/${sel.model}\`${sel.reasoningEffort ? ` (${sel.reasoningEffort})` : ''}\n下一条任务生效。`,
        })
      } catch (err) {
        sseWrite(res, 'error', { message: `切换失败：${err?.message ?? err}` })
      }
      sseWrite(res, 'done', { sessionId })
      res.end()
      return
    }

    if (/^(?:ws|workspace|wslist|workspacelist)$/i.test(cmd)) {
      let lines = []
      try {
        const entities = ctx.workspaceRegistry?.list ? await ctx.workspaceRegistry.list() : []
        lines = (entities || []).map((ws, i) => `${i + 1}. ${ws.title || '(无标题)'} — \`${ws.path}\``)
      } catch { /* ignore */ }
      if (lines.length === 0) {
        lines = ['(工作区账本为空，可用 /dsh ws <绝对路径> 指定)']
      }
      sseWrite(res, 'text', { text: `当前 cwd：\`${mapped?.cwd || defaultCwd}\`\n\n${lines.join('\n')}\n\n切换：\`/dsh ws 1\` 或 \`/dsh ws D:\\\\dswk\`` })
      sseWrite(res, 'done', { sessionId: mapped?.sessionId || '(none)' })
      res.end()
      return
    }

    const wsMatch = cmd.match(/^(?:ws|workspace)\s+(.+)$/i)
    if (wsMatch) {
      const arg = wsMatch[1].trim().replace(/^["']|["']$/g, '')
      const looksLikeWorkspace = /^\d+$/.test(arg)
        || /^[a-zA-Z]:[\\/]/.test(arg)
        || arg.startsWith('\\\\')
        || arg.startsWith('/')
      if (looksLikeWorkspace) {
        let target = arg
        let registeredNote = ''
        if (/^\d+$/.test(arg)) {
          try {
            const entities = ctx.workspaceRegistry?.list ? await ctx.workspaceRegistry.list() : []
            const hit = entities?.[Number(arg) - 1]
            if (!hit?.path) {
              sseWrite(res, 'error', { message: `没有第 ${arg} 号工作区，先发 /dsh ws` })
              sseWrite(res, 'done', { sessionId: mapped?.sessionId || '(none)' })
              res.end()
              return
            }
            target = hit.path
          } catch (err) {
            sseWrite(res, 'error', { message: String(err?.message ?? err) })
            sseWrite(res, 'done', { sessionId: mapped?.sessionId || '(none)' })
            res.end()
            return
          }
        } else {
          const ensured = await ensureRegisteredWorkspace(ctx, target)
          if (!ensured.valid) {
            sseWrite(res, 'error', { message: ensured.error })
            sseWrite(res, 'done', { sessionId: mapped?.sessionId || '(none)' })
            res.end()
            return
          }
          target = ensured.path
          if (ensured.added) registeredNote = `\n已写入工作区列表：${ensured.title}`
        }
        const agent = await getOrCreateAgent(umo, { reset: true, cwd: target })
        const sessionId = agent.session.id
        state.sessions[umo] = { sessionId, cwd: target, updatedAt: Date.now(), chatType, senderId }
        await persistSessions()
        sseWrite(res, 'text', { text: `已切换工作区到 \`${target}\`${registeredNote}\n新会话 \`${sessionId.slice(0, 8)}\`。下一条 \`/dsh\` 消息会在这里执行。` })
        sseWrite(res, 'done', { sessionId })
        res.end()
        return
      }
      // 「/dsh ws 协议怎么写」走普通任务，不当切工作区
    }

    if (/^(?:ls|sessions|list)$/i.test(cmd)) {
      const cwd = mapped?.cwd || defaultCwd
      const rows = await listWorkspaceSessions(cwd)
      if (rows.length === 0) {
        sseWrite(res, 'text', { text: `当前工作区 \`${cwd}\` 还没有会话。\n发 \`/dsh new\` 或直接 \`/dsh <任务>\` 会新建一条。` })
      } else {
        const current = mapped?.sessionId
        const lines = rows.slice(0, 20).map((row, i) => {
          const mark = row.id === current ? ' ← 当前' : ''
          const label = String(row.title || '新会话').replace(/\n/g, ' ').slice(0, 40)
          return `${i + 1}. ${label}\n    \`${shortId(row.id)}\`${mark}`
        })
        sseWrite(res, 'text', { text: `工作区 \`${cwd}\` 的会话：\n\n${lines.join('\n')}\n\n切换：\`/dsh use 1\` 或 \`/dsh use ${shortId(rows[0].id)}\`` })
      }
      sseWrite(res, 'done', { sessionId: mapped?.sessionId || '(none)' })
      res.end()
      return
    }

    const useMatch = cmd.match(/^(?:use|session)\s+(\S+)$/i)
    if (useMatch) {
      const arg = useMatch[1].trim().replace(/^["']|["']$/g, '')
      const looksLikeSession = /^\d+$/.test(arg) || /^[0-9a-f-]{8,}$/i.test(arg.replace(/^session-/, ''))
      if (looksLikeSession) {
        const cwd = mapped?.cwd || defaultCwd
        const rows = await listWorkspaceSessions(cwd)
        let hit = null
        if (/^\d+$/.test(arg)) hit = rows[Number(arg) - 1]
        else {
          const needle = arg.replace(/^session-/, '').toLowerCase()
          hit = rows.find((row) => String(row.id).replace(/^session-/, '').toLowerCase().startsWith(needle))
            || rows.find((row) => String(row.id).toLowerCase() === arg.toLowerCase())
        }
        if (!hit?.id) {
          sseWrite(res, 'error', { message: `找不到会话 ${arg}。先发 /dsh ls` })
          sseWrite(res, 'done', { sessionId: mapped?.sessionId || '(none)' })
          res.end()
          return
        }
        const agent = await bindExistingSession(umo, hit.id, hit.cwd || cwd, chatType, senderId)
        const sessionId = agent?.session?.id || hit.id
        sseWrite(res, 'text', { text: `已切到「${hit.title}」\n\`${shortId(sessionId)}\`\n工作区 \`${hit.cwd || cwd}\`` })
        sseWrite(res, 'done', { sessionId })
        res.end()
        return
      }
      // 「/dsh use 这个方案」走普通任务
    }

    const renameMatch = cmd.match(/^rename\s+(.+)$/i)
    if (renameMatch) {
      const sessionId = mapped?.sessionId
      const newTitle = renameMatch[1].trim()
      if (!sessionId) {
        sseWrite(res, 'error', { message: '当前没有绑定会话，先 /dsh <任务> 或 /dsh use' })
        sseWrite(res, 'done', { sessionId: '(none)' })
        res.end()
        return
      }
      try {
        const session = ctx.sessions?.get?.(sessionId)
        if (session) session.title = newTitle
        if (ctx.sessionPersistence?.update) {
          await ctx.sessionPersistence.update(sessionId, { title: newTitle }).catch(() => {})
        }
      } catch (err) {
        sseWrite(res, 'error', { message: `重命名失败：${err?.message ?? err}` })
        sseWrite(res, 'done', { sessionId })
        res.end()
        return
      }
      sseWrite(res, 'text', { text: `已把当前会话改名为「${newTitle}」\n\`${shortId(sessionId)}\`` })
      sseWrite(res, 'done', { sessionId })
      res.end()
      return
    }

    if (/^end$/i.test(cmd)) {
      const sessionId = mapped?.sessionId
      if (sessionId) {
        stopHeartbeat(sessionId)
        try { ctx.agents.get?.(sessionId)?.cancel?.({ kind: 'user' }) } catch { /* ignore */ }
        delete state.sessions[umo]
        await persistSessions()
      }
      sseWrite(res, 'text', { text: sessionId
        ? `已解开绑定（会话 \`${shortId(sessionId)}\` 仍留在 DSH 里，可用 /dsh use 再接上）。`
        : '当前没有绑定的会话。' })
      sseWrite(res, 'done', { sessionId: sessionId || '(none)' })
      res.end()
      return
    }

    const sendMatch = cmd.match(/^send\s+(.+)$/i)
    if (sendMatch) {
      const cwd = mapped?.cwd || defaultCwd || process.cwd()
      const raw = sendMatch[1].trim().replace(/^["']|["']$/g, '')
      const filePath = resolveExistingFile(raw, cwd)
      if (!filePath) {
        sseWrite(res, 'error', { message: `找不到文件：${raw}` })
        sseWrite(res, 'done', { sessionId: mapped?.sessionId || '(none)' })
        res.end()
        return
      }
      if (!isPathAllowedForSend(filePath, cwd)) {
        sseWrite(res, 'error', { message: `拒绝发送工作区外文件：${filePath}` })
        sseWrite(res, 'done', { sessionId: mapped?.sessionId || '(none)' })
        res.end()
        return
      }
      try {
        const st = statSync(filePath)
        if (st.size > 12 * 1024 * 1024) {
          sseWrite(res, 'error', { message: `文件过大：${basename(filePath)}` })
        } else {
          sseWrite(res, 'file', { name: basename(filePath), path: filePath, size: st.size })
          sseWrite(res, 'text', { text: `已发送 \`${basename(filePath)}\`` })
        }
      } catch (err) {
        sseWrite(res, 'error', { message: String(err?.message ?? err) })
      }
      sseWrite(res, 'done', { sessionId: mapped?.sessionId || '(none)' })
      res.end()
      return
    }

    if (/^stop$/i.test(cmd)) {
      const sessionId = mapped?.sessionId
      const agent = sessionId ? ctx.agents.get?.(sessionId) : null
      if (!agent) {
        sseWrite(res, 'status', { text: '当前没有正在运行的任务' })
      } else {
        stopHeartbeat(sessionId)
        try { agent.cancel({ kind: 'user' }) } catch (err) {
          sseWrite(res, 'error', { message: String(err?.message ?? err) })
          sseWrite(res, 'done', { sessionId })
          res.end()
          return
        }
        sseWrite(res, 'status', { text: '已请求停止当前任务' })
      }
      sseWrite(res, 'done', { sessionId: sessionId || '(none)' })
      res.end()
      return
    }

    const steerMatch = cmd.match(/^steer\s+(.+)$/i)
    if (steerMatch) {
      const sessionId = mapped?.sessionId
      const agent = sessionId ? ctx.agents.get?.(sessionId) : null
      const hint = steerMatch[1].trim()
      if (!agent) {
        sseWrite(res, 'error', { message: '当前没有活动会话，先 /dsh <任务> 或 /dsh use' })
        sseWrite(res, 'done', { sessionId: sessionId || '(none)' })
        res.end()
        return
      }
      const message = createUserMessage({
        content: [{ type: 'text', text: hint }],
        source: { kind: 'user' },
      })
      const running = agent.status === 'running' || Boolean(state.turns.get(sessionId))
      if (running && typeof agent.steer === 'function') {
        agent.steer(message)
        sseWrite(res, 'status', { text: `已纠偏当前回合：${hint.slice(0, 80)}` })
      } else {
        agent.followup(message)
        sseWrite(res, 'status', { text: `当前没有在跑的回合，已作为下一条任务：${hint.slice(0, 80)}` })
      }
      sseWrite(res, 'done', { sessionId })
      res.end()
      return
    }

    const reset = /^new$/i.test(cmd)
    const prompt = reset ? '' : cmd
    const agent = await getOrCreateAgent(umo, { reset })
    const sessionId = agent.session.id
    state.sessions[umo] = {
      sessionId,
      cwd: state.sessions[umo]?.cwd || defaultCwd,
      updatedAt: Date.now(),
      chatType,
      senderId,
    }
    await persistSessions()

    if (reset && !prompt) {
      sseWrite(res, 'text', { text: `已新建 DSH 会话 \`${sessionId.slice(0, 8)}\`。下一条消息会交给这个会话。` })
      sseWrite(res, 'done', { sessionId })
      res.end()
      return
    }

    const existing = state.turns.get(sessionId)
    if (existing?.res && !existing.res.writableEnded) {
      // 被打断的旧回合：先把压着的正文补发给它自己的流（别让它串到新一轮），
      // 再记下它的轮次号——它迟到的事件会被丢掉。
      flushHeldText(existing, 'superseded')
      markStaleTurn(sessionId, existing.turnNo)
      sseWrite(existing.res, 'status', { text: '被新消息打断' })
      try { existing.res.end() } catch { /* ignore */ }
    }

    state.turns.set(sessionId, { umo, sessionId, senderId, res, chatType, progress: resolveProgress(body?.progress) })
    res.on('close', () => {
      const current = state.turns.get(sessionId)
      if (current?.res === res) {
        // 客户端提前断开：回合继续在 DSH 跑，结果不再推这条 SSE。
        clearHeldTimer(current)
        state.turns.delete(sessionId)
      }
    })

    sseWrite(res, 'ack', { sessionId, reset })
    const inboundFiles = Array.isArray(body?.files) ? body.files : []
    const cwd = state.sessions[umo]?.cwd || defaultCwd || process.cwd()
    const { content, notes } = await buildUserContent(prompt, inboundFiles, cwd)
    if (notes.length) sseWrite(res, 'status', { text: notes.join('\n') })
    agent.followup(createUserMessage({
      content,
      source: { kind: 'user' },
    }))
  }

  async function buildUserContent(prompt, inboundFiles, cwd) {
    const notes = []
    const content = []
    const saved = []
    const inbox = join(cwd, '.dsh-inbox')
    for (const file of inboundFiles.slice(0, 8)) {
      const rawKind = String(file?.kind || '').toLowerCase()
      const kind = rawKind === 'file' || rawKind === 'video' ? rawKind : 'image'
      const fallbackName = kind === 'image' ? 'image.png' : (kind === 'video' ? 'video.mp4' : 'file.bin')
      const origName = basename(String(file?.name || 'file')).replace(/[<>:"|?*]/g, '_') || fallbackName
      await mkdir(inbox, { recursive: true })
      const dest = join(inbox, `${Date.now()}-${origName}`)
      try {
        const urlValue = typeof file?.url === 'string' ? file.url.trim() : ''
        if (!(typeof file?.data === 'string' && file.data.trim()) && isHttpUrl(urlValue)) {
          // AstrBot 把附件登记成一次性 URL（/api/file/<token>）交给我们自己下载：
          // Docker 部署不必挂共享盘，也不受 base64 的 12MB 上限。
          const { bytes } = await downloadUrlToFile(urlValue, dest, {
            maxBytes: inboundUrlMaxBytes,
            timeoutMs: inboundUrlTimeoutMs,
          })
          if (bytes !== Number(file?.size || 0) && file?.size) {
            logger.info?.('inbound url size mismatch: got %d expect %d', bytes, Number(file.size))
          }
        } else if (typeof file?.data === 'string' && file.data.trim()) {
          const raw = file.data.includes(',') ? file.data.slice(file.data.indexOf(',') + 1) : file.data
          await writeFile(dest, Buffer.from(raw, 'base64'))
        } else {
          const src = String(file?.path || '').trim()
          if (file?.missing || !src || !existsSync(src)) {
            notes.push(`附件找不到：${src || origName}`)
            continue
          }
          await copyFile(src, dest)
        }
      } catch (err) {
        notes.push(`保存失败 ${origName}：${err.message}`)
        continue
      }
      saved.push({ kind, dest, name: origName })
      if (kind === 'image') {
        try {
          if (attachmentStore?.saveImage) {
            const bytes = new Uint8Array(await readFile(dest))
            const mediaType = guessImageType(origName, bytes)
            const ref = await attachmentStore.saveImage({ data: bytes, mediaType, name: origName })
            content.push({ type: 'image', attachment: ref })
          } else {
            notes.push(`当前 DSH 未注入 attachments，图片只按文件路径交给模型：\`${dest}\``)
          }
        } catch (err) {
          notes.push(`图片登记失败 ${origName}，模型将按文件路径读取：${err.message}`)
        }
      }
    }
    let text = prompt || ''
    if (saved.length) {
      const lines = saved.map((f) => {
        if (f.kind === 'video') {
          return `- 视频 \`${f.dest}\`（DSH 看不了画面，但可用 ffprobe 读元信息、用 ffmpeg 抽帧或转码；产物可用 [SEND_FILE] 发回）`
        }
        return `- ${f.kind === 'image' ? '图片' : '文件'} \`${f.dest}\``
      })
      text = [text, '', '用户从 QQ 发来的附件已保存到工作区。', ...lines].filter((x, i, a) => x !== '' || i === 0 || a[i - 1] !== '').join('\n')
    }
    if (text) content.unshift({ type: 'text', text })
    if (!content.length) content.push({ type: 'text', text: prompt || '(附件)' })
    return { content, notes }
  }

  function guessImageType(name, bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
    if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp'
    const lower = String(name || '').toLowerCase()
    if (lower.endsWith('.png')) return 'image/png'
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
    if (lower.endsWith('.gif')) return 'image/gif'
    if (lower.endsWith('.webp')) return 'image/webp'
    return 'image/png'
  }

  const server = createServer(async (req, res) => {
    try {
      await init
      const url = new URL(req.url || '/', `http://${host}:${port}`)
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { ok: true, plugin: name, host, port })
        return
      }
      if (req.method === 'GET' && url.pathname === '/binding') {
        if (bearerOf(req) !== state.token) {
          json(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        const umo = url.searchParams.get('umo') || ''
        const mapped = state.sessions[umo]
        json(res, 200, {
          ok: true,
          bound: Boolean(mapped?.sessionId),
          sessionId: mapped?.sessionId || null,
          cwd: mapped?.cwd || null,
        })
        return
      }
      if (req.method === 'GET' && url.pathname === '/probe-url') {
        // URL 入站的候选探测：AstrBot 猜不到 Docker 映射出来的宿主端口，
        // 所以由**这边**（跑在 DSH 所在的机器上）试着取一次，能取到才算数。
        if (bearerOf(req) !== state.token) {
          json(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        const target = url.searchParams.get('url') || ''
        const startedAt = Date.now()
        const result = await probeUrl(target, { timeoutMs: PROBE_URL_TIMEOUT_MS })
        json(res, 200, { ...result, ms: Date.now() - startedAt })
        return
      }
      if (req.method === 'POST' && url.pathname === '/file-token') {
        // 出站文件的「拉取凭证」：AstrBot 在容器里看不见这个文件时，拿它自己来取。
        // 校验与 [SEND_FILE] 完全一致（必须在该会话工作区内、且不在敏感路径段）。
        if (bearerOf(req) !== state.token) {
          json(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        let body = {}
        try {
          const raw = await readBody(req)
          body = raw ? JSON.parse(raw) : {}
        } catch {
          json(res, 400, { ok: false, error: 'invalid json' })
          return
        }
        const hostPath = String(body?.path || '').trim()
        const umo = String(body?.umo || '')
        const cwdForUmo = state.sessions[umo]?.cwd || defaultCwd || process.cwd()
        const resolved = resolveExistingFile(hostPath, cwdForUmo)
        if (!resolved || !isPathAllowedForSend(resolved, cwdForUmo)) {
          json(res, 400, { ok: false, error: '文件不存在、不在该会话工作区内，或属于敏感路径' })
          return
        }
        let size = 0
        try {
          size = statSync(resolved).size
        } catch (err) {
          json(res, 400, { ok: false, error: `读不到文件：${err.message}` })
          return
        }
        if (size > outboundUrlMaxMb * 1024 * 1024) {
          json(res, 413, { ok: false, error: `文件过大（${size} B > ${outboundUrlMaxMb} MB）` })
          return
        }
        const token = createFileToken(state.fileTokens, { path: resolved, name: basename(resolved), size })
        json(res, 200, { ok: true, token, name: basename(resolved), size })
        return
      }
      if (req.method === 'GET' && url.pathname.startsWith('/file/')) {
        if (bearerOf(req) !== state.token) {
          json(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        const entry = takeFileToken(state.fileTokens, decodeURIComponent(url.pathname.slice('/file/'.length)))
        if (!entry) {
          json(res, 404, { ok: false, error: '凭证无效或已过期' })
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': entry.size,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name || 'file')}`,
        })
        createReadStream(entry.path)
          .on('error', () => { try { res.end() } catch { /* ignore */ } })
          .pipe(res)
        return
      }
      if (req.method === 'POST' && url.pathname === '/inbound') {
        if (bearerOf(req) !== state.token) {
          json(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        const raw = await readBody(req)
        let body = {}
        try { body = raw ? JSON.parse(raw) : {} } catch {
          json(res, 400, { ok: false, error: 'invalid json' })
          return
        }
        await handleInbound(body, res)
        return
      }
      json(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      logger.error('request failed: %s', err?.message ?? err)
      if (!res.headersSent) json(res, 500, { ok: false, error: String(err?.message ?? err) })
      else {
        try {
          sseWrite(res, 'error', { message: String(err?.message ?? err) })
          sseWrite(res, 'done', {})
          res.end()
        } catch { /* ignore */ }
      }
    }
  })

  // 「信标」：把实际监听端口与 token 写到 ~/.dsh/astrbot-ingress.json（0600）。
  // 同机的 AstrBot 侧插件自动读它 → 不用再手填 ingress 地址与 token。
  // 容器里的 AstrBot 看不到这个文件（也没关系，那本来就要手填 host.docker.internal）。
  let beaconTimer = null

  async function writeBeacon() {
    if (config.beacon === false) return
    try {
      const payload = beaconPayload({
        port: server.address()?.port ?? port,
        token: state.token,
        version: pluginVersion(),
        host,
        cwd: defaultCwd,
      })
      await mkdir(dshHome(), { recursive: true })
      await writeFile(beaconPath(), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    } catch (err) {
      logger.warn?.('beacon write failed: %s', err?.message ?? err)
    }
  }

  /** 退出时收拾自己的信标；如果 pid 已经换人（另一个实例接管）就不动它。 */
  async function clearBeacon() {
    if (beaconTimer) {
      clearInterval(beaconTimer)
      beaconTimer = null
    }
    try {
      const mine = parseBeacon(await readFile(beaconPath(), 'utf8'))
      if (mine && Number(mine.pid) === process.pid) await rm(beaconPath(), { force: true })
    } catch { /* 没写过或已被删，都无所谓 */ }
  }

  server.listen(port, host, () => {
    const msg = `dsh-astrbot-ingress: listening on http://${host}:${port}`
    try { logger.info(msg) } catch { /* ignore */ }
    console.log(msg)
    init
      .then(async () => {
        await writeBeacon()
        if (config.beacon === false) return
        beaconTimer = setInterval(() => { writeBeacon() }, BEACON_REFRESH_MS)
        beaconTimer.unref?.()
        logger.info?.('beacon: %s', beaconPath())
      })
      .catch((err) => logger.warn?.('beacon init failed: %s', err?.message ?? err))
  })
  server.on('error', (err) => {
    logger.error('listen failed: %s', err?.message ?? err)
  })

  ctx.effect(() => async () => {
    for (const sessionId of [...state.heartbeats.keys()]) stopHeartbeat(sessionId)
    await clearBeacon()
    await new Promise((resolve) => server.close(() => resolve()))
  }, 'dsh-astrbot-ingress: stop HTTP server')
}

export default { name, inject, apply }
