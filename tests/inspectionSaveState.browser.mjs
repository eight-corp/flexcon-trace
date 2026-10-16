import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { undoDatabase } from './fixtures/undoDatabase.mjs'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const { db, rpc } = await undoDatabase()
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    const errors = []
    let nextGate
    const holdNextSave = () => {
      assert.equal(nextGate, undefined)
      let arrived, release
      const observed = new Promise(resolve => { arrived = resolve })
      const proceed = new Promise(resolve => { release = resolve })
      nextGate = { arrived, proceed }
      return { observed, release }
    }
    try {
      const call = (name, args) => rpc('tester', name, { p_worker_id: 'tester', ...args })
      await db.exec(`insert into flexcon_inspection_options(option_type,name) values
        ('warehouse','Test Place'),('location','Test Place'),('brand_aomori','Rice'),
        ('inspector','Tester'),('inspector','Other'),('grade','1等') on conflict(option_type,name) do nothing`)
      const producer = await call('flexcon_add_authorization', {
        p_authorization_no: '1', p_full_name: 'Save Test Producer', p_seed_purchase_slip: false,
        p_farming_plan: false, p_prefecture: '青森県', p_municipality: 'Test', p_address: 'Test',
        p_phone: '', p_crop_type: '', p_feed_rice_variety: '', p_notes: '',
      })
      const warehouse = (await db.query("select id from flexcon_inspection_options where option_type='warehouse' and name='Test Place'")).rows[0].id
      await call('flexcon_add_inspection_group_with_warehouse', {
        p_authorization_id: producer, p_fiscal_year: 8, p_purchase_date: '2026-10-16',
        p_inspection_date: '2026-10-16', p_inspection_location: 'Test Place', p_brand: 'Rice',
        p_flexcon_count: 1, p_paper_bag_count: 10, p_flexcon_quantity_kg: 1020,
        p_bulk_quantity_kg: 50, p_warehouse_id: warehouse, p_settlement_no: 'SAVED',
      })
      await db.exec(`update flexcon_inspection_flexcons set inspector_name='Tester',grade='1等',moisture=13;
        update flexcon_inspection_paper_bags set inspector_name='Tester',grade='1等',moisture=13;`)
      const flexcons = (await db.query('select id,record_kind from flexcon_inspection_flexcons order by flexcon_no')).rows
      const paper = (await db.query('select id from flexcon_inspection_paper_bags')).rows[0]
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://save-state.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.resolve('dist', pathname === '/' ? 'index.html' : `.${pathname}`)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      // All requests are intercepted; business writes use only the isolated database.
      await context.route('**/rest/v1/**', async route => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        try {
          let body
          if (resource === 'rpc/business_session') body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'operator' } }
          else if (resource.startsWith('rpc/')) {
            const fn = resource.slice(4)
            assert.match(fn, /^flexcon_[a-z_]+$/)
            if (fn === 'flexcon_save_inspection_detail_with_settlement' && nextGate) {
              const gate = nextGate
              nextGate = undefined
              gate.arrived(route.request().postDataJSON())
              const outcome = await gate.proceed
              if (outcome === 'fail') {
                await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'TEST_SAVE_FAILED' }) })
                return
              }
            }
            body = await rpc('tester', fn, route.request().postDataJSON())
          } else {
            assert.match(resource, /^flexcon_[a-z_]+$/)
            body = (await db.query(`select to_jsonb(t) data from public.${resource} t`)).rows.map(row => row.data)
          }
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
        } catch (error) {
          errors.push(error.message)
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: error.message }) })
        }
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.goto('https://save-state.test/')
      await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('button', { name: '検査記録', exact: true }).click()
      await page.locator('.inspection-summary-table tbody tr').first().click()
      const rowFor = id => page.locator(`#inspection-record-${id}`)
      const waitBold = id => page.locator(`#inspection-record-${id}.inspection-complete-row`).waitFor({ state: 'attached' })
      const notBold = async id => assert.equal(await rowFor(id).evaluate(el => el.classList.contains('inspection-complete-row')), false)
      for (const record of [...flexcons, paper]) {
        await waitBold(record.id)
        const row = rowFor(record.id)
        const table = record === paper ? 'flexcon_inspection_paper_bags' : 'flexcon_inspection_flexcons'
        const quantityField = record === paper ? 'bag_count' : 'quantity_kg'
        const quantity = row.getByRole('textbox', { name: record === paper ? '数量（袋）' : '数量（kg）', exact: true })
        const previous = Number((await db.query(`select ${quantityField} n from ${table} where id=$1`, [record.id])).rows[0].n)
        const gate = holdNextSave()
        await quantity.fill(String(previous + 1))
        await notBold(record.id)
        assert.equal((await gate.observed).p_detail_id, record.id) // Automatic save after two seconds, without blur.
        await notBold(record.id)
        assert.equal(Number((await db.query(`select ${quantityField} n from ${table} where id=$1`, [record.id])).rows[0].n), previous)
        gate.release()
        await waitBold(record.id)
        assert.equal(Number((await db.query(`select ${quantityField} n from ${table} where id=$1`, [record.id])).rows[0].n), previous + 1)
        await quantity.press('Enter')
        await waitBold(record.id)
        const inspector = row.getByRole('combobox', { name: '検査員', exact: true })
        await inspector.focus()
        const selection = holdNextSave()
        await inspector.selectOption('Other')
        assert.equal((await selection.observed).p_inspector_name, 'Other')
        await notBold(record.id)
        selection.release()
        await waitBold(record.id)
        const moisture = row.getByRole('textbox', { name: '水分', exact: true })
        for (const invalid of ['abc', '-', '.', '13..0', '13%', 'NaN', 'Infinity', '１３']) {
          await moisture.fill(invalid)
          assert.equal(await moisture.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(247, 179, 179)')
          await notBold(record.id)
        }
        await moisture.press('Enter')
        await page.getByText('水分は0から100の範囲で入力してください。', { exact: true }).waitFor({ state: 'attached' })
        assert.equal(await moisture.inputValue(), '１３')
        assert.equal(Number((await db.query(`select moisture from ${table} where id=$1`, [record.id])).rows[0].moisture), 13)
        await moisture.fill('')
        assert.equal(await moisture.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 241, 191)')
        await moisture.fill('16.1')
        assert.equal(await moisture.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(247, 179, 179)')
        await moisture.fill('16')
        assert.equal(await moisture.evaluate(el => el.classList.contains('moisture-high') || el.classList.contains('moisture-invalid')), false)
        await moisture.fill('13')
        await moisture.press('Enter')
        await waitBold(record.id)
      }
      const id = flexcons[0].id
      const row = rowFor(id)
      const settlement = row.getByRole('textbox', { name: '仕切り書', exact: true })
      const failed = holdNextSave()
      await settlement.fill('FAILED')
      await settlement.press('Enter')
      assert.equal((await failed.observed).p_settlement_no, 'FAILED')
      failed.release('fail')
      await page.getByText('TEST_SAVE_FAILED', { exact: true }).waitFor({ state: 'attached' })
      await notBold(id)
      assert.equal((await db.query('select settlement_no from flexcon_inspection_flexcons where id=$1', [id])).rows[0].settlement_no, 'SAVED')
      await settlement.fill('RETRY')
      await settlement.press('Enter')
      await waitBold(id)
      const quantity = row.getByRole('textbox', { name: '数量（kg）', exact: true })
      await quantity.fill('0')
      await quantity.press('Enter')
      await page.getByText('数量は1kg以上の整数で入力してください。', { exact: true }).waitFor({ state: 'attached' })
      await notBold(id)
      await quantity.fill('1021')
      await quantity.press('Enter')
      await waitBold(id)
      // A -> B -> A must stay unbold until the final A request succeeds.
      const first = holdNextSave()
      await settlement.fill('A')
      await settlement.press('Enter')
      await first.observed
      await settlement.fill('B')
      await settlement.press('Enter')
      await settlement.fill('A')
      await settlement.press('Enter')
      const second = holdNextSave()
      first.release()
      assert.equal((await second.observed).p_settlement_no, 'B')
      await notBold(id)
      assert.equal(await settlement.inputValue(), 'A')
      const third = holdNextSave()
      second.release()
      assert.equal((await third.observed).p_settlement_no, 'A')
      await notBold(id)
      third.release()
      await waitBold(id)
      assert.equal((await db.query('select settlement_no from flexcon_inspection_flexcons where id=$1', [id])).rows[0].settlement_no, 'A')
      const moisture = row.getByRole('textbox', { name: '水分', exact: true })
      const incomplete = holdNextSave()
      await moisture.fill('')
      await moisture.press('Enter')
      await incomplete.observed
      const incompleteSaved = page.waitForResponse(response => response.url().endsWith('/rpc/flexcon_save_inspection_detail_with_settlement') && response.request().postDataJSON().p_moisture === null)
      incomplete.release()
      await incompleteSaved
      assert.equal((await db.query('select moisture from flexcon_inspection_flexcons where id=$1', [id])).rows[0].moisture, null)
      await notBold(id)
      await moisture.fill('13')
      await moisture.press('Enter')
      await waitBold(id)
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-save-complete-${width}.png`) })
      assert.deepEqual(errors, [])
      console.log(`PASS inspection saved-row emphasis: debounce, in-flight, retry, validation, A/B/A, incomplete, all kinds ${width}px`)
    } finally { await context.close(); await db.close() }
  }
} finally { await browser.close() }
