import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizationAddError, sameAuthorizationPerson } from '../src/lib/authorizationValidation.ts'

const items = [{ authorization_no: '1', full_name: '山田 太郎' }]

test('authorization add reports required and oversized values', () => {
  assert.match(authorizationAddError({ authorization_no: '', full_name: '' }, items), /№を入力/)
  assert.match(authorizationAddError({ authorization_no: '2', full_name: '　' }, items), /氏名を入力/)
  assert.match(authorizationAddError({ authorization_no: '2'.repeat(41), full_name: '新規' }, items), /40文字/)
  assert.match(authorizationAddError({ authorization_no: '2', full_name: '新'.repeat(121) }, items), /120文字/)
})

test('authorization add reports duplicate number and matching name/address', () => {
  assert.match(authorizationAddError({ authorization_no: ' 1 ', full_name: '別人' }, items), /№「1」/)
  assert.match(authorizationAddError({ authorization_no: '2', full_name: '山田　太郎' }, items), /すでに登録/)
  assert.equal(authorizationAddError({ authorization_no: '2', full_name: '新規' }, items), null)
})

test('same name at different addresses is allowed, matching name/address ignores whitespace', () => {
  const existing = [{ authorization_no: '1', full_name: '山田 太郎', address: '青森県 十和田市 1-2' }]
  assert.equal(authorizationAddError({ authorization_no: '2', full_name: '山田　太郎', address: '青森県十和田市3-4' }, existing), null)
  assert.match(authorizationAddError({ authorization_no: '2', full_name: '山田太郎', address: '青森県　十和田市1-2' }, existing), /氏名.*住所が同じ/)
  assert.equal(authorizationAddError({ authorization_no: '2', full_name: '別人', address: existing[0].address }, existing), null)
  assert.equal(sameAuthorizationPerson({ full_name: '山田太郎', address: null }, { full_name: '山田 太郎', address: '　 ' }), true)
  assert.equal(sameAuthorizationPerson({ full_name: '山田太郎', address: '1-2' }, { full_name: '山田 太郎', address: '3-4' }), false)
})
