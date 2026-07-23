import { useEffect, useRef, useState } from 'react'

const TYPE_OPTIONS = [
  { id: 'string', label: 'String', hint: '文本 / JSON 字符串' },
  { id: 'hash', label: 'Hash', hint: '字段映射对象' },
  { id: 'list', label: 'List', hint: '有序数组' },
  { id: 'set', label: 'Set', hint: '无序去重集合' },
  { id: 'zset', label: 'ZSet', hint: '带分值的有序集合' },
] as const

export type CreateKeyDraft = {
  key: string
  type: string
  ttl: number
}

type Props = {
  open: boolean
  onClose: () => void
  onSubmit: (draft: CreateKeyDraft) => void
}

export function CreateKeyModal({ open, onClose, onSubmit }: Props) {
  const [keyName, setKeyName] = useState('new:key')
  const [type, setType] = useState<string>('string')
  const [ttl, setTtl] = useState('-1')
  const [localError, setLocalError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setKeyName('new:key')
    setType('string')
    setTtl('-1')
    setLocalError(null)
    queueMicrotask(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [open])

  if (!open) return null

  const submit = () => {
    const name = keyName.trim()
    if (!name) {
      setLocalError('请填写 key 名称')
      return
    }
    const ttlNum = Number(ttl)
    if (!Number.isInteger(ttlNum) || ttlNum < -1 || ttlNum === 0) {
      setLocalError('TTL 请填 -1（永久）或正整数秒')
      return
    }
    onSubmit({ key: name, type, ttl: ttlNum })
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-key-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h3 id="create-key-title">新建 Key</h3>
            <p className="modal-sub">填写名称与类型后进入编辑器写入内容</p>
          </div>
          <button className="btn-secondary" type="button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="create-body">
          <label className="create-field">
            <span>Key 名称</span>
            <input
              ref={inputRef}
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="例如 user:1001 或 cache:home"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') onClose()
              }}
            />
          </label>

          <div className="create-field">
            <span>数据类型</span>
            <div className="type-grid">
              {TYPE_OPTIONS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`type-card ${type === item.id ? 'is-active' : ''}`}
                  onClick={() => setType(item.id)}
                >
                  <strong>{item.label}</strong>
                  <em>{item.hint}</em>
                </button>
              ))}
            </div>
          </div>

          <label className="create-field create-ttl">
            <span>TTL（秒）</span>
            <input
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
              inputMode="numeric"
              placeholder="-1 表示永久"
            />
            <small>-1 表示不过期</small>
          </label>

          {localError && <p className="modal-error">{localError}</p>}
        </div>

        <footer className="modal-foot">
          <button className="btn-secondary" type="button" onClick={onClose}>
            取消
          </button>
          <div className="modal-foot-right">
            <button className="btn-primary" type="button" onClick={submit}>
              继续编辑内容
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
