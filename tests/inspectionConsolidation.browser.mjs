import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { chromium } from 'playwright'

const db = new PGlite()
const root = path.resolve('dist')
await db.exec(fs.readFileSync('tests/fixtures/inspectionDatabase.sql', 'utf8'))
const original = fs.readFileSync('supabase/migrations/202609070007_inspection_registration_summary.sql', 'utf8')
const start = original.indexOf('create or replace function public.flexcon_split_inspection_paper_bags(')
await db.exec(original.slice(start, original.indexOf('$$;', start) + 3))
await db.exec(fs.readFileSync('supabase/migrations/202609290001_consolidate_inspection_authorizations.sql', 'utf8'))
await db.exec("insert into flexcon_inspection_options(option_type,name) values ('brand_aomori','Rice')")
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    const errors = []
    try {
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', (route) => route.abort())
      await context.route('https://inspection.test/**', (route) => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.join(root, pathname === '/' ? 'index.html' : pathname)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      // Every database operation goes to an isolated PostgreSQL instance, never production.
      await context.route('**/rest/v1/**', async (route) => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        let body = []
        try {
          if (resource === 'rpc/business_session') {
            body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'admin' } }
          } else if (resource.startsWith('rpc/')) {
            const fn = resource.slice(4)
            assert.equal(fn, 'flexcon_add_inspection_group_with_warehouse')
            const params = route.request().postDataJSON()
            const keys = Object.keys(params)
            assert.ok(keys.every((key) => /^p_[a-z_]+$/.test(key)))
            body = (await db.query(`select public.${fn}(${keys.map((key, i) => `${key} => $${i + 1}`).join(',')}) as result`, keys.map((key) => params[key]))).rows[0].result
          } else if (/^flexcon_inspection_(registrations|flexcons|paper_bags|options|weights)$|^flexcon_authorizations$/.test(resource)) {
            body = (await db.query(`select * from public.${resource}`)).rows
          }
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
        } catch (error) {
          errors.push(error.message)
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: error.message }) })
        }
      })
      const page = await context.newPage()
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto('https://inspection.test/')
      await page.getByRole('button', { name: '検査記録', exact: true }).click()
      const table = page.locator('.inspection-summary-table')
      await table.locator('tbody tr').first().waitFor()
      assert.equal(await table.locator('tbody tr').count(), 1)
      assert.match(await table.locator('tbody tr').first().innerText(), /OLD-A、OLD-B/)
      assert.match(await table.locator('tbody tr').first().innerText(), /1等、未入力/)
      const before = (await db.query('select count(*)::integer as count from flexcon_inspection_registrations')).rows[0].count
      await page.getByRole('button', { name: '追加', exact: true }).click()
      const form = page.locator('form.inspection-summary-add')
      await form.getByRole('combobox', { name: '生産者名', exact: true }).fill('Producer')
      await form.getByRole('option').filter({ hasText: 'No. 1' }).click()
      await form.getByLabel('仕切書№', { exact: true }).fill(`UI-${width}`)
      await form.getByLabel(/^検査場所/).selectOption('B')
      await form.getByLabel(/^銘柄/).selectOption('Rice')
      await form.getByLabel('推フレ数', { exact: true }).fill('1')
      await form.getByRole('button', { name: '追加', exact: true }).click()
      await page.locator('.producer-inspection-page').waitFor()
      assert.equal((await db.query('select count(*)::integer as count from flexcon_inspection_registrations')).rows[0].count, before)
      assert.ok(await page.getByRole('textbox', { name: '仕切り書', exact: true }).count() >= 3)
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-consolidated-detail-${width}.png`) })
      await page.getByRole('button', { name: '検査記録へ戻る', exact: true }).click()
      await table.locator('tbody tr').first().waitFor()
      assert.equal(await table.locator('tbody tr').count(), 1)
      assert.match(await table.locator('tbody tr').first().innerText(), new RegExp(`UI-${width}`))
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-consolidated-list-${width}.png`) })
      assert.deepEqual(errors, [])
      console.log(`PASS ${width}px: one authorization row, existing registration reused, separate detail metadata, isolated database`)
    } finally { await context.close() }
  }
} finally {
  await browser.close()
  await db.close()
}
