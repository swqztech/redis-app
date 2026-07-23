import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  connect,
  deleteKey,
  downloadBlob,
  exportKeys,
  fetchInfo,
  fetchKey,
  fetchKeys,
  importKeys,
  saveKey,
  selectDb,
  type KeyDetail,
  type KeyMeta,
} from './api'
import { CreateKeyModal } from './CreateKeyModal'
import { useDialog } from './dialogs'
import {
  clearHistory,
  pushHistory,
  readHistory,
  type HistoryItem,
} from './history'
import { HistoryModal } from './HistoryModal'
import { toast } from './toast'
import './App.css'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = '6379'
const DEFAULT_DB = '0'
const DB_STORAGE_KEY = 'redis-desk:db'
const DB_OPTIONS = Array.from({ length: 16 }, (_, i) => i)
const TYPE_OPTIONS = ['string', 'hash', 'list', 'set', 'zset'] as const

function emptyValueForType(type: string): unknown {
  switch (type) {
    case 'hash':
      return {}
    case 'list':
    case 'set':
      return []
    case 'zset':
      return [{ member: 'member', score: '1' }]
    default:
      return ''
  }
}

function parseEditorValue(type: string, text: string): unknown {
  if (type === 'string') {
    return text
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${type} 值需为合法 JSON`)
  }
}

function readStoredDb(): string {
  try {
    const raw = localStorage.getItem(DB_STORAGE_KEY)
    if (raw == null) return DEFAULT_DB
    const db = Number(raw)
    if (!Number.isInteger(db) || db < 0 || db > 15) return DEFAULT_DB
    return String(db)
  } catch {
    return DEFAULT_DB
  }
}

function writeStoredDb(db: string | number) {
  try {
    localStorage.setItem(DB_STORAGE_KEY, String(db))
  } catch {
    // 忽略隐私模式等写入失败
  }
}

/** 尝试把字符串当 JSON 解析；失败则原样返回 */
function tryParseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return text
  if (
    !(
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    )
  ) {
    return text
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    return text
  }
}

/** 递归展开嵌套的 JSON 字符串（Bull 等把对象序列化进 hash 字段很常见） */
function deepParse(value: unknown, depth = 0): unknown {
  if (depth > 8) return value

  if (typeof value === 'string') {
    const parsed = tryParseJson(value)
    if (parsed !== value) {
      return deepParse(parsed, depth + 1)
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepParse(item, depth + 1))
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepParse(item, depth + 1)
    }
    return out
  }

  return value
}

function formatValue(value: unknown): string {
  const parsed = deepParse(value)
  if (typeof parsed === 'string') return parsed
  return JSON.stringify(parsed, null, 2)
}

type JsonTokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct'

function highlightJson(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const re =
    /("(?:\\.|[^"\\])*")\s*(:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}\[\],])/g
  let last = 0
  let match: RegExpExecArray | null
  let index = 0

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index))
    }

    let kind: JsonTokenKind | null = null
    let content = match[0]

    if (match[1] != null) {
      kind = match[2] != null ? 'key' : 'string'
      content = match[0]
    } else if (match[3] != null) {
      kind = 'number'
    } else if (match[4] != null) {
      kind = 'boolean'
    } else if (match[5] != null) {
      kind = 'null'
    } else if (match[6] != null) {
      kind = 'punct'
    }

    if (kind) {
      nodes.push(
        <span key={index++} className={`json-${kind}`}>
          {content}
        </span>,
      )
    } else {
      nodes.push(content)
    }

    last = match.index + match[0].length
  }

  if (last < text.length) {
    nodes.push(text.slice(last))
  }

  return nodes
}

function ttlLabel(ttl: number): string {
  if (ttl < 0) return '永久'
  if (ttl < 60) return `${ttl}s`
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`
  return `${Math.floor(ttl / 86400)}d`
}

export default function App() {
  const [host, setHost] = useState(DEFAULT_HOST)
  const [port, setPort] = useState(DEFAULT_PORT)
  const [db, setDb] = useState(readStoredDb)
  const [password, setPassword] = useState('')
  const [pattern, setPattern] = useState('*')
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [info, setInfo] = useState<{
    db: number
    dbsize: number
    version: string
  } | null>(null)
  const [keys, setKeys] = useState<KeyMeta[]>([])
  const [truncated, setTruncated] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<KeyDetail | null>(null)
  const [loadingKeys, setLoadingKeys] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [ioBusy, setIoBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editKey, setEditKey] = useState('')
  const [editType, setEditType] = useState<string>('string')
  const [editTtl, setEditTtl] = useState('-1')
  const [editText, setEditText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [history, setHistory] = useState<HistoryItem[]>(() => readHistory())
  const [showHistory, setShowHistory] = useState(false)
  const [historyDetail, setHistoryDetail] = useState<HistoryItem | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const dialog = useDialog()

  const startEdit = (item: KeyDetail, isCreate = false) => {
    setCreating(isCreate)
    setEditing(true)
    setEditKey(item.key)
    setEditType(item.type)
    setEditTtl(String(item.ttl ?? -1))
    setEditText(
      item.type === 'string' && typeof item.value === 'string'
        ? (() => {
            try {
              return JSON.stringify(JSON.parse(item.value), null, 2)
            } catch {
              return item.value
            }
          })()
        : formatValue(item.value),
    )
  }

  const cancelEdit = () => {
    const wasCreating = creating
    setEditing(false)
    setCreating(false)
    if (wasCreating) {
      setSelected(null)
      setDetail(null)
    }
  }

  const handleCreate = () => {
    setShowCreate(true)
  }

  const openCreateDraft = (draft: {
    key: string
    type: string
    ttl: number
  }) => {
    const item: KeyDetail = {
      key: draft.key,
      type: draft.type,
      ttl: draft.ttl,
      value: emptyValueForType(draft.type),
    }
    setShowCreate(false)
    setSelected(item.key)
    setDetail(item)
    startEdit(item, true)
  }

  const handleSave = async () => {
    if (!editKey.trim()) {
      toast.error('key 不能为空')
      return
    }
    const ttl = Number(editTtl)
    if (!Number.isInteger(ttl) || ttl < -1 || ttl === 0) {
      toast.error('TTL 请填 -1（永久）或正整数秒')
      return
    }

    setSaving(true)
    setError(null)
    try {
      let value = parseEditorValue(editType, editText)
      // string 若编辑成 JSON 对象，写回时存成 JSON 文本
      if (editType === 'string') {
        const trimmed = editText.trim()
        if (
          (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))
        ) {
          try {
            value = JSON.stringify(JSON.parse(trimmed))
          } catch {
            value = editText
          }
        } else {
          value = editText
        }
      }

      const before = creating ? undefined : detail?.value
      const result = await saveKey({
        key: editKey.trim(),
        type: editType,
        ttl,
        value,
      })
      setHistory(
        pushHistory({
          action: result.created || creating ? 'create' : 'update',
          db: Number(db),
          key: result.key.key,
          type: result.key.type,
          summary: `${result.created || creating ? '新建' : '修改'} ${result.key.key}`,
          before,
          after: result.key.value,
        }),
      )
      setEditing(false)
      setCreating(false)
      setSelected(result.key.key)
      setDetail(result.key)
      await loadKeys(pattern)
      toast.success(
        `${result.created || creating ? '已新建' : '已保存'}：${result.key.key}`,
      )
    } catch (err) {
      toast.error(err)
    } finally {
      setSaving(false)
    }
  }

  const loadKeys = useCallback(async (match = pattern) => {
    setLoadingKeys(true)
    setError(null)
    try {
      const data = await fetchKeys(match)
      setKeys(data.keys)
      setTruncated(data.truncated)
      const infoData = await fetchInfo()
      setInfo({
        db: infoData.db,
        dbsize: infoData.dbsize,
        version: infoData.version,
      })
      setDb(String(infoData.db))
      writeStoredDb(infoData.db)
      setConnected(true)
    } catch (err) {
      setConnected(false)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingKeys(false)
    }
  }, [pattern])

  const loadDetail = useCallback(async (key: string) => {
    setSelected(key)
    setEditing(false)
    setCreating(false)
    setLoadingDetail(true)
    setError(null)
    try {
      const data = await fetchKey(key)
      setDetail(data)
    } catch (err) {
      setDetail(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  const handleDelete = async () => {
    if (!selected) return
    const ok = await dialog.confirm({
      title: '确认删除',
      message: `将删除 key：\n${selected}\n\n此操作不可恢复。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return

    setDeleting(true)
    setError(null)
    try {
      const before = detail?.value
      const type = detail?.type
      await deleteKey(selected)
      setHistory(
        pushHistory({
          action: 'delete',
          db: Number(db),
          key: selected,
          type,
          summary: `删除 ${selected}`,
          before,
        }),
      )
      setSelected(null)
      setDetail(null)
      setEditing(false)
      await loadKeys(pattern)
      toast.success(`已删除：${selected}`)
    } catch (err) {
      toast.error(err)
    } finally {
      setDeleting(false)
    }
  }

  const handleExport = async () => {
    if (!connected) return
    setIoBusy(true)
    setError(null)
    try {
      const { blob, fileName } = await exportKeys(pattern || '*')
      downloadBlob(blob, fileName)
      setHistory(
        pushHistory({
          action: 'export',
          db: Number(db),
          summary: `导出 pattern=${pattern || '*'} → ${fileName}`,
        }),
      )
      toast.success(`已导出：${fileName}`)
    } catch (err) {
      toast.error(err)
    } finally {
      setIoBusy(false)
    }
  }

  const handleImportFile = async (file: File) => {
    setIoBusy(true)
    setError(null)
    try {
      const text = await file.text()
      const data = JSON.parse(text)

      const mode = await dialog.choose({
        title: `导入到 DB ${db}`,
        message: `文件：${file.name}\n\n请选择导入方式：`,
        options: [
          { id: 'merge', label: '合并导入', primary: true },
          { id: 'replace', label: '覆盖导入', danger: true },
        ],
      })
      if (!mode) return

      if (mode === 'replace') {
        const sure = await dialog.confirm({
          title: '确认覆盖导入',
          message: `将清空当前 DB ${db} 的全部数据后再写入。\n此操作不可恢复。`,
          confirmLabel: '清空并导入',
          danger: true,
        })
        if (!sure) return
      }

      const result = await importKeys(data, mode as 'merge' | 'replace')
      await loadKeys(pattern)
      setSelected(null)
      setDetail(null)
      setEditing(false)

      const errHint =
        result.errors.length > 0
          ? `；部分失败：${result.errors.slice(0, 3).join('；')}`
          : ''
      setHistory(
        pushHistory({
          action: 'import',
          db: Number(db),
          summary: `导入 ${file.name}（${mode === 'replace' ? '覆盖' : '合并'}）成功 ${result.imported}/${result.total}`,
          after: { mode, imported: result.imported, total: result.total },
        }),
      )
      toast.success(
        `导入完成（${mode === 'replace' ? '覆盖' : '合并'}）：成功 ${result.imported}/${result.total}${errHint}`,
      )
    } catch (err) {
      toast.error(err)
    } finally {
      setIoBusy(false)
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  const handleConnect = async () => {
    setConnecting(true)
    setError(null)
    setDetail(null)
    setSelected(null)
    try {
      const selectedDb = Number(db)
      await connect(host.trim(), Number(port) || 6379, selectedDb, password)
      writeStoredDb(selectedDb)
      setConnected(true)
      await loadKeys(pattern)
    } catch (err) {
      setConnected(false)
      setInfo(null)
      setKeys([])
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnecting(false)
    }
  }

  const handleSelectDb = async (nextDb: string) => {
    setDb(nextDb)
    writeStoredDb(nextDb)
    if (!connected) return

    setConnecting(true)
    setError(null)
    setDetail(null)
    setSelected(null)
    try {
      await selectDb(Number(nextDb))
      await loadKeys(pattern)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConnecting(false)
    }
  }

  useEffect(() => {
    void handleConnect()
    // 首次自动连接本地默认实例
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <h1>Redis Desk</h1>
            <p>本地数据浏览器</p>
          </div>
        </div>

        <form
          className="connect-form"
          onSubmit={(e) => {
            e.preventDefault()
            void handleConnect()
          }}
        >
          <label>
            <span>主机</span>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            <span>端口</span>
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <label>
            <span>DB</span>
            <select
              value={db}
              onChange={(e) => void handleSelectDb(e.target.value)}
              disabled={connecting}
            >
              {DB_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="可选"
            />
          </label>
          <button type="submit" disabled={connecting}>
            {connecting ? '连接中…' : '连接'}
          </button>
        </form>

        <div className={`status ${connected ? 'is-on' : 'is-off'}`}>
          <span className="status-dot" />
          {connected
            ? `已连接 · DB ${info?.db ?? db} · Redis ${info?.version ?? '?'} · ${info?.dbsize ?? 0} keys`
            : '未连接'}
        </div>
      </header>

      {error && (
        <div className="banner" role="alert">
          <strong>连接或查询失败</strong>
          <span>{error}</span>
          <span className="banner-hint">
            请确认本地 Redis 已启动（默认 127.0.0.1:6379）
          </span>
        </div>
      )}

      <main className="workspace">
        <aside className="keys-panel">
          <form
            className="search-row"
            onSubmit={(e) => {
              e.preventDefault()
              void loadKeys(pattern)
            }}
          >
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="匹配模式，如 user:*"
              spellCheck={false}
            />
            <button type="submit" disabled={!connected || loadingKeys || ioBusy}>
              {loadingKeys ? '扫描…' : '刷新'}
            </button>
          </form>

          <div className="io-row">
            <button
              type="button"
              className="btn-secondary"
              disabled={!connected || ioBusy}
              onClick={() => void handleExport()}
            >
              {ioBusy ? '处理中…' : '导出'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!connected || ioBusy}
              onClick={() => importInputRef.current?.click()}
            >
              导入
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!connected || ioBusy || saving}
              onClick={handleCreate}
            >
              新建
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowHistory(true)}
            >
              修改记录{history.length ? ` (${history.length})` : ''}
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleImportFile(file)
              }}
            />
            <span className="io-hint">按上方 pattern 导出；导入/修改写入当前 DB</span>
          </div>

          {truncated && (
            <p className="hint">已截断到前 2000 个 key，请缩小匹配范围。</p>
          )}

          <ul className="key-list">
            {keys.length === 0 && !loadingKeys && (
              <li className="empty">没有匹配的 key</li>
            )}
            {keys.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  className={selected === item.key ? 'is-active' : ''}
                  onClick={() => void loadDetail(item.key)}
                >
                  <span className="key-name">{item.key}</span>
                  <span className="key-meta">
                    <em className={`type type-${item.type}`}>{item.type}</em>
                    <span>{ttlLabel(item.ttl)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="value-panel">
          {!selected && (
            <div className="placeholder">
              <h2>选择一个 key</h2>
              <p>左侧列出当前库中的键，可查看、编辑、删除，也可新建与导入导出。</p>
            </div>
          )}

          {selected && (
            <>
              <div className="value-head">
                <div>
                  <p className="eyebrow">KEY</p>
                  {editing ? (
                    <input
                      className="edit-key-input"
                      value={editKey}
                      disabled={!creating}
                      onChange={(e) => setEditKey(e.target.value)}
                      spellCheck={false}
                    />
                  ) : (
                    <h2>{selected}</h2>
                  )}
                </div>
                <div className="value-actions">
                  {!editing && detail && (
                    <div className="chips">
                      <span className={`type type-${detail.type}`}>
                        {detail.type}
                      </span>
                      <span>TTL {ttlLabel(detail.ttl)}</span>
                    </div>
                  )}
                  {editing ? (
                    <>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={saving}
                        onClick={cancelEdit}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={saving}
                        onClick={() => void handleSave()}
                      >
                        {saving ? '保存中…' : '保存'}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={!detail || loadingDetail || deleting}
                        onClick={() => detail && startEdit(detail)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        disabled={deleting || loadingDetail || editing}
                        onClick={() => void handleDelete()}
                      >
                        {deleting ? '删除中…' : '删除'}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {loadingDetail && <p className="hint">读取中…</p>}

              {editing && (
                <div className="edit-form">
                  <label>
                    <span>类型</span>
                    <select
                      value={editType}
                      disabled={!creating}
                      onChange={(e) => {
                        const next = e.target.value
                        setEditType(next)
                        setEditText(formatValue(emptyValueForType(next)))
                      }}
                    >
                      {TYPE_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>TTL（秒，-1 永久）</span>
                    <input
                      value={editTtl}
                      onChange={(e) => setEditTtl(e.target.value)}
                      inputMode="numeric"
                    />
                  </label>
                  <p className="io-hint">
                    hash / list / set / zset 请编辑 JSON；string 可直接改文本。
                  </p>
                  <textarea
                    className="value-editor"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    spellCheck={false}
                  />
                </div>
              )}

              {!loadingDetail && !editing && detail && (
                <pre className="value-body">
                  {highlightJson(formatValue(detail.value))}
                </pre>
              )}
            </>
          )}
        </section>
      </main>

      <CreateKeyModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSubmit={openCreateDraft}
      />

      <HistoryModal
        open={showHistory}
        history={history}
        detail={historyDetail}
        highlightJson={highlightJson}
        onClose={() => {
          setShowHistory(false)
          setHistoryDetail(null)
        }}
        onSelect={setHistoryDetail}
        onClear={() => {
          void (async () => {
            const ok = await dialog.confirm({
              title: '清空修改记录',
              message: '将清空本机浏览器中保存的修改记录，不影响 Redis 数据。',
              confirmLabel: '清空',
              danger: true,
            })
            if (!ok) return
            setHistory(clearHistory())
            setHistoryDetail(null)
            toast.success('修改记录已清空')
          })()
        }}
      />
    </div>
  )
}
