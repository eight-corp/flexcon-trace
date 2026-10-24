import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { undoDatabase } from './fixtures/undoDatabase.mjs'
import { chromium } from 'playwright'

const root = path.resolve('dist')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1920, 1600, 1440, 390]) {
    const { db, rpc } = await undoDatabase()
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' })
    const errors = []
    try {
      for (const [type, name] of [['warehouse', 'B'], ['location', 'B'], ['brand_aomori', 'Rice'], ['brand_aomori', '飼料用玄米']]) {
        if ((await db.query('select 1 from flexcon_inspection_options where option_type=$1 and name=$2', [type, name])).rows.length) continue
        await rpc('admin', 'flexcon_save_inspection_option', { p_worker_id: 'admin', p_option_id: null, p_option_type: type, p_name: name })
      }
      await rpc('admin', 'flexcon_save_inspection_weights', { p_worker_id: 'admin', p_branded_rice_weight: 1035, p_feed_rice_weight: 1005 })
      await rpc('tester', 'flexcon_add_authorization', { p_worker_id: 'tester', p_authorization_no: '2', p_full_name: 'New Producer', p_seed_purchase_slip: false, p_farming_plan: false, p_prefecture: '青森県', p_municipality: '青森市', p_address: 'Test', p_phone: '', p_crop_type: '', p_feed_rice_variety: '', p_notes: '' })
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
            body = await rpc('tester', resource.slice(4), params)
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
      const assertMissing = async (field, expected) => assert.equal(await field.evaluate(input => getComputedStyle(input).backgroundColor === 'rgb(255, 241, 191)'), expected)
      const assertAmountsMissing = async (target, expected) => {
        for (const name of ['推フレ数', '紙袋数', 'バラ（kg）']) await assertMissing(target.getByLabel(name, { exact: true }), expected)
      }
      await assertMissing(form.getByRole('combobox', { name: '生産者名', exact: true }), true)
      await assertMissing(form.getByLabel('年度', { exact: true }), false)
      await assertMissing(form.getByLabel(/^検査場所/), true)
      await assertMissing(form.getByLabel(/^銘柄/), true)
      await assertAmountsMissing(form, true)
      await assertMissing(form.getByLabel('数量（kg/本）', { exact: true }), false)
      await assertMissing(form.getByLabel('仕切書№', { exact: true }), false)
      const purchaseInput = form.locator('.japanese-date-input > input[type="text"]').nth(0)
      const inspectionInput = form.locator('.japanese-date-input > input[type="text"]').nth(1)
      await assertMissing(purchaseInput, false)
      await form.getByLabel('年度', { exact: true }).fill('')
      await assertMissing(form.getByLabel('年度', { exact: true }), true)
      await form.getByLabel('年度', { exact: true }).fill('8')
      await assertMissing(form.getByLabel('年度', { exact: true }), false)
      await purchaseInput.fill('')
      await inspectionInput.fill('')
      await form.getByLabel('仕切書№', { exact: true }).focus()
      await assertMissing(purchaseInput, true)
      await assertMissing(inspectionInput, false)
      for (const name of ['推フレ数', '紙袋数', 'バラ（kg）']) {
        await form.getByLabel(name, { exact: true }).fill('1')
        await assertAmountsMissing(form, false)
        await form.getByLabel(name, { exact: true }).fill('0')
        await assertAmountsMissing(form, true)
      }
      fs.mkdirSync('../../artifacts/inspection-add-required', { recursive: true })
      await form.screenshot({ path: `../../artifacts/inspection-add-required/empty-${width}.png` })
      await form.getByLabel('仕切書№', { exact: true }).fill('Retained draft')
      await heading.getByRole('button', { name: '閉じる', exact: true }).click()
      await page.clock.setFixedTime('2026-10-21T00:02:00+09:00')
      await heading.getByRole('button', { name: '追加', exact: true }).click()
      await assertDates(form, '2026-10-21')
      assert.equal(await form.getByLabel('仕切書№', { exact: true }).inputValue(), 'Retained draft')
      await form.getByRole('combobox', { name: '生産者名', exact: true }).fill('Not a registered producer')
      await assertMissing(form.getByRole('combobox', { name: '生産者名', exact: true }), true)
      await form.getByRole('button', { name: '追加', exact: true }).click()
      await form.getByRole('alert').getByText('委任状一覧に登録されている生産者名を選択してください。', { exact: true }).waitFor()
      await form.getByRole('combobox', { name: '生産者名', exact: true }).fill('New Producer')
      await form.getByRole('option').filter({ hasText: 'No. 2' }).click()
      await assertMissing(form.getByRole('combobox', { name: '生産者名', exact: true }), false)
      await assertMissing(purchaseInput, false)
      await form.getByLabel(/^検査場所/).selectOption('B')
      await form.getByRole('button', { name: '追加', exact: true }).click()
      await form.getByRole('alert').getByText('銘柄を選択してください。', { exact: true }).waitFor()
      await assertMissing(form.getByLabel(/^銘柄/), true)
      assert.equal((await db.query('select count(*)::integer n from flexcon_inspection_registrations')).rows[0].n, 0)
      await form.getByLabel(/^銘柄/).selectOption('Rice')
      await assertMissing(form.getByLabel(/^検査場所/), false)
      await assertMissing(form.getByLabel(/^銘柄/), false)
      const quantity = form.getByLabel('数量（kg/本）', { exact: true })
      assert.equal(await quantity.inputValue(), '1,035')
      await form.getByLabel(/^銘柄/).selectOption('飼料用玄米')
      assert.equal(await quantity.inputValue(), '1,005')
      await form.getByLabel(/^銘柄/).selectOption('Rice')
      assert.equal(await quantity.inputValue(), '1,035')
      assert.equal(await quantity.evaluate(input => input.closest('label').previousElementSibling.textContent), '推フレ数')
      await form.getByLabel('推フレ数', { exact: true }).fill('1')
      await quantity.fill('')
      await assertMissing(quantity, true)
      await form.getByRole('button', { name: '追加', exact: true }).click()
      await form.getByRole('alert').getByText('推フレの数量は1kg以上の整数で入力してください。', { exact: true }).waitFor()
      assert.equal((await db.query('select count(*)::integer n from flexcon_inspection_registrations')).rows[0].n, 0)
      await quantity.fill('1080')
      await assertMissing(quantity, false)
      const assertFieldFits = async field => {
        const bounds = await field.boundingBox()
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, JSON.stringify(bounds))
      }
      await assertFieldFits(quantity)
      fs.mkdirSync('../../artifacts/inspection-add-quantity', { recursive: true })
      await form.screenshot({ path: `../../artifacts/inspection-add-quantity/summary-${width}.png` })
      await form.getByRole('button', { name: '追加', exact: true }).click()
      await page.locator('.producer-inspection-page').waitFor()
      const savedDates = async settlement => (await db.query(`
        select purchase_date::text, inspection_date::text from flexcon_inspection_flexcons where settlement_no=$1
        union all select purchase_date::text, inspection_date::text from flexcon_inspection_paper_bags where settlement_no=$1
      `, [settlement])).rows
      assert.deepEqual(await savedDates('Retained draft'), [{ purchase_date: '2026-10-21', inspection_date: '2026-10-21' }])
      assert.equal((await db.query("select quantity_kg from flexcon_inspection_flexcons where settlement_no='Retained draft'")).rows[0].quantity_kg, 1080)

      // The same long-lived detail view must use the current local date for every kind.
      for (const [index, kind] of ['standard', 'bulk', 'paper'].entries()) {
        const date = `2026-10-${22 + index}`
        await page.clock.setFixedTime(`${date}T00:02:00+09:00`)
        const section = page.locator('.inspection-detail-section').nth(index)
        await section.getByRole('button', { name: '追加', exact: true }).click()
        const addition = page.locator('.inspection-detail-add-form')
        await assertDates(addition, date)
        await assertAmountsMissing(addition, kind !== 'standard')
        await assertMissing(addition.getByLabel(/^検査場所/), false)
        await assertMissing(addition.getByLabel(/^銘柄/), false)
        await addition.getByLabel(/^検査場所/).selectOption('')
        await assertMissing(addition.getByLabel(/^検査場所/), true)
        await addition.getByLabel(/^検査場所/).selectOption('B')
        await assertMissing(addition.getByLabel(/^検査場所/), false)
        await addition.getByLabel(/^銘柄/).selectOption('')
        await assertMissing(addition.getByLabel(/^銘柄/), true)
        await addition.getByLabel(/^銘柄/).selectOption('Rice')
        await assertMissing(addition.getByLabel(/^銘柄/), false)
        assert.equal(await addition.getByLabel('数量（kg/本）', { exact: true }).inputValue(), '1,035', 'defaults use the master, not the existing 1080kg row')
        await addition.getByLabel('仕切書№', { exact: true }).fill(kind)
        if (kind === 'standard') {
          await addition.getByLabel(/^銘柄/).selectOption('飼料用玄米')
          assert.equal(await addition.getByLabel('数量（kg/本）', { exact: true }).inputValue(), '1,005')
          await addition.getByLabel('数量（kg/本）', { exact: true }).fill('1030')
          await addition.getByLabel('推フレ数', { exact: true }).fill('2')
          await assertFieldFits(addition.getByLabel('数量（kg/本）', { exact: true }))
          await addition.screenshot({ path: `../../artifacts/inspection-add-quantity/detail-${width}.png` })
        }
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
        await assertAmountsMissing(addition, false)
        await addition.getByRole('button', { name: '追加', exact: true }).click()
        await addition.waitFor({ state: 'hidden' })
        assert.deepEqual(await savedDates(kind), Array.from({ length: kind === 'standard' ? 2 : 1 }, () => ({ purchase_date: kind === 'paper' ? '2026-10-10' : date, inspection_date: kind === 'paper' ? '2026-10-11' : date })))
        if (kind === 'standard') assert.deepEqual((await db.query("select quantity_kg from flexcon_inspection_flexcons where settlement_no='standard'")).rows.map(row => row.quantity_kg), [1030, 1030])
        if (kind === 'bulk') assert.equal((await db.query("select quantity_kg from flexcon_inspection_flexcons where settlement_no='bulk'")).rows[0].quantity_kg, 75)
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
