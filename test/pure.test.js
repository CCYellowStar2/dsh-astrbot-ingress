// 纯函数单测：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  extractSendFiles,
  firstThinkingLine,
  formatElapsed,
  formatQuestions,
  isPathAllowedForSend,
  looksLikeBridgeCommand,
  parseQuestionReply,
  progressDigestLine,
  reasoningOfAssistantMessage,
  resolveExistingFile,
  splitForIm,
  stripInternalHints,
  summarizeToolCall,
  textOfAssistantMessage,
} from '../lib/pure.js'

test('looksLikeBridgeCommand: 命令词不被当成提问的回答', () => {
  // 有提问挂着时，这些必须还能当命令用（否则用户想停回合会被当成「回答：stop」）
  assert.equal(looksLikeBridgeCommand('stop'), true)
  assert.equal(looksLikeBridgeCommand('/stop'), true)
  assert.equal(looksLikeBridgeCommand('  STATUS '), true)
  assert.equal(looksLikeBridgeCommand('send D:\\dswk\\a.txt'), true)
  assert.equal(looksLikeBridgeCommand('model 3'), true)
  assert.equal(looksLikeBridgeCommand('perm read-only'), true)
  // 这些是正常回答，不能误判成命令
  assert.equal(looksLikeBridgeCommand('1,3'), false)
  assert.equal(looksLikeBridgeCommand('取消'), false)
  assert.equal(looksLikeBridgeCommand('答 stop'), false)
  assert.equal(looksLikeBridgeCommand('用第二种方案'), false)
  assert.equal(looksLikeBridgeCommand('stop 掉那个进程'), false) // 自由文本，不是命令写法
  assert.equal(looksLikeBridgeCommand(''), false)
})

test('formatQuestions / parseQuestionReply: 提问编号与回答解析', () => {
  const questions = [
    {
      id: 'q1',
      header: '部署',
      question: '怎么发？',
      options: [{ label: '被动', description: '先被动后主动' }, { label: '主动' }],
    },
    { id: 'q2', question: '要几份？', options: [{ label: '一份' }, { label: '三份' }], multiSelect: true },
  ]
  const { text, choices } = formatQuestions(7, questions, 600)
  assert.equal(choices.length, 4)
  assert.deepEqual(choices.map((c) => c.n), [1, 2, 3, 4])
  assert.equal(choices[3].id, 'q2')
  assert.ok(text.startsWith('❓ 需要你回答 (#7)'))
  assert.ok(text.includes('部署：怎么发？'))
  assert.ok(text.includes('  1. 被动 — 先被动后主动'))
  assert.ok(text.includes('（这题可多选）'))
  assert.ok(text.includes('等待 10 分钟，超时不会替你选'))

  // 编号回答：连号跨问题，按 question id 归组
  assert.deepEqual(parseQuestionReply(choices, '1,4'), {
    kind: 'answer',
    answers: [{ id: 'q1', selected: ['被动'] }, { id: 'q2', selected: ['三份'] }],
  })
  assert.deepEqual(parseQuestionReply(choices, '2 3'), {
    kind: 'answer',
    answers: [{ id: 'q1', selected: ['主动'] }, { id: 'q2', selected: ['一份'] }],
  })
  assert.deepEqual(parseQuestionReply(choices, '取消'), { kind: 'cancel' })
  assert.deepEqual(parseQuestionReply(choices, '答 都用主动'), { kind: 'answer', custom: '都用主动' })
  assert.deepEqual(parseQuestionReply(choices, 'answer: 都用主动'), { kind: 'answer', custom: '都用主动' })
  // 没选项的题：任何话都算自定义回答
  assert.deepEqual(parseQuestionReply([], '随便写点什么'), { kind: 'answer', custom: '随便写点什么' })
  // 编号一个都对不上：宁可不认，也别把「9」当自定义回答喂给模型
  assert.equal(parseQuestionReply(choices, '9'), null)
  assert.equal(parseQuestionReply(choices, '  '), null)
})

test('formatQuestions: 过长的 detail 截断并提示', () => {
  const { text } = formatQuestions(1, [{ id: 'p', question: '看这个计划', detail: 'x'.repeat(3000) }], 60)
  assert.ok(text.includes('内容太长已截断，完整版见 DSH 网页'))
  assert.ok(text.length < 1500)
  assert.ok(text.includes('等待 1 分钟'))
})

test('formatElapsed: 不足一分钟按秒，超过按分钟且不为 0', () => {
  assert.equal(formatElapsed(12_000), '12 秒')
  assert.equal(formatElapsed(59_400), '59 秒')
  assert.equal(formatElapsed(60_000), '1 分钟')
  assert.equal(formatElapsed(179_000), '3 分钟')
  assert.equal(formatElapsed(0), '1 秒')
  assert.equal(formatElapsed(NaN), '1 秒')
})

test('progressDigestLine: 工具统计、最近三个、无工具时报思考首行', () => {
  assert.equal(
    progressDigestLine({ elapsedMs: 180_000, tools: 7, recent: ['edit', 'bash'] }),
    '⏳ 已跑 3 分钟 · 工具 7 次 · 最近：edit · bash',
  )
  // 只留最近三个，且思考首行要瘦身
  assert.equal(
    progressDigestLine({ elapsedMs: 45_000, tools: 9, recent: ['a', 'b', 'c', 'd'] }),
    '⏳ 已跑 45 秒 · 工具 9 次 · 最近：b · c · d',
  )
  assert.equal(
    progressDigestLine({ elapsedMs: 120_000, tools: 0, lastThinking: '## 先复现\n再说' }),
    '⏳ 已跑 2 分钟 · 仍在思考：先复现',
  )
  assert.equal(progressDigestLine({ elapsedMs: 5_000 }), '⏳ 已跑 5 秒 · 正在执行')
  // 关掉工具展示（showToolCalls=false）时不能泄漏工具名
  assert.equal(
    progressDigestLine({ elapsedMs: 60_000, tools: 3, recent: ['bash npm test'], showTools: false }),
    '⏳ 已跑 1 分钟 · 正在执行',
  )
})

test('splitForIm: 短文本原样返回，空文本返回空数组', () => {
  assert.deepEqual(splitForIm('hello', 100), ['hello'])
  assert.deepEqual(splitForIm('   ', 100), [])
  assert.deepEqual(splitForIm('', 100), [])
})

test('splitForIm: 超长文本按上限切分且不丢内容', () => {
  const text = Array.from({ length: 20 }, (_, i) => `第 ${i} 行内容`).join('\n')
  const chunks = splitForIm(text, 30)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.length <= 30, `chunk too long: ${chunk.length}`)
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''))
})

test('textOfAssistantMessage: reasoning 块不算正文', () => {
  const message = {
    content: [
      { type: 'reasoning', text: '用户想让我改代码' },
      { type: 'text', text: '已经改好了。' },
    ],
  }
  assert.equal(textOfAssistantMessage(message), '已经改好了。')
  assert.equal(reasoningOfAssistantMessage(message), '用户想让我改代码')
})

test('firstThinkingLine: 取第一行、去 markdown 行首、超长截断', () => {
  assert.equal(firstThinkingLine('## 先看报错\n再决定'), '先看报错')
  assert.equal(firstThinkingLine('\n\n   \n第二行才是内容'), '第二行才是内容')
  assert.equal(firstThinkingLine(''), '')
  const long = firstThinkingLine('x'.repeat(200))
  assert.equal(long.length, 121) // 120 + 省略号
  assert.ok(long.endsWith('…'))
})

test('summarizeToolCall: 优先 command/path，非法 JSON 退化截断', () => {
  assert.equal(summarizeToolCall('bash', JSON.stringify({ command: 'npm   test' })), 'npm test')
  assert.equal(summarizeToolCall('read', JSON.stringify({ file_path: 'D:\\a\\b.js' })), 'D:\\a\\b.js')
  assert.equal(summarizeToolCall('bash', 'not json'), 'not json')
  assert.equal(summarizeToolCall('bash', JSON.stringify({ command: 'x'.repeat(300) })).length, 101)
  assert.equal(summarizeToolCall('bash', JSON.stringify({ count: 3 })), '')
})

test('stripInternalHints: 抹掉泄漏的协议原文与 HTML 注释', () => {
  assert.equal(stripInternalHints('正文\n<!-- [dsh-astrbot-ingress] 注入 -->'), '正文')
  assert.equal(
    stripInternalHints('正文\nQQ 出站：用户要文件时…不要复述本协议。'),
    '正文',
  )
  assert.equal(
    stripInternalHints('正文\n当前通道是 QQ（AstrBot）。写 [SEND_FILE]…不要向用户复述这条协议。'),
    '正文',
  )
  assert.equal(stripInternalHints('正常回复'), '正常回复')
})

test('resolveExistingFile / isPathAllowedForSend: 工作区内外与敏感路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pure-'))
  const inside = join(root, 'ok.txt')
  writeFileSync(inside, 'hi')
  mkdirSync(join(root, '.ssh'), { recursive: true })
  const secret = join(root, '.ssh', 'id_rsa')
  writeFileSync(secret, 'k')
  const outside = join(tmpdir(), 'outside-dsh-pure.txt')
  writeFileSync(outside, 'x')

  assert.equal(resolveExistingFile('ok.txt', root), inside)
  assert.equal(resolveExistingFile('nope.txt', root), null)
  assert.equal(resolveExistingFile('https://example.com/a.txt', root), null)

  assert.equal(isPathAllowedForSend(inside, root), true)
  assert.equal(isPathAllowedForSend(secret, root), false) // 敏感目录段
  assert.equal(isPathAllowedForSend(outside, root), false) // 越界
  assert.equal(isPathAllowedForSend(inside, undefined), false)
})

test('extractSendFiles: 抽出指令、剥离该行、忽略不存在与 URL', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-send-'))
  const file = join(root, 'out.txt')
  writeFileSync(file, 'x')

  const withOne = extractSendFiles(`给你文件\n[SEND_FILE: ${file}]\n完`, root)
  assert.deepEqual(withOne.files, [file])
  assert.equal(withOne.cleanText, '给你文件\n\n完')

  const relative = extractSendFiles('[SEND_FILE: out.txt]', root)
  assert.deepEqual(relative.files, [file])

  const missing = extractSendFiles('[SEND_FILE: ghost.txt]', root)
  assert.deepEqual(missing.files, [])
  assert.equal(missing.cleanText, '')

  const url = extractSendFiles('[SEND_FILE: https://example.com/a.txt]', root)
  assert.deepEqual(url.files, [])

  assert.deepEqual(extractSendFiles('', root), { cleanText: '', files: [] })
})
