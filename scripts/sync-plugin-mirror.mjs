// 把 astrbot_plugin_dsh/ 镜像到「插件独立仓库」。
//
//   node scripts/sync-plugin-mirror.mjs <目标仓库目录> [--dry-run]
//
// 只同步下面这份白名单（源码 + 元数据 + 文档 + LICENSE），不会删目标里的其它文件
// （那边通常还有 .git / .github）。故意写成 Node 而不是 .ps1：
// PowerShell 5.1 会把无 BOM 的 .ps1 按 ANSI 读，中文注释会烂掉。
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
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
if (!dryRun && existsSync(join(target, '.git'))) {
  console.log('提示：README 里的相互链接（指向 ingress 仓库的地址）要改成绝对 URL。')
}
void readdirSync
