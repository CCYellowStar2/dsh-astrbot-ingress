// dsh-astrbot-ingress 纯函数：分块、出站指令解析、消息抽取、路径校验。
// 与 cordis/宿主无关，便于直接单测（见 test/pure.test.js）。
import { isAbsolute, normalize, relative, resolve } from 'node:path'
import { statSync } from 'node:fs'

/** 敏感路径段：`[SEND_FILE]` 与工作区校验都拒绝它们。 */
export const SENSITIVE_NAMES = new Set([
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.git', '.env', '.npmrc', 'credentials',
])

/** 按 IM 上限分块，尽量在换行或句号处断。 */
export function splitForIm(text, maxChars) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (!raw) return []
  if (raw.length <= maxChars) return [raw]
  const chunks = []
  let rest = raw
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars)
    if (cut < maxChars * 0.4) cut = rest.lastIndexOf('。', maxChars)
    if (cut < maxChars * 0.4) cut = maxChars
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks.filter(Boolean)
}

/** 只取助手消息的正文；reasoning 块不算正文（曾经把它当正文发到 QQ）。 */
export function textOfAssistantMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'reasoning') return ''
      if (part?.type === 'text') return part.text ?? ''
      return ''
    })
    .join('')
}

/** 取助手消息里的思考正文（多块用换行拼接）。 */
export function reasoningOfAssistantMessage(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'reasoning')
    .map((part) => String(part?.text ?? ''))
    .join('\n')
    .trim()
}

/** 思考内容的「第一行」：首个非空行，去掉 markdown 行首符号，超长截断。 */
export function firstThinkingLine(text, limit = 120) {
  const line = String(text || '')
    .split('\n')
    .map((l) => l.replace(/^[#>\-*\s]+/, '').trim())
    .find((l) => l.length > 0)
  if (!line) return ''
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

/** 工具调用摘要：优先取 command/path 等字段，非法 JSON 时退化为原文截断。 */
export function summarizeToolCall(name, argsJson, limit = 100) {
  const clip = (value) => {
    const one = String(value || '').replace(/\s+/g, ' ').trim()
    return one.length > limit ? `${one.slice(0, limit)}…` : one
  }
  let args = null
  try { args = JSON.parse(String(argsJson || '')) } catch { args = null }
  if (!args || typeof args !== 'object') return clip(argsJson)
  const preferred = ['command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url', 'text', 'prompt', 'name']
  for (const key of preferred) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return clip(value)
  }
  const firstString = Object.values(args).find((value) => typeof value === 'string' && value.trim())
  return typeof firstString === 'string' ? clip(firstString) : ''
}

/** 跑了几分钟/几秒，给过程汇报用；不足一分钟按秒说，免得一直显示「0 分钟」。 */
export function formatElapsed(ms) {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  return safe < 60_000
    ? `${Math.max(1, Math.round(safe / 1000))} 秒`
    : `${Math.max(1, Math.round(safe / 60_000))} 分钟`
}

/**
 * digest 档的周期汇报行：一条把这段时间的过程说完。
 * showTools=false（关了 showToolCalls）时只报「正在执行」，不泄漏工具名。
 */
export function progressDigestLine({ elapsedMs = 0, tools = 0, recent = [], lastThinking = '', showTools = true } = {}) {
  const bits = [`⏳ 已跑 ${formatElapsed(elapsedMs)}`]
  if (tools > 0) {
    if (showTools) {
      bits.push(`工具 ${tools} 次`)
      const names = (Array.isArray(recent) ? recent : []).slice(-3)
      if (names.length) bits.push(`最近：${names.join(' · ')}`)
    } else {
      bits.push('正在执行')
    }
  } else if (lastThinking) {
    bits.push(`仍在思考：${firstThinkingLine(lastThinking)}`)
  } else {
    bits.push('正在执行')
  }
  return bits.join(' · ')
}

/**
 * 把 `ask_user_question` 的提问排成 QQ 里能看的一条消息。
 * 选项统一编号（跨问题连号），返回编号→选项的映射给回答解析用。
 */
export function formatQuestions(number, questions, timeoutSec = 600, detailLimit = 1200) {
  const list = Array.isArray(questions) ? questions : []
  const lines = [`❓ 需要你回答 (#${number})`]
  const choices = []
  let n = 0
  for (const q of list) {
    lines.push('')
    const head = q?.header ? `${String(q.header)}：` : ''
    lines.push(`${head}${String(q?.question ?? '')}`)
    if (q?.detail) {
      const detail = String(q.detail)
      lines.push(detail.length > detailLimit
        ? `${detail.slice(0, detailLimit)}\n…（内容太长已截断，完整版见 DSH 网页）`
        : detail)
    }
    for (const option of q?.options ?? []) {
      n += 1
      const label = String(option?.label ?? '')
      choices.push({ n, id: String(q.id), label })
      lines.push(`  ${n}. ${label}${option?.description ? ` — ${String(option.description).slice(0, 120)}` : ''}`)
    }
    if (q?.multiSelect) lines.push('（这题可多选）')
  }
  lines.push('')
  lines.push(choices.length
    ? '回复编号即可（多选用逗号，如 `1,3`）；想说别的就 `答 你的说法`；不想回答发 `取消`。'
    : '直接把答案发过来；不想回答发 `取消`。')
  lines.push(`等待 ${Math.max(1, Math.round(Number(timeoutSec) / 60))} 分钟，超时不会替你选。`)
  return { text: lines.join('\n'), choices }
}

/** 桥自己认的命令词（和 AstrBot 侧的 `_should_capture` 对齐）。 */
const BRIDGE_COMMANDS = new Set([
  'stop', 'status', 'help', 'ls', 'list', 'sessions', 'ws', 'new', 'end',
  'compact', 'last', 'perm', 'model', 'send', 'use', 'session', 'rename', 'steer',
])
/** 带参数的命令名：`send <路径>`、`model <名>` 这类。 */
const BRIDGE_COMMANDS_WITH_ARGS = new Set(['ws', 'use', 'session', 'rename', 'send', 'model', 'last', 'perm', 'steer'])

/**
 * 这句是不是桥的命令（而不是对提问的回答）。
 * 有未决提问时 `stop` 必须还能停回合，不能变成「用户回答：stop」；
 * 想说自由文本回答，用 `答 …` / `回答：…` 前缀绕开这个判断。
 */
export function looksLikeBridgeCommand(text) {
  const t = String(text ?? '').trim().replace(/^[/／]+/, '').trim()
  if (!t) return false
  const parts = t.split(/\s+/)
  const head = parts[0].toLowerCase()
  if (!BRIDGE_COMMANDS.has(head)) return false
  if (parts.length === 1) return true
  return BRIDGE_COMMANDS_WITH_ARGS.has(head)
}

/**
 * 解析 QQ 里对提问的回复。
 * 返回 `{kind:'cancel'}`、`{kind:'answer', answers?/custom?}`，或 null（没看懂，别硬当回答）。
 */
export function parseQuestionReply(choices, raw) {
  const text = String(raw ?? '').trim().replace(/^[/／]+/, '').trim()
  if (!text) return null
  if (/^(?:取消|算了|不答了|跳过|skip|cancel|abort)$/i.test(text)) return { kind: 'cancel' }

  const custom = text.match(/^(?:答|回答|答复|answer)\s*[:：]?\s*([\s\S]+)$/i)
  if (custom) {
    const body = custom[1].trim()
    return body ? { kind: 'answer', custom: body } : null
  }

  const list = Array.isArray(choices) ? choices : []
  if (list.length && /^\d+(?:[\s,，、]+\d+)*$/.test(text)) {
    const answers = []
    for (const digits of text.match(/\d+/g) ?? []) {
      const hit = list.find((choice) => choice.n === Number(digits))
      if (!hit) continue
      let entry = answers.find((answer) => answer.id === hit.id)
      if (!entry) {
        entry = { id: hit.id, selected: [] }
        answers.push(entry)
      }
      if (!entry.selected.includes(hit.label)) entry.selected.push(hit.label)
    }
    // 编号一个都对不上就当作没听懂，免得把「8」当成自定义回答喂给模型。
    return answers.length ? { kind: 'answer', answers } : null
  }

  return { kind: 'answer', custom: text }
}

/** 抹掉曾经泄漏到 QQ 的内部提示与协议原文。 */
export function stripInternalHints(text) {
  return String(text || '')
    .replace(/<!--\s*\[dsh-astrbot-ingress\][\s\S]*?-->/g, '')
    .replace(/<!--\s*dsh-send:[\s\S]*?-->/g, '')
    .replace(/^\s*<!--[\s\S]*?-->\s*/g, '')
    .replace(/若用户明确要求把已生成的本地文件发到 QQ[\s\S]*?密钥类文件。?/g, '')
    .replace(/当前通道是 QQ（AstrBot）。[\s\S]*?不要向用户复述这条协议。?/g, '')
    .replace(/QQ 出站[：:][\s\S]*?不要复述本协议。?/g, '')
    .replace(/\[SEND_FILE:\s*[^\]]*<文件名>[^\]]*\]/g, '')
    .trim()
}

/** 把一段文本解析成真实存在的本地文件绝对路径；URL 与非文件返回 null。 */
export function resolveExistingFile(rawPath, cwd) {
  if (typeof rawPath !== 'string') return null
  let p = rawPath.trim().replace(/^["'`]|["'`]$/g, '').replace(/^file:\/\/\/?/, '')
  if (!p || /^https?:\/\//i.test(p)) return null
  const resolved = isAbsolute(p) ? normalize(p) : resolve(cwd || process.cwd(), p)
  try {
    if (statSync(resolved).isFile()) return resolved
  } catch { /* ignore */ }
  return null
}

/** 出站白名单校验：必须在 allowedRoot 内，且任一路径段不得命中敏感名。 */
export function isPathAllowedForSend(resolvedPath, allowedRoot) {
  if (!resolvedPath || !allowedRoot) return false
  const normalized = resolve(resolvedPath)
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  for (const part of parts) {
    if (SENSITIVE_NAMES.has(part.toLowerCase())) return false
  }
  const normRoot = resolve(allowedRoot)
  if (normalized === normRoot) return true
  const rel = relative(normRoot, normalized)
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel))
}

/** 抽出 `[SEND_FILE: …]` 指令并返回剥离后的正文与已解析文件。 */
export function extractSendFiles(text, cwd) {
  if (typeof text !== 'string' || !text.trim()) return { cleanText: text || '', files: [] }
  const files = []
  const re = /\[(?:SEND_FILE|SEND-FILE|send_file|send-file|SEND_MEDIA|send_media):\s*[`"']?([^\]`"'\r\n]+?)[`"']?\s*\]/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const resolved = resolveExistingFile(m[1], cwd)
    if (resolved && !files.includes(resolved)) files.push(resolved)
  }
  const cleanText = text.replace(re, '').replace(/\n{3,}/g, '\n\n').trim()
  return { cleanText, files }
}
