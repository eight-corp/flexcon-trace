type CertificateRecord = { flexcon_no: number; certificate_print_count?: number | null }

export function certificateDefaultRange(records: readonly CertificateRecord[]) {
  const ordered = [...records].sort((left, right) => left.flexcon_no - right.flexcon_no)
  const first = ordered.findIndex((item) => (item.certificate_print_count ?? 0) === 0)
  if (first === -1) return { start: '', count: '' }

  let end = first
  while (end < ordered.length && (ordered[end].certificate_print_count ?? 0) === 0) end += 1
  return { start: String(ordered[first].flexcon_no), count: String(end - first) }
}
