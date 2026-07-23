export type KeyMeta = {
  key: string
  type: string
  ttl: number
}

export type KeyDetail = {
  key: string
  type: string
  ttl: number
  value: unknown
}

export type ImportResult = {
  ok: boolean
  mode: 'merge' | 'replace'
  db: number
  imported: number
  total: number
  skipped: number
  errors: string[]
  dbsize: number
}

export type SaveKeyPayload = {
  key: string
  type: string
  ttl: number
  value: unknown
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`)
  }
  return data as T
}

export function connect(
  host: string,
  port: number,
  db: number,
  password?: string,
) {
  return request<{
    ok: boolean
    pong: string
    host: string
    port: number
    db: number
  }>('/api/connect', {
    method: 'POST',
    body: JSON.stringify({
      host,
      port,
      db,
      password: password || undefined,
    }),
  })
}

export function selectDb(db: number) {
  return request<{ ok: boolean; db: number; dbsize: number }>('/api/select', {
    method: 'POST',
    body: JSON.stringify({ db }),
  })
}

export function fetchInfo() {
  return request<{
    ok: boolean
    db: number
    dbsize: number
    version: string
    status: string
  }>('/api/info')
}

export function fetchKeys(pattern: string) {
  return request<{ keys: KeyMeta[]; truncated: boolean }>(
    `/api/keys?pattern=${encodeURIComponent(pattern)}`,
  )
}

export function fetchKey(name: string) {
  return request<KeyDetail>(`/api/key?name=${encodeURIComponent(name)}`)
}

export function deleteKey(name: string) {
  return request<{ ok: boolean; key: string; removed: number; dbsize: number }>(
    `/api/key?name=${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  )
}

export function saveKey(payload: SaveKeyPayload) {
  return request<{
    ok: boolean
    created: boolean
    key: KeyDetail
    dbsize: number
  }>('/api/key', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

function fileNameFromDisposition(header: string | null, fallback: string) {
  if (!header) return fallback
  const utf = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf?.[1]) return decodeURIComponent(utf[1])
  const plain = header.match(/filename="?([^"]+)"?/i)
  return plain?.[1] || fallback
}

export async function exportKeys(pattern: string) {
  const res = await fetch(`/api/export?pattern=${encodeURIComponent(pattern)}`)
  if (!res.ok) {
    let message = `导出失败 (${res.status})`
    try {
      const data = await res.json()
      if (data.error) message = data.error
    } catch {
      // ignore
    }
    throw new Error(message)
  }

  const blob = await res.blob()
  const fileName = fileNameFromDisposition(
    res.headers.get('Content-Disposition'),
    `redis-export-${Date.now()}.json`,
  )
  return { blob, fileName }
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function importKeys(data: unknown, mode: 'merge' | 'replace') {
  return request<ImportResult>('/api/import', {
    method: 'POST',
    body: JSON.stringify({ mode, data }),
  })
}
