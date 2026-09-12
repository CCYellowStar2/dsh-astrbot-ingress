// 入站 URL 下载的单测：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { downloadUrlToFile, isHttpUrl } from '../lib/fetchfile.js'

function serve(routes) {
  const server = createServer((req, res) => {
    const handler = routes[req.url]
    if (!handler) {
      res.writeHead(404)
      res.end('nope')
      return
    }
    handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('isHttpUrl: 只认 http(s)', () => {
  assert.equal(isHttpUrl('http://127.0.0.1:1/a'), true)
  assert.equal(isHttpUrl('https://example.com/a?b=c'), true)
  assert.equal(isHttpUrl('  https://example.com/a  '), true)
  assert.equal(isHttpUrl('file:///etc/passwd'), false)
  assert.equal(isHttpUrl('data:text/plain,hi'), false)
  assert.equal(isHttpUrl('ftp://example.com/a'), false)
  assert.equal(isHttpUrl(''), false)
  assert.equal(isHttpUrl(null), false)
})

test('downloadUrlToFile: 正常下载、超限、404、超时、非 http 都要对', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fetch-'))
  const { server, port } = await serve({
    '/ok.bin': (req, res) => {
      res.writeHead(200, { 'content-length': '1024' })
      res.end(Buffer.alloc(1024, 7))
    },
    '/big.bin': (req, res) => {
      res.writeHead(200)
      res.end(Buffer.alloc(4096, 1))
    },
    '/slow.bin': (req, res) => {
      setTimeout(() => {
        try { res.end('late') } catch { /* 客户端已断开 */ }
      }, 800)
    },
  })
  const base = `http://127.0.0.1:${port}`
  try {
    const dest = join(dir, 'ok.bin')
    const { bytes } = await downloadUrlToFile(`${base}/ok.bin`, dest, { maxBytes: 2048 })
    assert.equal(bytes, 1024)
    assert.equal(readFileSync(dest).length, 1024)

    const big = join(dir, 'big.bin')
    await assert.rejects(
      () => downloadUrlToFile(`${base}/big.bin`, big, { maxBytes: 1000 }),
      /超过上限/,
    )
    assert.equal(existsSync(big), false, '超限时必须删掉半截文件')

    await assert.rejects(
      () => downloadUrlToFile(`${base}/nope.bin`, join(dir, 'x.bin')),
      /HTTP 404/,
    )
    assert.equal(existsSync(join(dir, 'x.bin')), false)

    await assert.rejects(
      () => downloadUrlToFile(`${base}/slow.bin`, join(dir, 'slow.bin'), { timeoutMs: 150 }),
      /超时|abort/i,
    )
    assert.equal(existsSync(join(dir, 'slow.bin')), false)

    await assert.rejects(() => downloadUrlToFile('file:///etc/hosts', join(dir, 'y.bin')), /http/)
    await assert.rejects(
      () => downloadUrlToFile(`${base}/ok.bin`, join(dir, 'z.bin'), { fetchImpl: null }),
      /fetch/,
    )
  } finally {
    server.close()
  }
})
