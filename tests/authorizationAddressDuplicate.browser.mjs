import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve('dist')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const db = new PGlite()
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    const errors = []
    let writes = 0
    try {
      await db.exec(`create role anon; create role authenticated;
        create table workers(worker_id text primary key);
        insert into workers values ('tester');
        create function flexcon_require_active_worker(text) returns workers language sql
        as $$ select w from workers w where worker_id=$1 $$;`)
      for (const migration of ['202609020004_authorizations.sql', '202609020005_authorization_excel_import.sql', '202609020006_authorization_validation.sql', '202610070001_authorization_name_address_duplicate.sql']) {
        await db.exec(fs.readFileSync(`supabase/migrations/${migration}`, 'utf8'))
      }
      await db.exec(`insert into flexcon_authorizations(authorization_no,full_name,address,created_by_worker_id)
        values ('1','山田太郎','青森県十和田市1-2','tester');`)
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://authorization-address.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.join(root, pathname === '/' ? 'index.html' : pathname)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      // Exercise real RPCs in an isolated database, never production records.
      await context.route('**/rest/v1/**', async route => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        let body = []
        try {
          if (resource === 'rpc/business_session') {
            body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'admin' } }
          } else if (resource === 'flexcon_authorizations') {
            body = (await db.query('select * from flexcon_authorizations')).rows
          } else if (['rpc/flexcon_add_authorization', 'rpc/flexcon_update_authorization'].includes(resource)) {
            writes++
            const args = Object.entries(route.request().postDataJSON())
            assert.equal(args.find(([key]) => key === 'p_worker_id')[1], 'tester')
            const fn = resource.slice(4)
            const bindings = args.map(([key], index) => `${key} => $${index + 1}`).join(',')
            body = (await db.query(`select ${fn}(${bindings}) as result`, args.map(([, value]) => value))).rows[0].result
          } else if (resource.startsWith('rpc/')) {
            errors.push(`Unexpected RPC: ${resource}`)
          }
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
        } catch (error) {
          errors.push(error.message)
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: error.message }) })
        }
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.goto('https://authorization-address.test/')
      await page.getByRole('button', { name: '委任状一覧', exact: true }).click()
      const rows = page.locator('.authorization-data-row')
      await rows.first().waitFor()
      await page.getByRole('button', { name: '追加', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('氏名', { exact: true }).fill('山田太郎')
      await dialog.getByLabel('住所', { exact: true }).fill('青森県十和田市3-4')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await page.waitForFunction(() => document.querySelectorAll('.authorization-data-row').length === 2)
      assert.equal(writes, 1)

      await page.getByLabel('新規委任状 full_name', { exact: true }).fill('山田 太郎')
      await page.getByLabel('新規委任状 address', { exact: true }).fill('青森県 十和田市1-2')
      await page.getByRole('button', { name: 'この行を登録', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: '住所が同じ委任状' }).waitFor()
      assert.equal(writes, 1)
      await page.getByLabel('新規委任状 address', { exact: true }).fill('青森県十和田市5-6')
      await page.getByRole('button', { name: 'この行を登録', exact: true }).click()
      await page.waitForFunction(() => document.querySelectorAll('.authorization-data-row').length === 3)
      assert.equal(writes, 2)

      const secondRow = rows.filter({ has: page.locator('.authorization-no', { hasText: /^2$/ }) })
      await secondRow.locator('td').nth(5).dblclick()
      const editor = page.locator('.authorization-cell-editor')
      await editor.fill('青森県十和田市1-2')
      await editor.press('Enter')
      await page.getByRole('alert').filter({ hasText: '住所が同じ委任状' }).waitFor()
      assert.equal(writes, 2)
      await editor.fill('青森県十和田市7-8')
      await editor.press('Enter')
      await editor.waitFor({ state: 'detached' })
      assert.equal(writes, 3)
      assert.equal((await db.query("select address from flexcon_authorizations where authorization_no='2'")).rows[0].address, '青森県十和田市7-8')

      // Import follows the same database rule and remains atomic on duplicates.
      const imported = [{ authorization_no: '4', full_name: '山田太郎', address: '青森県十和田市9-10' }]
      const result = await db.query('select flexcon_import_authorizations($1,$2::jsonb) as result', ['tester', JSON.stringify(imported)])
      assert.equal(result.rows[0].result.inserted, 1)
      await assert.rejects(db.query('select flexcon_import_authorizations($1,$2::jsonb)', ['tester', JSON.stringify([{ ...imported[0], authorization_no: '5', address: '青森県十和田市1-2' }])]), /氏名.*住所が同じ/)
      assert.equal((await db.query('select count(*)::int as count from flexcon_authorizations')).rows[0].count, 4)
      assert.deepEqual(errors, [])
      if (process.env.QA_ARTIFACTS) {
        fs.mkdirSync(process.env.QA_ARTIFACTS, { recursive: true })
        await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `authorization-address-${width}.png`) })
      }
      await page.getByRole('button', { name: '検査記録', exact: true }).click()
      await page.getByRole('button', { name: '追加', exact: true }).click()
      const picker = page.getByRole('combobox', { name: '生産者名', exact: true })
      await picker.fill('山田太郎')
      const candidates = page.getByRole('listbox').getByRole('option')
      await candidates.filter({ hasText: '青森県十和田市7-8' }).waitFor()
      assert.equal(await candidates.count(), 3)
      await candidates.filter({ hasText: '青森県十和田市7-8' }).click()
      await picker.click()
      assert.equal(await candidates.filter({ hasText: '青森県十和田市7-8' }).getAttribute('aria-selected'), 'true')
      assert.equal(await candidates.filter({ hasText: '青森県十和田市1-2' }).getAttribute('aria-selected'), 'false')
      assert.deepEqual(errors, [])
      console.log(`Authorization namesake add, edit, and import passed at ${width}px`)
    } finally {
      await context.close()
      await db.close()
    }
  }
} finally {
  await browser.close()
}
