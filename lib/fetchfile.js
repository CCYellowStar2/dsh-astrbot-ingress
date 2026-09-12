// 入站附件的 URL 下载：流式落盘 + 体积上限 + 超时。
// 与 cordis / 宿主无关，可单测（见 test/fetchfile.test.js）。
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 只接受 http(s)：其它协议（`file:` / `data:` 等）一律拒绝。 */
export function isHttpUrl(value) {
  const text = String(value ?? '').trim()
  if (!text) return false
  try {
    const parsed = new URL(text)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 把 URL 流式下载到 dest。
 * - 边下边计数：超过 `maxBytes` 立刻中断并删掉半截文件；
 * - `timeoutMs` 到点就 abort；
 * - 任何失败都清掉 dest，不留垃圾。
 */
export async function downloadUrlToFile(url, dest, options = {}) {
  const {
    maxBytes = 200 * 1024 * 1024,
    timeoutMs = 60_000,
    fetchImpl = globalThis.fetch,
  } = options
  if (!isHttpUrl(url)) throw new Error('只支持 http/https 链接')
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时没有 fetch')

  await mkdir(dirname(dest), { recursive: true })
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`下载超时（${timeoutMs}ms）`)), timeoutMs)
  let written = 0
  try {
    const res = await fetchImpl(url, { signal: ac.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const declared = Number(res.headers?.get?.('content-length') || 0)
    if (declared > maxBytes) throw new Error(`超过上限（${declared} > ${maxBytes} 字节）`)
    if (!res.body) throw new Error('响应没有 body')
    const body = Readable.fromWeb(res.body)
    body.on('data', (chunk) => {
      written += chunk.length
      if (written > maxBytes) body.destroy(new Error(`超过上限（>${maxBytes} 字节）`))
    })
    await pipeline(body, createWriteStream(dest))
    return { bytes: written }
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {})
    throw err
  } finally {
    clearTimeout(timer)
  }
}
