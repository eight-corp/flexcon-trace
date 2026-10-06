import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('database permits namesakes at distinct addresses for inserts and edits', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create table flexcon_authorizations(id uuid primary key default gen_random_uuid(), full_name text not null, address text, notes text);
      insert into flexcon_authorizations(full_name,address) values ('既存重複','住所A'),('既存重複','住所A');`)
    await db.exec(fs.readFileSync('supabase/migrations/202609020006_authorization_validation.sql', 'utf8'))
    await db.exec(fs.readFileSync('supabase/migrations/202610070001_authorization_name_address_duplicate.sql', 'utf8'))
    const insert = (name, address) => db.query('insert into flexcon_authorizations(full_name,address) values ($1,$2) returning id', [name, address])
    const first = (await insert('山田 太郎', '青森県 十和田市 1-2')).rows[0].id
    const second = (await insert('山田　太郎', '青森県十和田市3-4')).rows[0].id
    await assert.rejects(insert('山田太郎', '青森県　十和田市1-2'), /氏名.*住所が同じ/)
    await assert.rejects(db.query('update flexcon_authorizations set address=$1 where id=$2', ['青森県 十和田市1-2', second]), /氏名.*住所が同じ/)
    const third = (await insert('別人', '青森県十和田市1-2')).rows[0].id
    await assert.rejects(db.query('update flexcon_authorizations set full_name=$1 where id=$2', ['山田太郎', third]), /氏名.*住所が同じ/)
    await db.query('update flexcon_authorizations set full_name=$1 where id=$2', ['山田太郎', second])
    await db.query('update flexcon_authorizations set address=$1 where id=$2', ['青森県十和田市5-6', second])
    await db.query('update flexcon_authorizations set address=$1 where id=$2', ['青森県　十和田市 1-2 ', first])
    await insert('住所不明', null)
    await assert.rejects(insert('住所 不明', '　'), /氏名.*住所が同じ/)
    await db.exec("update flexcon_authorizations set notes='updated',full_name='既存 重複',address='住所 A' where full_name='既存重複'")
    assert.equal((await db.query('select count(*)::int as count from flexcon_authorizations')).rows[0].count, 6)
  } finally {
    await db.close()
  }
})
