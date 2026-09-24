export const INSPECTION_GRADES = ['1等', '2等', '3等', '合格'] as const

export function selectedInspectionGrade(grade: string | null | undefined): string {
  const value = grade?.trim() ?? ''
  return INSPECTION_GRADES.some((candidate) => candidate === value) ? value : ''
}
