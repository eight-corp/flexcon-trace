import { CircleAlert, CircleCheck } from 'lucide-react'

export const INSPECTION_DOCUMENT_NAMES = {
  grading_notice: '格付結果通知票',
  inspection_ledger: '検査請求者別検査台帳',
} as const

export type InspectionDocument = keyof typeof INSPECTION_DOCUMENT_NAMES
export type InspectionPrintCounts = Partial<Record<InspectionDocument, number>>

export function InspectionPrintStatus({ count, prominent = false }: { count: number | null | undefined; prominent?: boolean }) {
  const printed = typeof count === 'number' && count > 0
  const state = count == null ? 'unknown' : printed ? 'printed' : 'unprinted'
  const label = count === null ? '確認中' : count === undefined ? '取得エラー' : printed ? `印刷済み（${count}回）` : '未印刷'
  return <span className={`inspection-document-status ${state}${prominent ? ' prominent' : ''}`}>
    {printed ? <CircleCheck size={prominent ? 20 : 14} aria-hidden="true" /> : count === 0 ? <CircleAlert size={prominent ? 20 : 14} aria-hidden="true" /> : null}
    {label}
  </span>
}
