type AuthorizationIdentity = { authorization_no: string; full_name: string }

export function normalizeName(value: string): string {
  return value.trim().replace(/[\s　]+/g, '').toLocaleLowerCase('ja')
}

export function authorizationAddError(record: AuthorizationIdentity, items: AuthorizationIdentity[]): string | null {
  const no = record.authorization_no.trim()
  const name = record.full_name.trim()
  if (!no) return '№を入力してください。'
  if (no.length > 40) return '№を40文字以内で入力してください。'
  if (!name) return '氏名を入力してください。'
  if (name.length > 120) return '氏名を120文字以内で入力してください。'
  if (items.some((item) => item.authorization_no.trim() === no)) return `№「${no}」はすでに登録されています。`
  if (items.some((item) => normalizeName(item.full_name) === normalizeName(name))) return `氏名「${name}」はすでに登録されています。`
  return null
}
