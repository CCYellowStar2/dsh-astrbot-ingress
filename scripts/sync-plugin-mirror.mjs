// 把 astrbot_plugin_dsh/ 镜像到「插件独立仓库」。
//
//   node scripts/sync-plugin-mirror.mjs <目标仓库目录> [--dry-run]
//
// 只同步下面这份白名单（源码 + 元数据 + 文档 + LICENSE），不会删目标里的其它文件
// （那边通常还有 .git / .github）。故意写成 Node 而不是 .ps1：
// PowerShell 5.1 会把无 BOM 的 .ps1 按 ANSI 读，中文注释会烂掉。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FILES = ['main.py', '_conf_schema.json', 'metadata.yaml', 'README.md']
const EXTRA_FROM_ROOT = ['LICENSE', 'CHANGELOG.md']

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const srcDir = join(repoRoot, 'astrbot_plugin_dsh')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const targetArg = args.find((a) => !a.startsWith('--'))
if (!targetArg) {
  console.error('用法: node scripts/sync-plugin-mirror.mjs <目标仓库目录> [--dry-run]')
  process.exit(1)
}
const target = resolve(targetArg)

if (!existsSync(srcDir)) {
  console.error(`源目录不存在: ${srcDir}`)
  process.exit(1)
}
if (!existsSync(target)) {
  console.error(`目标目录不存在（先 git clone 空仓库再跑）: ${target}`)
  process.exit(1)
}
// 防手滑：别把仓库里的这份覆盖回 AstrBot 实际加载的插件目录
if (existsSync(join(target, 'main.py')) && existsSync(join(target, '.git')) === false) {
  console.error('目标目录里已有 main.py 但不像 git 仓库，拒绝覆盖。确认路径后手动处理。')
  process.exit(1)
}

const plan = []
// 记下目标仓库 CHANGELOG 原有的行尾（Windows 上通常是 CRLF）：
// 覆盖后再按原样写回，避免"内容没变、git 却报 M"的噪音（2026-11-22 踩到）。
const changelogTarget = join(target, 'CHANGELOG.md')
let priorChangelogCrlf = false
try {
  if (existsSync(changelogTarget)) priorChangelogCrlf = /\r\n/.test(readFileSync(changelogTarget, 'utf8'))
} catch { /* ignore */ }
for (const name of FILES) {
  const from = join(srcDir, name)
  if (!existsSync(from)) {
    console.error(`缺少源文件: ${from}`)
    process.exit(1)
  }
  plan.push([from, join(target, name)])
}
for (const name of EXTRA_FROM_ROOT) {
  const from = join(repoRoot, name)
  if (existsSync(from)) plan.push([from, join(target, name)])
}

let copied = 0
for (const [from, to] of plan) {
  const size = statSync(from).size
  console.log(`${dryRun ? '[dry-run] ' : ''}${from.replace(repoRoot + '\\', '')}  ->  ${to}  (${size} 字节)`)
  if (!dryRun) {
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    copied += 1
  }
}
console.log(dryRun ? '\n只是预演，没有写文件。' : `\n已同步 ${copied} 个文件。目标仓库里 git add/commit/push 即可。`)
if (!dryRun) trimMirrorChangelog()
if (!dryRun && existsSync(join(target, '.git'))) {
  console.log('提示：README 里的相互链接（指向 ingress 仓库的地址）要改成绝对 URL。')
}
void readdirSync

// ---------------------------------------------------------------------------
// 镜像仓库的 CHANGELOG 只保留到「插件自己的版本」为止。
//
// 为什么需要：两侧版本号已经解耦（DSH 侧走 0.3.x，AstrBot 侧从 0.4.0 起）。根 CHANGELOG 里会
// 出现「只有 DSH 侧才改」的版本小节；原样拷进镜像仓库，会让市场里显示的更新日志出现
// **比插件版本还新**的条目 —— 审核员和用户都会困惑（2026-11-22 踩到）。
// ---------------------------------------------------------------------------
function pluginVersion() {
  try {
    const text = readFileSync(join(srcDir, 'metadata.yaml'), 'utf8')
    const m = text.match(/^version:\s*(\S+)\s*$/m)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

function verParts(v) {
  return String(v).split('.').map((x) => Number(String(x).replace(/\D.*$/, '')) || 0)
}

function verCmp(a, b) {
  const pa = verParts(a)
  const pb = verParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

/** 丢掉版本号大于 maxVersion 的小节（`## x.y.z` 起，到下一个 `## ` 为止）。 */
function trimChangelog(text, maxVersion) {
  const head = []
  const sections = []
  let cur = null
  for (const line of text.split('\n')) {
    const m = line.match(/^##\s+v?(\d+\.\d+\.\d+)/)
    if (m) {
      cur = { version: m[1], lines: [line] }
      sections.push(cur)
      continue
    }
    if (cur) cur.lines.push(line)
    else head.push(line)
  }
  const kept = sections.filter((s) => verCmp(s.version, maxVersion) <= 0)
  const dropped = sections.length - kept.length
  const out = [...head, ...kept.flatMap((s) => s.lines)].join('\n').replace(/\n+$/, '\n')
  return { text: out, dropped }
}

function trimMirrorChangelog() {
  const targetFile = join(target, 'CHANGELOG.md')
  const maxVersion = pluginVersion()
  if (!maxVersion || !existsSync(targetFile)) return
  try {
    const before = readFileSync(targetFile, 'utf8')
    const { text: after, dropped } = trimChangelog(before, maxVersion)
    // 只在**内容**真的变了才写回：镜像仓库那份可能是 CRLF，无条件重写会平白产生
    // stat 变化（git status 显示 M 但 diff 为空），也容易误提交。
    const normalizedBefore = before.replace(/\r\n/g, '\n').replace(/\n+$/, '\n')
    if (after === normalizedBefore) {
      // 内容没变：但副本可能刚从 LF 覆盖过来，行尾得还原成目标仓库原来的样子
      if (priorChangelogCrlf && !/\r\n/.test(before)) writeFileSync(targetFile, after.replace(/\n/g, '\r\n'))
      return
    }
    const payload = priorChangelogCrlf ? after.replace(/\n/g, '\r\n') : after
    writeFileSync(targetFile, payload)
    console.log(`CHANGELOG.md 已裁到插件版本 ${maxVersion}（去掉 ${dropped} 个更新的 DSH 侧小节）`)
  } catch (err) {
    console.warn(`裁剪 CHANGELOG 失败（不影响同步）: ${err?.message ?? err}`)
  }
}
