import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

type ConfirmRequest = {
  type: 'confirm'
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

type ChooseRequest = {
  type: 'choose'
  title: string
  message: string
  options: { id: string; label: string; danger?: boolean; primary?: boolean }[]
  cancelLabel?: string
  resolve: (id: string | null) => void
}

type DialogRequest = ConfirmRequest | ChooseRequest

type DialogApi = {
  confirm: (opts: Omit<ConfirmRequest, 'type' | 'resolve'>) => Promise<boolean>
  choose: (opts: Omit<ChooseRequest, 'type' | 'resolve'>) => Promise<string | null>
}

const DialogContext = createContext<DialogApi | null>(null)

export function DialogProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<DialogRequest | null>(null)

  const close = useCallback(() => setReq(null), [])

  const api = useMemo<DialogApi>(
    () => ({
      confirm: (opts) =>
        new Promise((resolve) => {
          setReq({ ...opts, type: 'confirm', resolve })
        }),
      choose: (opts) =>
        new Promise((resolve) => {
          setReq({ ...opts, type: 'choose', resolve })
        }),
    }),
    [],
  )

  const cancel = () => {
    if (!req) return
    if (req.type === 'confirm') req.resolve(false)
    else req.resolve(null)
    close()
  }

  const confirmOk = () => {
    if (!req || req.type !== 'confirm') return
    req.resolve(true)
    close()
  }

  const chooseOk = (id: string) => {
    if (!req || req.type !== 'choose') return
    req.resolve(id)
    close()
  }

  return (
    <DialogContext.Provider value={api}>
      {children}
      {req && (
        <div className="modal-backdrop" role="presentation" onClick={cancel}>
          <div
            className="modal-card dialog-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-head">
              <h3 id="app-dialog-title">{req.title}</h3>
              <button className="btn-secondary" type="button" onClick={cancel}>
                关闭
              </button>
            </header>

            <div className="dialog-body">
              <p className="dialog-message">{req.message}</p>
            </div>

            <footer className="modal-foot">
              <button className="btn-secondary" type="button" onClick={cancel}>
                {req.cancelLabel || '取消'}
              </button>
              <div className="modal-foot-right">
                {req.type === 'confirm' && (
                  <button
                    className={req.danger ? 'btn-danger' : 'btn-primary'}
                    type="button"
                    onClick={confirmOk}
                  >
                    {req.confirmLabel || '确定'}
                  </button>
                )}
                {req.type === 'choose' &&
                  req.options.map((opt) => (
                    <button
                      key={opt.id}
                      className={
                        opt.danger
                          ? 'btn-danger'
                          : opt.primary
                            ? 'btn-primary'
                            : 'btn-secondary'
                      }
                      type="button"
                      onClick={() => chooseOk(opt.id)}
                    >
                      {opt.label}
                    </button>
                  ))}
              </div>
            </footer>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(DialogContext)
  if (!ctx) {
    throw new Error('useDialog 必须在 DialogProvider 内使用')
  }
  return ctx
}
