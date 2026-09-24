export function matchesFilterText(value: string, query: string): boolean {
  const term = query.trim().normalize('NFKC').toLocaleLowerCase('ja-JP')
  return !term || value.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(term)
}
