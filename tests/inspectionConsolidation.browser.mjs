import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { chromium } from 'playwright'

const root = path.resolve('dist')
async function createDatabase() {
  const db = new PGlite()
  await db.exec(fs.readFileSync('tests/fixtures/inspectionDatabase.sql', 'utf8'))
  const original = fs.readFileSync('supabase/migrations/202609070007_inspection_registration_summary.sql', 'utf8')
  const start = original.indexOf('create or replace function public.flexcon_split_inspection_paper_bags(')
  await db.exec(original.slice(start, original.indexOf('$$;', start) + 3))
  for (const [file, name] of [
    ['202609080002_separate_standard_bulk_numbers.sql', 'flexcon_save_inspection_flexcon'],
    ['202609050010_inspection_officers.sql', 'flexcon_save_inspection_paper_bags'],
  ]) {
    const sql = fs.readFileSync(`supabase/migrations/${file}`, 'utf8')
    const offset = sql.indexOf(`create or replace function public.${name}(`)
    assert.ok(offset >= 0)
    await db.exec(sql.slice(offset, sql.indexOf('$$;', offset) + 3))
  }
  await db.exec(fs.readFileSync('supabase/migrations/202609290001_consolidate_inspection_authorizations.sql', 'utf8'))
  await db.exec(fs.readFileSync('supabase/migrations/202609290002_fill_missing_inspection_metadata.sql', 'utf8'))
  await db.exec("insert into flexcon_inspection_options(option_type,name) values ('brand_aomori','Rice'),('grade','1等'),('grade','2等'),('inspector','Tester'),('inspector','Other')")
  return db
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const db = await createDatabase()
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
            assert.ok(['flexcon_add_inspection_group_with_warehouse', 'flexcon_save_inspection_detail_with_settlement', 'flexcon_set_inspection_registration_metadata'].includes(fn))
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
      assert.match(await table.locator('thead th').last().innerText(), /検査状況/)
      assert.equal(await table.locator('tbody tr').first().locator('td').last().innerText(), '未完了')
      const heading = page.locator('.inspection-summary-heading')
      const addButton = heading.getByRole('button', { name: '追加', exact: true })
      const descriptionBox = await heading.locator('p').boundingBox()
      const addBox = await addButton.boundingBox()
      assert.ok(addBox.x >= descriptionBox.x + descriptionBox.width)
      assert.ok(addBox.height <= 34)
      const before = (await db.query('select count(*)::integer as count from flexcon_inspection_registrations')).rows[0].count
      await page.getByRole('button', { name: '追加', exact: true }).click()
      const form = page.locator('form.inspection-summary-add')
      await form.getByRole('combobox', { name: '生産者名', exact: true }).fill('Producer')
      await form.getByRole('option').filter({ hasText: 'No. 1' }).click()
      await form.getByLabel('仕切書№', { exact: true }).fill(`UI-${width}`)
      await form.getByLabel(/^検査場所/).selectOption('B')
      await form.getByLabel(/^銘柄/).selectOption('Rice')
      await form.getByLabel('推フレ数', { exact: true }).fill('18')
      await form.getByLabel('バラ（kg）', { exact: true }).fill('50')
      await form.getByRole('button', { name: '追加', exact: true }).click()
      await page.locator('.producer-inspection-page').waitFor()
      assert.equal((await db.query('select count(*)::integer as count from flexcon_inspection_registrations')).rows[0].count, before)
      assert.ok(await page.getByRole('textbox', { name: '仕切り書', exact: true }).count() >= 3)
      const detailPage = page.locator('.producer-inspection-page')
      const producerHeading = detailPage.locator('.producer-inspection-heading')
      const headingTop = (await producerHeading.boundingBox()).y
      await detailPage.evaluate(el => { el.scrollTop = el.scrollHeight })
      assert.ok(await detailPage.evaluate(el => el.scrollTop) > 0)
      assert.ok(Math.abs((await producerHeading.boundingBox()).y - headingTop) <= 1)
      assert.equal(await producerHeading.locator('h1').innerText(), 'Producer')
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-sticky-producer-${width}.png`) })
      await detailPage.evaluate(el => { el.scrollTop = 0 })
      const detailTables = page.locator('.inspection-detail-table')
      const standardRows = detailTables.first().locator('tbody tr')
      const firstRow = standardRows.nth(0)
      const secondRow = standardRows.nth(1)
      const settlement = firstRow.getByRole('textbox', { name: '仕切り書', exact: true })
      const secondSettlement = secondRow.getByRole('textbox', { name: '仕切り書', exact: true })
      const purchase = firstRow.getByRole('textbox', { name: '仕入日', exact: true })
      const inspection = firstRow.getByRole('textbox', { name: '検査日', exact: true })
      const detailId = (await firstRow.getAttribute('id')).replace('inspection-record-', '')
      const originalDetails = (await db.query('select id,quantity_kg,grade,moisture from flexcon_inspection_flexcons order by id')).rows
      const focusAt = async (field, position) => field.evaluate((el, pos) => { el.focus(); el.setSelectionRange(pos, pos) }, position)
      const focused = async (field) => assert.equal(await field.evaluate(el => el === document.activeElement), true)
      const endOf = async (field) => (await field.inputValue()).length

      await focusAt(settlement, 1)
      await settlement.press('ArrowLeft')
      await focused(settlement)
      assert.equal(await settlement.evaluate(el => el.selectionStart), 0)
      await settlement.press('ArrowLeft')
      await focused(purchase)
      await purchase.press('End')
      await purchase.press('ArrowRight')
      await focused(settlement)
      await focusAt(settlement, 1)
      await settlement.press('ArrowDown')
      await focused(settlement)
      await focusAt(settlement, await endOf(settlement))
      await settlement.press('ArrowDown')
      await focused(secondSettlement)
      await focusAt(secondSettlement, 1)
      await secondSettlement.press('ArrowUp')
      await focused(secondSettlement)
      await focusAt(secondSettlement, 0)
      await secondSettlement.press('ArrowUp')
      await focused(settlement)
      await settlement.press('End')
      await settlement.press('ArrowRight')
      await focused(inspection)
      await settlement.evaluate(el => { el.focus(); el.setSelectionRange(0, el.value.length) })
      await settlement.press('ArrowRight')
      await focused(settlement)

      const quantity = firstRow.getByRole('textbox', { name: '数量（kg）', exact: true })
      const secondQuantity = secondRow.getByRole('textbox', { name: '数量（kg）', exact: true })
      const beforeQuantity = await quantity.inputValue()
      await focusAt(quantity, 0)
      await quantity.press('ArrowUp')
      await focused(quantity)
      assert.equal(await quantity.inputValue(), beforeQuantity)
      await focusAt(quantity, await endOf(quantity))
      await quantity.press('ArrowDown')
      await focused(secondQuantity)
      assert.equal(await quantity.inputValue(), beforeQuantity)
      await focusAt(quantity, 0)
      await quantity.press('ArrowLeft')
      const brand = firstRow.getByRole('combobox', { name: '銘柄', exact: true })
      await focused(brand)
      const beforeBrand = await brand.inputValue()
      await brand.press('ArrowRight')
      await focused(quantity)
      assert.equal(await brand.inputValue(), beforeBrand)
      const grade = firstRow.getByRole('combobox', { name: '等級', exact: true })
      await grade.focus()
      await grade.press('ArrowRight')
      await focused(grade) // The disabled reason field and delete button are skipped.
      await focusAt(firstRow.getByRole('textbox', { name: '年度', exact: true }), 0)
      await page.keyboard.press('ArrowDown')
      await focused(firstRow.getByRole('textbox', { name: '年度', exact: true }))
      assert.equal(await detailTables.locator('input[type="number"]').count(), 0)

      for (const tableIndex of [1, 2]) {
        const row = detailTables.nth(tableIndex).locator('tbody tr').first()
        const field = row.getByRole('textbox', { name: tableIndex === 1 ? '数量（kg）' : '数量（袋）', exact: true })
        const originalValue = await field.inputValue()
        await focusAt(field, await endOf(field))
        await field.press('ArrowRight')
        await focused(row.getByRole('textbox', { name: '水分', exact: true }))
        assert.equal(await field.inputValue(), originalValue)
      }
      assert.deepEqual((await db.query('select id,quantity_kg,grade,moisture from flexcon_inspection_flexcons order by id')).rows, originalDetails)
      const quantitySaved = page.waitForResponse(response => {
        if (!response.url().endsWith('/rpc/flexcon_save_inspection_detail_with_settlement')) return false
        const params = response.request().postDataJSON()
        return params.p_detail_id === detailId && params.p_quantity === 1050
      })
      await quantity.fill('1050')
      await quantitySaved
      assert.equal((await db.query('select quantity_kg from flexcon_inspection_flexcons where id=$1::uuid', [detailId])).rows[0].quantity_kg, 1050)
      const moisture = firstRow.getByRole('textbox', { name: '水分', exact: true })
      const moistureSaved = page.waitForResponse(response => {
        if (!response.url().endsWith('/rpc/flexcon_save_inspection_detail_with_settlement')) return false
        const params = response.request().postDataJSON()
        return params.p_detail_id === detailId && params.p_moisture === 15.5
      })
      await moisture.fill('15.5')
      await moistureSaved
      assert.equal(Number((await db.query('select moisture from flexcon_inspection_flexcons where id=$1::uuid', [detailId])).rows[0].moisture), 15.5)
      const batch = page.locator('.inspection-batch-metadata-form')
      const beforeBatch = (await db.query('select * from flexcon_inspection_flexcons order by id')).rows
      await batch.getByPlaceholder('変更なし', { exact: true }).fill('令和8年10月1日')
      await batch.getByPlaceholder('変更なし', { exact: true }).press('Tab')
      await batch.getByLabel(/^検査員/).selectOption('Tester')
      await batch.getByLabel(/^検査場所/).selectOption('A')
      await batch.getByLabel(/^等級/).selectOption('1等')
      const batchApplied = page.waitForResponse(response => response.url().endsWith('/rpc/flexcon_set_inspection_registration_metadata'))
      await moisture.fill('16.4')
      // Submit without blurring the edited detail to exercise the unsaved draft flush.
      await batch.evaluate(form => form.requestSubmit())
      await batchApplied
      await page.getByText(/未設定の検査日・検査員・検査場所・等級に反映しました/).waitFor({ state: 'attached' })
      const afterBatch = (await db.query('select * from flexcon_inspection_flexcons order by id')).rows
      for (const original of beforeBatch) {
        const saved = afterBatch.find(row => row.id === original.id)
        assert.equal(saved.inspection_location, original.inspection_location)
        assert.deepEqual(saved.inspection_date, original.inspection_date ?? new Date('2026-10-01'))
        assert.equal(saved.grade, original.grade || '1等')
        assert.equal(saved.inspector_name, original.inspector_name || 'Tester')
        assert.equal(saved.warehouse_id, original.warehouse_id)
        assert.equal(saved.settlement_no, original.settlement_no)
      }
      assert.equal(Number(afterBatch.find(row => row.id === detailId).moisture), 16.4)
      const paperAfterBatch = (await db.query('select * from flexcon_inspection_paper_bags')).rows[0]
      assert.equal(paperAfterBatch.inspection_location, 'B')
      assert.equal(paperAfterBatch.inspector_name, 'Tester')
      assert.equal(paperAfterBatch.grade, '1等')
      await batch.getByPlaceholder('変更なし', { exact: true }).fill('令和8年10月2日')
      await batch.getByPlaceholder('変更なし', { exact: true }).press('Tab')
      await batch.getByLabel(/^検査員/).selectOption('Other')
      await batch.getByLabel(/^検査場所/).selectOption('B')
      await batch.getByLabel(/^等級/).selectOption('2等')
      const repeatedBatch = page.waitForResponse(response => response.url().endsWith('/rpc/flexcon_set_inspection_registration_metadata'))
      await batch.getByRole('button', { name: 'まとめて反映', exact: true }).click()
      await repeatedBatch
      assert.deepEqual((await db.query('select * from flexcon_inspection_flexcons order by id')).rows, afterBatch)
      assert.deepEqual((await db.query('select * from flexcon_inspection_paper_bags')).rows[0], paperAfterBatch)
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-consolidated-detail-${width}.png`) })
      await page.getByRole('button', { name: '検査記録へ戻る', exact: true }).click()
      await table.locator('tbody tr').first().waitFor()
      assert.equal(await table.locator('tbody tr').count(), 1)
      assert.match(await table.locator('tbody tr').first().innerText(), new RegExp(`UI-${width}`))
      assert.equal(await table.locator('tbody tr').first().locator('td').last().innerText(), '未完了')
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-consolidated-list-${width}.png`) })

      // Confirm all three detail kinds contribute to the binary completion status.
      await db.exec("update flexcon_inspection_flexcons set inspection_date='2026-09-29', inspector_name='Tester', grade='1等', moisture=15; update flexcon_inspection_paper_bags set inspection_date='2026-09-29', inspector_name='Tester', grade='1等', moisture=15")
      const statusCell = table.locator('tbody tr').first().locator('td').last()
      const reloadList = async () => {
        await page.reload()
        await page.getByRole('button', { name: '検査記録', exact: true }).click()
        await table.locator('tbody tr').first().waitFor()
      }
      await reloadList()
      assert.equal(await statusCell.innerText(), '完了')
      for (const [detailTable, condition] of [
        ['flexcon_inspection_flexcons', "record_kind='standard' and flexcon_no=1"],
        ['flexcon_inspection_flexcons', "record_kind='bulk'"],
        ['flexcon_inspection_paper_bags', 'true'],
      ]) {
        await db.exec(`update ${detailTable} set moisture=null where ${condition}`)
        await reloadList()
        assert.equal(await statusCell.innerText(), '未完了')
        await db.exec(`update ${detailTable} set moisture=15 where ${condition}`)
      }
      await reloadList()
      assert.equal(await statusCell.innerText(), '完了')
      await page.getByRole('button', { name: '検査状況', exact: true }).click()
      assert.equal(await table.locator('tbody tr').count(), 1)
      if (process.env.QA_ARTIFACTS) {
        await statusCell.scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-completion-${width}.png`) })
      }
      assert.deepEqual(errors, [])
      console.log(`PASS ${width}px: additions, navigation, completion, sticky heading and missing-only batch settings with unsaved edits preserved`)
    } finally { await context.close(); await db.close() }
  }
} finally {
  await browser.close()
}
