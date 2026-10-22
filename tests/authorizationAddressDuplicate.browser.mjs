import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve('dist')
const artifacts = process.env.QA_ARTIFACTS || process.argv[2]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 1280, 390]) {
    const db = new PGlite()
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    const errors = []
    let writes = 0
    let failNextUpdate = false
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
            body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: width === 1440 ? 'admin' : 'operator' } }
          } else if (resource === 'flexcon_authorizations') {
            body = (await db.query('select * from flexcon_authorizations')).rows
          } else if (['rpc/flexcon_add_authorization', 'rpc/flexcon_update_authorization'].includes(resource)) {
            if (resource === 'rpc/flexcon_update_authorization' && failNextUpdate) {
              failNextUpdate = false
              return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'テスト通信エラー' }) })
            }
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
      assert.equal(await rows.getByRole('button', { name: /を編集$/ }).count(), 3)
      await secondRow.locator('td').nth(5).dispatchEvent('dblclick')
      assert.equal(await page.locator('.authorization-cell-editor').count(), 0)
      assert.equal(await dialog.count(), 0)
      const edit = page.getByRole('button', { name: '委任状№2を編集', exact: true })
      const editBox = await edit.boundingBox()
      assert.ok(editBox.x >= 0 && editBox.x + editBox.width <= width, 'Edit stays visible without horizontal scrolling')
      await edit.click()
      await dialog.getByRole('heading', { name: '委任状情報を編集', exact: true }).waitFor()
      const modalBox = await dialog.boundingBox()
      const undoBox = await page.locator('.global-undo-button').boundingBox()
      assert.ok(undoBox.x + undoBox.width <= modalBox.x || undoBox.x >= modalBox.x + modalBox.width || undoBox.y + undoBox.height <= modalBox.y || undoBox.y >= modalBox.y + modalBox.height, 'Global Undo never covers the editor')
      assert.equal(await page.locator('.producer-inspection-page').count(), 0)
      assert.equal(await dialog.getByLabel('№', { exact: true }).inputValue(), '2')
      assert.equal(await dialog.getByLabel('氏名', { exact: true }).inputValue(), '山田太郎')
      assert.equal(await dialog.getByLabel('住所', { exact: true }).inputValue(), '青森県十和田市3-4')
      await dialog.getByLabel('電話番号', { exact: true }).fill('cancelled')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal(writes, 2)
      await edit.click()
      assert.equal(await dialog.getByLabel('電話番号', { exact: true }).inputValue(), '')
      await dialog.getByLabel('№', { exact: true }).fill('1')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: 'すでに登録されています' }).waitFor()
      assert.equal(writes, 2)
      await dialog.getByLabel('№', { exact: true }).fill('2')
      await dialog.getByLabel('住所', { exact: true }).fill('青森県十和田市1-2')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: '住所が同じ委任状' }).waitFor()
      assert.equal(writes, 2)
      await dialog.getByLabel('住所', { exact: true }).fill('青森県十和田市7-8')
      await dialog.getByLabel('電話番号', { exact: true }).fill('0123-45-6789')
      await dialog.getByLabel('備考', { exact: true }).fill('編集ボタンから更新')
      await dialog.getByRole('switch', { name: '種子購入伝票', exact: true }).click()
      if (artifacts) {
        fs.mkdirSync(artifacts, { recursive: true })
        await page.screenshot({ path: path.join(artifacts, `authorization-edit-dialog-${width}.png`) })
      }
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      assert.equal(writes, 3)
      const edited = (await db.query("select * from flexcon_authorizations where authorization_no='2'")).rows[0]
      assert.equal(edited.address, '青森県十和田市7-8')
      assert.equal(edited.phone, '0123-45-6789')
      assert.equal(edited.notes, '編集ボタンから更新')
      assert.equal(edited.seed_purchase_slip, true)
      assert.equal((await db.query("select address from flexcon_authorizations where authorization_no='1'")).rows[0].address, '青森県十和田市1-2')
      await edit.click()
      await dialog.getByLabel('電話番号', { exact: true }).fill('0987-65-4321')
      failNextUpdate = true
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: 'テスト通信エラー' }).waitFor()
      assert.equal(await dialog.getByLabel('電話番号', { exact: true }).inputValue(), '0987-65-4321')
      assert.equal(writes, 3)
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      assert.equal(writes, 4)

      // Import follows the same database rule and remains atomic on duplicates.
      const imported = [{ authorization_no: '4', full_name: '山田太郎', address: '青森県十和田市9-10' }]
      const result = await db.query('select flexcon_import_authorizations($1,$2::jsonb) as result', ['tester', JSON.stringify(imported)])
      assert.equal(result.rows[0].result.inserted, 1)
      await assert.rejects(db.query('select flexcon_import_authorizations($1,$2::jsonb)', ['tester', JSON.stringify([{ ...imported[0], authorization_no: '5', address: '青森県十和田市1-2' }])]), /氏名.*住所が同じ/)
      assert.equal((await db.query('select count(*)::int as count from flexcon_authorizations')).rows[0].count, 4)
      assert.deepEqual(errors, [])
      if (artifacts) {
        await page.screenshot({ path: path.join(artifacts, `authorization-address-${width}.png`) })
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
