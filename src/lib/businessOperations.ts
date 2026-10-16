const pending = new Set<Promise<void>>()
export const BUSINESS_WRITES_CHANGED = 'business-writes-changed'

export function pendingBusinessWrites() { return pending.size }

export function trackBusinessWrite(url: URL, method: string) {
  const mutation = /\/rest\/v1\/rpc\/flexcon_(?:add|update|delete|set|save|register|import|append|split|mark|bulk|reorder|confirm|submit|undo)_/.test(url.pathname)
  if (method.toUpperCase() !== 'POST' || (!mutation && !url.pathname.includes('/functions/v1/'))) return () => {}
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  pending.add(promise)
  window.dispatchEvent(new Event(BUSINESS_WRITES_CHANGED))
  return () => {
    pending.delete(promise)
    resolve()
    window.dispatchEvent(new Event(BUSINESS_WRITES_CHANGED))
  }
}

export async function waitForBusinessWrites() {
  // A completed save can enqueue another save in the next microtask.
  do {
    await Promise.all([...pending])
    await new Promise((resolve) => window.setTimeout(resolve, 80))
  } while (pending.size)
}

export function undoActionLabel(action: string) {
  const subject = action === 'flexcon_bulk_delete_inventory_records' ? '入出庫記録'
    : action.includes('purchase_statement_image') ? '仕切書画像'
      : action.includes('purchase_') && action.includes('_master') ? '仕切書マスタ'
        : action.includes('memo') ? 'メモ' : action.includes('authorization') ? '委任状'
    : action.includes('purchase_statement') || action.includes('purchase_inventory') ? '仕切書'
      : action.includes('inventory_movement') ? '入出庫・倉庫間移動'
        : action.includes('inventory_record') || action.includes('shipment') ? '出荷記録'
          : action.includes('mixed_flexcon') ? '混在フレコン'
            : action.includes('certificates_printed') ? '印刷記録'
              : action.includes('inspection_option') || action.includes('inspection_weights') || action.includes('destination') || action.includes('transport_profile') ? 'マスタ'
                : action.includes('inspection') ? '検査記録' : '業務データ'
  const operation = action.includes('_delete_') ? '削除' : action.includes('_import_') ? '取込み'
    : action.includes('_confirm_') ? '確認' : action.includes('_split_') ? '分割'
      : action.includes('_add_') || action.includes('_register_') || action.includes('_append_') || action.includes('_submit_') ? '登録' : '変更'
  return `${subject}の${operation}`
}
