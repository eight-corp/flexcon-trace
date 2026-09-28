import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizationAddError } from '../src/lib/authorizationValidation.ts'

const items = [{ authorization_no: '1', full_name: '山田 太郎' }]

test('authorization add reports required and oversized values', () => {
  assert.match(authorizationAddError({ authorization_no: '', full_name: '' }, items), /№を入力/)
  assert.match(authorizationAddError({ authorization_no: '2', full_name: '　' }, items), /氏名を入力/)
  assert.match(authorizationAddError({ authorization_no: '2'.repeat(41), full_name: '新規' }, items), /40文字/)
  assert.match(authorizationAddError({ authorization_no: '2', full_name: '新'.repeat(121) }, items), /120文字/)
})

test('authorization add reports duplicate number and whitespace-insensitive name', () => {
  assert.match(authorizationAddError({ authorization_no: ' 1 ', full_name: '別人' }, items), /№「1」/)
  assert.match(authorizationAddError({ authorization_no: '2', full_name: '山田　太郎' }, items), /すでに登録/)
  assert.equal(authorizationAddError({ authorization_no: '2', full_name: '新規' }, items), null)
})
