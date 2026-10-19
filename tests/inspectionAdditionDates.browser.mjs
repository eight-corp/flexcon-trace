import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { chromium } from 'playwright'

const root = path.resolve('dist')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const db = new PGlite()
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' })
    const errors = []
    try {
      await db.exec(fs.readFileSync('tests/fixtures/inspectionDatabase.sql', 'utf8'))
      const original = fs.readFileSync('supabase/migrations/202609070007_inspection_registration_summary.sql', 'utf8')
      const start = original.indexOf('create or replace function public.flexcon_split_inspection_paper_bags(')
      assert.ok(start >= 0)
      await db.exec(original.slice(start, original.indexOf('$$;', start) + 3))
      await db.exec(fs.readFileSync('supabase/migrations/202609290001_consolidate_inspection_authorizations.sql', 'utf8'))
      await db.exec("alter table flexcon_inspection_flexcons add column certificate_print_count integer not null default 0; insert into flexcon_inspection_options(option_type,name) values ('brand_aomori','Rice')")
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://inspection-dates.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.join(root, pathname === '/' ? 'index.html' : pathname)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      // All writes are confined to this disposable database; production requests are blocked.
      await context.route('**/rest/v1/**', async route => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        let body = []
        try {
          if (resource === 'rpc/business_session') {
            body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'admin' } }
          } else if (['rpc/flexcon_add_inspection_group_with_warehouse', 'rpc/flexcon_append_inspection_registration'].includes(resource)) {
            const params = route.request().postDataJSON()
            const keys = Object.keys(params)
            assert.ok(keys.every(key => /^p_[a-z_]+$/.test(key)))
            body = (await db.query(`select public.${resource.slice(4)}(${keys.map((key, i) => `${key} => $${i + 1}`).join(',')}) as result`, keys.map(key => params[key]))).rows[0].result
          } else if (resource.startsWith('rpc/')) {
            assert.equal(resource, 'rpc/flexcon_get_undo_status', `Unexpected RPC: ${resource}`)
            body = { operation_id: null }
          } else if (/^flexcon_inspection_(registrations|flexcons|paper_bags|options|weights)$|^flexcon_authorizations$/.test(resource)) {
            body = (await db.query(`select * from public.${resource}`)).rows
            for (const row of body) for (const field of ['purchase_date', 'inspection_date']) {
              if (row[field] instanceof Date) row[field] = row[field].toISOString().slice(0, 10)
            }
          }
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
        } catch (error) {
          errors.push(error.message)
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: error.message }) })
        }
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.clock.setFixedTime('2026-10-19T23:58:00+09:00')
      await page.goto('https://inspection-dates.test/')
      await page.getByRole('button', { name: '検査記録', exact: true }).click()
      await page.locator('.inspection-summary-table tbody tr').first().waitFor()

      const assertDates = async (form, purchase, inspection = purchase) => {
        const values = await form.locator('input[type="date"]').evaluateAll(inputs => inputs.map(input => input.value))
        assert.deepEqual(values, [purchase, inspection])
      }
      const heading = page.locator('.inspection-summary-heading')
      // Leave the mounted list open over midnight, without reloading the browser.
      await page.clock.setFixedTime('2026-10-20T00:02:00+09:00')
      await heading.getByRole('button', { name: '追加', exact: true }).click()
      const form = page.locator('form.inspection-summary-add')
      await assertDates(form, '2026-10-20')
      await form.getByLabel('仕切書№', { exact: true }).fill('Retained draft')
      await heading.getByRole('button', { name: '閉じる', exact: true }).click()
      await page.clock.setFixedTime('2026-10-21T00:02:00+09:00')
      await heading.getByRole('button', { name: '追加', exact: true }).click()
      await assertDates(form, '2026-10-21')
      assert.equal(await form.getByLabel('仕切書№', { exact: true }).inputValue(), 'Retained draft')
      await form.getByRole('combobox', { name: '生産者名', exact: true }).fill('New Producer')
      await form.getByRole('option').filter({ hasText: 'No. 2' }).click()
      await form.getByLabel(/^検査場所/).selectOption('B')
      await form.getByLabel(/^銘柄/).selectOption('Rice')
      await form.getByLabel('推フレ数', { exact: true }).fill('1')
      await form.getByRole('button', { name: '追加', exact: true }).click()
      await page.locator('.producer-inspection-page').waitFor()
      const savedDates = async settlement => (await db.query(`
        select purchase_date::text, inspection_date::text from flexcon_inspection_flexcons where settlement_no=$1
        union all select purchase_date::text, inspection_date::text from flexcon_inspection_paper_bags where settlement_no=$1
      `, [settlement])).rows
      assert.deepEqual(await savedDates('Retained draft'), [{ purchase_date: '2026-10-21', inspection_date: '2026-10-21' }])

      // The same long-lived detail view must use the current local date for every kind.
      for (const [index, kind] of ['standard', 'bulk', 'paper'].entries()) {
        const date = `2026-10-${22 + index}`
        await page.clock.setFixedTime(`${date}T00:02:00+09:00`)
        const section = page.locator('.inspection-detail-section').nth(index)
        await section.getByRole('button', { name: '追加', exact: true }).click()
        const addition = page.locator('.inspection-detail-add-form')
        await assertDates(addition, date)
        await addition.getByLabel('仕切書№', { exact: true }).fill(kind)
        if (kind === 'bulk') await addition.getByLabel('バラ（kg）', { exact: true }).fill('75')
        if (kind === 'paper') {
          await addition.getByLabel('紙袋数', { exact: true }).fill('5')
          // Explicitly chosen dates must not be replaced at submission, even after midnight.
          const dateFields = addition.locator('.japanese-date-input > input[type="text"]')
          await dateFields.nth(0).fill('令和8年10月10日')
          await dateFields.nth(1).fill('令和8年10月11日')
          await addition.getByLabel('仕切書№', { exact: true }).focus()
          await page.clock.setFixedTime('2026-10-25T00:02:00+09:00')
          await assertDates(addition, '2026-10-10', '2026-10-11')
        }
        await addition.getByRole('button', { name: '追加', exact: true }).click()
        await addition.waitFor({ state: 'hidden' })
        assert.deepEqual(await savedDates(kind), [{ purchase_date: kind === 'paper' ? '2026-10-10' : date, inspection_date: kind === 'paper' ? '2026-10-11' : date }])
      }
      assert.deepEqual(errors, [])
      console.log(`Inspection addition dates ${width}px: midnight, reopening, all detail kinds and explicit dates passed`)
    } finally {
      await context.close()
      await db.close()
    }
  }
} finally {
  await browser.close()
}
