type CertificateQuantity = { flexcon_no: number; brand: string | null; quantity_kg: number }
type Weights = { branded_rice: number; feed_rice: number }

function numberRanges(numbers: number[]) {
  const sorted = [...new Set(numbers)].sort((left, right) => left - right)
  const ranges: string[] = []
  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index]
    let end = start
    while (sorted[index + 1] === end + 1) end = sorted[++index]
    ranges.push(start === end ? String(start) : `${start}～${end}`)
  }
  return ranges.join('、')
}

export function certificateQuantityConfirmation(targets: CertificateQuantity[], weights: Weights) {
  const groups = new Map<string, { brand: string; quantity: number; initial: number; numbers: number[] }>()
  for (const item of targets) {
    const brand = item.brand?.trim() || '銘柄未登録'
    const initial = brand === '飼料用玄米' ? weights.feed_rice : weights.branded_rice
    if (item.quantity_kg === initial) continue
    const key = JSON.stringify([brand, item.quantity_kg, initial])
    const group = groups.get(key) ?? { brand, quantity: item.quantity_kg, initial, numbers: [] }
    group.numbers.push(item.flexcon_no)
    groups.set(key, group)
  }
  if (groups.size === 0) return null
  const details = [...groups.values()].map(group => (
    `${group.brand}　№${numberRanges(group.numbers)}（${group.numbers.length}本）\n現在：${group.quantity.toLocaleString('ja-JP')}kg／本　初期値：${group.initial.toLocaleString('ja-JP')}kg／本`
  ))
  return ['初期値と異なる数量の推フレがあります。', ...details, '現在の数量で間違いありませんか？'].join('\n\n')
}
