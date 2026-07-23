import cors from 'cors'
import express from 'express'
import Redis from 'ioredis'

const app = express()
const PORT = 3789
const EXPORT_FORMAT = 'redis-desk'
const EXPORT_VERSION = 1
const MAX_EXPORT_KEYS = 10000

app.use(cors())
app.use(express.json({ limit: '64mb' }))

let redis: Redis | null = null
let lastError: string | null = null
let currentDb = Number(process.env.REDIS_DB || 0) || 0

type ExportedKey = {
  key: string
  type: string
  ttl: number
  value: unknown
}

function normalizeDb(value: unknown, _fallback = 0) {
  const db = Number(value)
  if (!Number.isInteger(db) || db < 0 || db > 15) {
    throw new Error('REDIS_DB 需为 0–15 的整数')
  }
  return db
}

function createClient(
  host = '127.0.0.1',
  port = 6379,
  password?: string,
  db = currentDb,
) {
  if (redis) {
    redis.disconnect()
  }

  lastError = null
  currentDb = db
  redis = new Redis({
    host,
    port,
    db,
    password: password || undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  })

  redis.on('error', (err) => {
    lastError = err.message
  })

  return redis
}

async function ensureConnected() {
  if (!redis) {
    createClient()
  }
  if (!redis) {
    throw new Error('Redis 客户端未初始化')
  }
  if (redis.status !== 'ready') {
    await redis.connect()
  }
  return redis
}

async function scanKeys(client: Redis, pattern: string, limit = MAX_EXPORT_KEYS) {
  const keys: string[] = []
  let cursor = '0'
  let truncated = false

  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
    cursor = next
    for (const key of batch) {
      if (keys.length >= limit) {
        truncated = true
        break
      }
      keys.push(key)
    }
    if (truncated) break
  } while (cursor !== '0')

  keys.sort((a, b) => a.localeCompare(b))
  return { keys, truncated }
}

async function dumpKey(client: Redis, key: string): Promise<ExportedKey | null> {
  const [type, ttl] = await Promise.all([client.type(key), client.ttl(key)])
  if (type === 'none') return null

  let value: unknown

  switch (type) {
    case 'string':
      value = await client.get(key)
      break
    case 'hash':
      value = await client.hgetall(key)
      break
    case 'list':
      value = await client.lrange(key, 0, -1)
      break
    case 'set':
      value = await client.smembers(key)
      break
    case 'zset': {
      const raw = await client.zrange(key, 0, -1, 'WITHSCORES')
      const pairs: { member: string; score: string }[] = []
      for (let i = 0; i < raw.length; i += 2) {
        pairs.push({ member: raw[i], score: raw[i + 1] })
      }
      value = pairs
      break
    }
    case 'stream': {
      const entries = await client.xrange(key, '-', '+', 'COUNT', 1000)
      value = entries.map(([id, fields]) => {
        const obj: Record<string, string> = {}
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1]
        }
        return { id, fields: obj }
      })
      break
    }
    default:
      value = null
  }

  return { key, type, ttl, value }
}

async function restoreKey(client: Redis, item: ExportedKey) {
  const { key, type, ttl, value } = item
  if (!key || !type) {
    throw new Error('导入项缺少 key 或 type')
  }

  await client.del(key)

  switch (type) {
    case 'string': {
      let text = ''
      if (value == null) text = ''
      else if (typeof value === 'string') text = value
      else text = JSON.stringify(value)
      await client.set(key, text)
      break
    }
    case 'hash': {
      const fields = value as Record<string, string>
      const entries = Object.entries(fields || {}).map(([k, v]) => [
        k,
        typeof v === 'string' ? v : JSON.stringify(v),
      ])
      if (entries.length > 0) {
        // Redis 3.x 兼容：用 hmset
        await client.hmset(key, ...entries.flat())
      }
      break
    }
    case 'list': {
      const items = Array.isArray(value)
        ? value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
        : []
      if (items.length > 0) {
        await client.rpush(key, ...items)
      }
      break
    }
    case 'set': {
      const members = Array.isArray(value)
        ? value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
        : []
      if (members.length > 0) {
        await client.sadd(key, ...members)
      }
      break
    }
    case 'zset': {
      const pairs = Array.isArray(value) ? value : []
      const args: string[] = []
      for (const pair of pairs) {
        if (pair && typeof pair === 'object') {
          const row = pair as { member?: string; score?: string | number }
          if (row.member != null && row.score != null) {
            args.push(String(row.score), String(row.member))
          }
        }
      }
      if (args.length > 0) {
        await client.zadd(key, ...args)
      }
      break
    }
    case 'stream': {
      const entries = Array.isArray(value) ? value : []
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue
        const row = entry as { id?: string; fields?: Record<string, string> }
        const fields = row.fields || {}
        const flat = Object.entries(fields).flat()
        if (flat.length === 0) continue
        await client.xadd(key, row.id || '*', ...flat)
      }
      break
    }
    default:
      throw new Error(`暂不支持写入类型: ${type}（${key}）`)
  }

  if (typeof ttl === 'number' && ttl > 0) {
    await client.expire(key, ttl)
  } else {
    await client.persist(key)
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/connect', async (req, res) => {
  try {
    const host = String(req.body.host || '127.0.0.1')
    const port = Number(req.body.port || 6379)
    const password = req.body.password ? String(req.body.password) : undefined
    const db = normalizeDb(req.body.db ?? currentDb, currentDb)

    const client = createClient(host, port, password, db)
    await client.connect()
    const pong = await client.ping()

    res.json({
      ok: true,
      pong,
      host,
      port,
      db,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    lastError = message
    res.status(500).json({ ok: false, error: message })
  }
})

app.post('/api/select', async (req, res) => {
  try {
    const db = normalizeDb(req.body.db)
    const client = await ensureConnected()
    await client.select(db)
    currentDb = db

    res.json({
      ok: true,
      db,
      dbsize: await client.dbsize(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: message })
  }
})

app.get('/api/info', async (_req, res) => {
  try {
    const client = await ensureConnected()
    const [dbsize, info] = await Promise.all([client.dbsize(), client.info('server')])
    const version = info.match(/redis_version:(.+)/)?.[1]?.trim() ?? 'unknown'

    res.json({
      ok: true,
      db: currentDb,
      dbsize,
      version,
      status: client.status,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({
      ok: false,
      error: message,
      lastError,
    })
  }
})

app.get('/api/keys', async (req, res) => {
  try {
    const client = await ensureConnected()
    const pattern = String(req.query.pattern || '*')
    const { keys, truncated } = await scanKeys(client, pattern, 2000)

    const typed = await Promise.all(
      keys.map(async (key) => {
        const [type, ttl] = await Promise.all([client.type(key), client.ttl(key)])
        return { key, type, ttl }
      }),
    )

    res.json({ keys: typed, truncated })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.get('/api/key', async (req, res) => {
  try {
    const client = await ensureConnected()
    const key = String(req.query.name || '')
    if (!key) {
      res.status(400).json({ error: '缺少 key 参数' })
      return
    }

    const dumped = await dumpKey(client, key)
    if (!dumped) {
      res.status(404).json({ error: 'Key 不存在' })
      return
    }

    res.json(dumped)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.delete('/api/key', async (req, res) => {
  try {
    const client = await ensureConnected()
    const key = String(req.query.name || req.body?.name || '')
    if (!key) {
      res.status(400).json({ error: '缺少 key 参数' })
      return
    }

    const removed = await client.del(key)
    if (removed === 0) {
      res.status(404).json({ error: 'Key 不存在或已删除' })
      return
    }

    res.json({
      ok: true,
      key,
      removed,
      dbsize: await client.dbsize(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.put('/api/key', async (req, res) => {
  try {
    const client = await ensureConnected()
    const key = String(req.body.key || '')
    const type = String(req.body.type || '')
    const ttl = req.body.ttl == null ? -1 : Number(req.body.ttl)
    const value = req.body.value

    if (!key) {
      res.status(400).json({ error: '缺少 key' })
      return
    }
    if (!['string', 'hash', 'list', 'set', 'zset', 'stream'].includes(type)) {
      res.status(400).json({ error: '不支持的类型' })
      return
    }
    if (!Number.isFinite(ttl) || ttl < -1) {
      res.status(400).json({ error: 'TTL 需为 -1（永久）或正整数秒' })
      return
    }

    const existed = (await client.exists(key)) === 1
    await restoreKey(client, { key, type, ttl, value })
    const dumped = await dumpKey(client, key)

    res.json({
      ok: true,
      created: !existed,
      key: dumped,
      dbsize: await client.dbsize(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.get('/api/export', async (req, res) => {
  try {
    const client = await ensureConnected()
    const pattern = String(req.query.pattern || '*')
    const { keys, truncated } = await scanKeys(client, pattern)

    const items: ExportedKey[] = []
    for (const key of keys) {
      const dumped = await dumpKey(client, key)
      if (dumped) items.push(dumped)
    }

    const payload = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      db: currentDb,
      pattern,
      truncated,
      count: items.length,
      keys: items,
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const fileName = `redis-db${currentDb}-${stamp}.json`

    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}"`,
    )
    res.send(JSON.stringify(payload, null, 2))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.post('/api/import', async (req, res) => {
  try {
    const client = await ensureConnected()
    const mode = String(req.body.mode || 'merge')
    if (mode !== 'merge' && mode !== 'replace') {
      res.status(400).json({ error: 'mode 仅支持 merge 或 replace' })
      return
    }

    const data = req.body.data ?? req.body
    if (!data || typeof data !== 'object') {
      res.status(400).json({ error: '无效的导入数据' })
      return
    }

    const keys = Array.isArray((data as { keys?: unknown }).keys)
      ? ((data as { keys: ExportedKey[] }).keys)
      : Array.isArray(data)
        ? (data as ExportedKey[])
        : null

    if (!keys) {
      res.status(400).json({
        error: '请提供 Redis Desk 导出的 JSON（含 keys 数组）',
      })
      return
    }

    if (mode === 'replace') {
      await client.flushdb()
    }

    let imported = 0
    const errors: string[] = []

    for (const item of keys) {
      try {
        await restoreKey(client, item)
        imported += 1
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push(`${item?.key || '?'}: ${message}`)
        if (errors.length >= 20) break
      }
    }

    res.json({
      ok: true,
      mode,
      db: currentDb,
      imported,
      total: keys.length,
      skipped: keys.length - imported,
      errors,
      dbsize: await client.dbsize(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

export const API_PORT = PORT

export function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      createClient()
      console.log(`Redis API 已启动: http://127.0.0.1:${PORT}`)
      resolve()
    })
    server.on('error', reject)
  })
}

export function attachRendererStatic(distPath: string) {
  app.use(express.static(distPath))
  app.get(/.*/, (_req, res) => {
    res.sendFile('index.html', { root: distPath })
  })
}

