type AuthorizationPerson = { full_name: string; address?: string | null }
type AuthorizationIdentity = AuthorizationPerson & { authorization_no: string }

export function normalizeName(value: string): string {
  return value.trim().replace(/[\s　]+/g, '').toLocaleLowerCase('ja')
}

export function sameAuthorizationPerson(left: AuthorizationPerson, right: AuthorizationPerson): boolean {
  return normalizeName(left.full_name) === normalizeName(right.full_name)
    && normalizeName(left.address ?? '') === normalizeName(right.address ?? '')
}

export function authorizationAddError(record: AuthorizationIdentity, items: AuthorizationIdentity[]): string | null {
  const no = record.authorization_no.trim()
  const name = record.full_name.trim()
  if (!no) return '№を入力してください。'
  if (no.length > 40) return '№を40文字以内で入力してください。'
  if (!name) return '氏名を入力してください。'
  if (name.length > 120) return '氏名を120文字以内で入力してください。'
  if (items.some((item) => item.authorization_no.trim() === no)) return `№「${no}」はすでに登録されています。`
  if (items.some((item) => sameAuthorizationPerson(item, record))) return `氏名「${name}」と住所が同じ委任状はすでに登録されています。`
  return null
}
