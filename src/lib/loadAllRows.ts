type PageResult<T, E> = { data: T[] | null; error: E | null }

export async function loadAllRows<T, E>(loadPage: (from: number, to: number) => PromiseLike<PageResult<T, E>>): Promise<PageResult<T, E>> {
  const rows: T[] = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await loadPage(from, from + pageSize - 1)
    if (error) return { data: null, error }
    rows.push(...(data ?? []))
    if ((data?.length ?? 0) < pageSize) return { data: rows, error: null }
  }
}
