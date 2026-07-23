export type HistoryAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'import'
  | 'export'

export type HistoryItem = {
  id: string
  at: string
  action: HistoryAction
  db: number
  key?: string
  type?: string
  summary: string
  before?: unknown
  after?: unknown
}

const STORAGE_KEY = 'redis-desk:history'
const MAX_ITEMS = 200

export function readHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as HistoryItem[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function writeHistory(items: HistoryItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)))
  } catch {
    // 忽略配额不足等情况
  }
}

export function pushHistory(
  item: Omit<HistoryItem, 'id' | 'at'> & { at?: string },
): HistoryItem[] {
  const next: HistoryItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: item.at || new Date().toISOString(),
    action: item.action,
    db: item.db,
    key: item.key,
    type: item.type,
    summary: item.summary,
    before: item.before,
    after: item.after,
  }
  const list = [next, ...readHistory()].slice(0, MAX_ITEMS)
  writeHistory(list)
  return list
}

export function clearHistory() {
  writeHistory([])
  return []
}

export function actionLabel(action: HistoryAction): string {
  switch (action) {
    case 'create':
      return '新建'
    case 'update':
      return '修改'
    case 'delete':
      return '删除'
    case 'import':
      return '导入'
    case 'export':
      return '导出'
    default:
      return action
  }
}
