import type { ReactNode } from 'react'
import { actionLabel, type HistoryItem } from './history'

type Props = {
  open: boolean
  history: HistoryItem[]
  detail: HistoryItem | null
  onClose: () => void
  onSelect: (item: HistoryItem) => void
  onClear: () => void
  highlightJson: (text: string) => ReactNode[]
}

export function HistoryModal({
  open,
  history,
  detail,
  onClose,
  onSelect,
  onClear,
  highlightJson,
}: Props) {
  if (!open) return null

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h3 id="history-modal-title">修改记录</h3>
            <p className="modal-sub">
              保存在本机浏览器，含新建 / 修改 / 删除 / 导入 / 导出
            </p>
          </div>
          <button className="btn-secondary" type="button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="history-modal-body">
          {history.length === 0 ? (
            <div className="placeholder compact">
              <p>暂无修改记录</p>
            </div>
          ) : (
            <ul className="history-list">
              {history.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={detail?.id === item.id ? 'is-active' : ''}
                    onClick={() => onSelect(item)}
                  >
                    <span className="history-main">
                      <em className={`hist hist-${item.action}`}>
                        {actionLabel(item.action)}
                      </em>
                      <span>{item.summary}</span>
                    </span>
                    <span className="history-meta">
                      DB {item.db} · {new Date(item.at).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {detail && (
            <pre className="value-body history-detail">
              {highlightJson(
                JSON.stringify(
                  {
                    action: detail.action,
                    db: detail.db,
                    key: detail.key,
                    type: detail.type,
                    at: detail.at,
                    before: detail.before,
                    after: detail.after,
                  },
                  null,
                  2,
                ),
              )}
            </pre>
          )}
        </div>

        <footer className="modal-foot">
          <button
            className="btn-danger"
            type="button"
            disabled={history.length === 0}
            onClick={onClear}
          >
            清空记录
          </button>
          <div className="modal-foot-right">
            <button className="btn-secondary" type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
