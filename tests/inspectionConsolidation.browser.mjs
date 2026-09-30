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
  await db.exec(fs.readFileSync('supabase/migrations/202609290003_inspection_metadata_range_override.sql', 'utf8'))
  await db.exec('alter table flexcon_inspection_flexcons add column certificate_print_count integer not null default 0')
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
            assert.ok(['flexcon_add_inspection_group_with_warehouse', 'flexcon_save_inspection_detail_with_settlement', 'flexcon_set_inspection_registration_metadata_range'].includes(fn))
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
      assert.equal(await table.locator('tbody tr').count(), 2)
      assert.match(await table.locator('tbody tr').first().innerText(), /OLD-A/)
      assert.match(await table.locator('tbody tr').first().innerText(), /1等/)
      assert.equal(await table.locator('tbody tr').first().locator('td').nth(4).innerText(), '令和8年9月2日')
      assert.equal(await table.locator('tbody tr').nth(1).locator('td').nth(4).innerText(), '')
      assert.match(await table.locator('tbody tr').nth(1).innerText(), /OLD-B/)
      assert.match(await table.locator('tbody tr').nth(1).innerText(), /未入力/)
      assert.match(await table.locator('thead th').first().innerText(), /検査状況/)
      assert.match(await table.locator('thead th').nth(1).innerText(), /委任状/)
      assert.equal(await table.locator('thead th').last().innerText(), '操作')
      assert.equal(await table.locator('tbody tr').first().locator('td').first().innerText(), '未完了')
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
      assert.equal(await batch.getByLabel('上書きする').isChecked(), false)
      assert.equal(await batch.getByLabel('開始№', { exact: true }).isDisabled(), true)
      assert.equal(await batch.getByLabel(/^対象/).locator('option[value="bulk"]').count(), 0)
      const beforeBatch = (await db.query('select * from flexcon_inspection_flexcons order by id')).rows
      await batch.getByPlaceholder('変更なし', { exact: true }).fill('令和8年10月1日')
      await batch.getByPlaceholder('変更なし', { exact: true }).press('Tab')
      await batch.getByLabel(/^検査員/).selectOption('Tester')
      await batch.getByLabel(/^検査場所/).selectOption('A')
      await batch.getByLabel(/^等級/).selectOption('1等')
      const batchApplied = page.waitForResponse(response => response.url().endsWith('/rpc/flexcon_set_inspection_registration_metadata_range'))
      await moisture.fill('16.4')
      // Submit without blurring the edited detail to exercise the unsaved draft flush.
      await batch.evaluate(form => form.requestSubmit())
      await batchApplied
      await page.getByText(/件の明細の検査日・検査員・検査場所・等級を未設定のみ更新しました/).waitFor({ state: 'attached' })
      const afterBatch = (await db.query('select * from flexcon_inspection_flexcons order by id')).rows
      for (const original of beforeBatch) {
        const saved = afterBatch.find(row => row.id === original.id)
        if (original.record_kind === 'bulk') {
          assert.deepEqual(saved, original)
          continue
        }
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
      const repeatedBatch = page.waitForResponse(response => response.url().endsWith('/rpc/flexcon_set_inspection_registration_metadata_range'))
      await batch.getByRole('button', { name: 'まとめて反映', exact: true }).click()
      await repeatedBatch
      assert.deepEqual((await db.query('select * from flexcon_inspection_flexcons order by id')).rows, afterBatch)
      assert.deepEqual((await db.query('select * from flexcon_inspection_paper_bags')).rows[0], paperAfterBatch)

      await page.getByText(/0件の明細の検査日・検査員・検査場所・等級を未設定のみ更新しました/).waitFor({ state: 'attached' })
      await batch.getByLabel(/^対象/).selectOption('standard')
      await batch.getByLabel('開始№', { exact: true }).fill('2')
      await batch.getByLabel('終了№', { exact: true }).fill('3')
      await batch.getByLabel('上書きする').check()
      await batch.getByPlaceholder('変更なし', { exact: true }).fill('令和8年10月3日')
      await batch.getByPlaceholder('変更なし', { exact: true }).press('Tab')
      await batch.getByLabel(/^検査員/).selectOption('Other')
      await batch.getByLabel(/^検査場所/).selectOption('A')
      await batch.getByLabel(/^等級/).selectOption('2等')
      const rangeApplied = page.waitForResponse(response => response.url().endsWith('/rpc/flexcon_set_inspection_registration_metadata_range'))
      await batch.getByRole('button', { name: 'まとめて反映', exact: true }).click()
      await rangeApplied
      await page.getByText(/2件の明細の検査日・検査員・検査場所・等級を上書きしました/).waitFor({ state: 'attached' })
      const afterRange = (await db.query('select * from flexcon_inspection_flexcons order by id')).rows
      for (const original of afterBatch) {
        const saved = afterRange.find(row => row.id === original.id)
        if (original.record_kind !== 'standard' || original.flexcon_no < 2 || original.flexcon_no > 3) {
          assert.deepEqual(saved, original)
          continue
        }
        assert.equal(saved.inspector_name, 'Other')
        assert.equal(saved.grade, '2等')
        assert.equal(saved.inspection_location, 'A')
        assert.deepEqual(saved.inspection_date, new Date('2026-10-03'))
        for (const field of ['warehouse_id', 'settlement_no', 'quantity_kg', 'moisture', 'lot_number']) assert.deepEqual(saved[field], original[field])
      }
      assert.deepEqual((await db.query('select * from flexcon_inspection_paper_bags')).rows[0], paperAfterBatch)
      await batch.getByLabel(/^対象/).selectOption('paper')
      assert.equal(await batch.getByLabel('開始№', { exact: true }).inputValue(), '')
      assert.equal(await batch.getByLabel('終了№', { exact: true }).isDisabled(), true)
      await batch.getByLabel(/^検査場所/).selectOption('A')
      const paperApplied = page.waitForResponse(response => response.url().endsWith('/rpc/flexcon_set_inspection_registration_metadata_range'))
      await batch.getByRole('button', { name: 'まとめて反映', exact: true }).click()
      await paperApplied
      await page.getByText(/1件の明細の検査場所を上書きしました/).waitFor({ state: 'attached' })
      assert.deepEqual((await db.query('select * from flexcon_inspection_flexcons order by id')).rows, afterRange)
      const paperAfterRange = (await db.query('select * from flexcon_inspection_paper_bags')).rows[0]
      assert.equal(paperAfterRange.inspection_location, 'A')
      for (const field of ['grade', 'inspector_name', 'inspection_date', 'warehouse_id', 'bag_count', 'settlement_no']) assert.deepEqual(paperAfterRange[field], paperAfterBatch[field])
      await batch.getByLabel(/^対象/).selectOption('standard')
      await batch.getByLabel('開始№', { exact: true }).fill('2')
      await batch.getByLabel('終了№', { exact: true }).fill('3')
      const positions = await batch.evaluate(form => Array.from(form.children).map(el => {
        const rect = el.getBoundingClientRect()
        return rect.y + rect.height / 2
      }))
      assert.ok(Math.max(...positions) - Math.min(...positions) <= 1, 'all batch controls stay in one row')
      const batchBand = page.locator('.inspection-batch-metadata')
      if (width === 390) {
        assert.ok(await batchBand.evaluate(el => el.scrollWidth > el.clientWidth))
        await batchBand.evaluate(el => { el.scrollLeft = el.scrollWidth })
        const buttonBox = await batch.getByRole('button', { name: 'まとめて反映', exact: true }).boundingBox()
        assert.ok(buttonBox.x >= 0 && buttonBox.x + buttonBox.width <= width)
        if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-batch-range-end-${width}.png`) })
      }
      await batchBand.evaluate(el => { el.scrollLeft = 0 })
      await detailPage.evaluate(el => { el.scrollTop = 0 })
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-batch-range-${width}.png`) })
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-consolidated-detail-${width}.png`) })
      await page.getByRole('button', { name: '検査記録へ戻る', exact: true }).click()
      await table.locator('tbody tr').first().waitFor()
      await table.getByRole('cell', { name: '令和8年10月3日', exact: true }).waitFor()
      assert.equal(await table.locator('tbody tr').count(), 4)
      assert.match((await table.locator('tbody tr').allTextContents()).join(' '), new RegExp(`UI-${width}`))
      assert.equal(await table.locator('tbody tr').first().locator('td').first().innerText(), '完了')
      const dates = await table.locator('tbody tr td:nth-child(5)').allTextContents()
      assert.equal(new Set(dates).size, 4)
      const octoberRow = table.locator('tbody tr').filter({ has: page.getByRole('cell', { name: '令和8年10月3日', exact: true }) })
      assert.equal(await octoberRow.locator('td').first().innerText(), '未完了')
      assert.equal(await octoberRow.locator('td').nth(11).innerText(), '2本')
      assert.equal(await octoberRow.locator('td').nth(12).innerText(), '0袋')
      assert.equal(await octoberRow.locator('td').nth(13).innerText(), '0kg')
      assert.equal(await octoberRow.locator('td').nth(15).innerText(), '2,040kg')
      const totals = await table.locator('tbody').evaluate(el => Array.from(el.querySelectorAll('tr')).reduce((total, row) => {
        const number = index => Number(row.children[index].textContent.replace(/[^0-9.]/g, ''))
        return { standard: total.standard + number(11), paper: total.paper + number(12), bulk: total.bulk + number(13), kg: total.kg + number(14) + number(15) }
      }, { standard: 0, paper: 0, bulk: 0, kg: 0 }))
      assert.deepEqual(totals, { standard: 20, paper: 10, bulk: 50, kg: 1050 + 19 * 1020 + 300 + 50 })
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-list-date-groups-${width}.png`) })
      // Each date row opens every detail for the authorization, not just that date.
      for (const date of dates) {
        const dateCell = table.locator('tbody tr td:nth-child(5)').filter({ hasText: date })
        await dateCell.click()
        await page.locator('.producer-inspection-page').waitFor()
        await page.locator('.inspection-detail-table').first().locator('tbody tr').nth(19).waitFor()
        assert.equal(await page.locator('.inspection-detail-table').first().locator('tbody tr').count(), 20)
        assert.equal(await page.locator('.inspection-detail-table').nth(1).locator('tbody tr').count(), 1)
        assert.equal(await page.locator('.inspection-detail-table').nth(2).locator('tbody tr').count(), 1)
        assert.equal(await page.locator('.inspection-detail-table').getByRole('textbox', { name: '検査日', exact: true }).count(), 22)
        await page.getByRole('button', { name: '検査記録へ戻る', exact: true }).click()
        await dateCell.waitFor()
      }
      const dateTrigger = page.getByRole('button', { name: '検査日を絞り込む', exact: true })
      await dateTrigger.scrollIntoViewIfNeeded()
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await dateTrigger.click()
      await page.getByRole('searchbox', { name: '検査日を文字で絞り込む', exact: true }).fill('令和8年10月3日')
      await page.keyboard.press('Escape')
      assert.equal(await table.locator('tbody tr').count(), 1)
      await table.getByRole('cell', { name: '令和8年10月3日', exact: true }).click()
      await page.locator('.inspection-detail-table').first().locator('tbody tr').nth(19).waitFor()
      assert.equal(await page.locator('.inspection-detail-table').getByRole('textbox', { name: '検査日', exact: true }).count(), 22)
      await page.getByRole('button', { name: '検査記録へ戻る', exact: true }).click()
      await table.getByRole('cell', { name: '令和8年10月3日', exact: true }).waitFor()
      assert.equal(await table.locator('tbody tr').count(), 1)
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-consolidated-list-${width}.png`) })
      await dateTrigger.scrollIntoViewIfNeeded()
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await dateTrigger.click()
      await page.getByRole('searchbox', { name: '検査日を文字で絞り込む', exact: true }).fill('')
      await page.keyboard.press('Escape')

      // Confirm all three detail kinds contribute to the binary completion status.
      await db.exec("update flexcon_inspection_flexcons set inspection_date='2026-09-29', inspector_name='Tester', grade='1等', moisture=15; update flexcon_inspection_paper_bags set inspection_date='2026-09-29', inspector_name='Tester', grade='1等', moisture=15")
      const statusCell = table.locator('tbody tr').first().locator('td').first()
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

      const certificateDialog = page.getByRole('dialog', { name: '検査証明書作成' })
      const openProducer = async () => {
        await table.locator('tbody tr').first().click()
        await page.locator('.producer-inspection-page').waitFor()
      }
      const openCertificate = async kind => {
        await page.locator('.inspection-detail-section').nth(kind === 'bulk' ? 1 : 0).getByRole('button', { name: '検査証明書作成' }).click()
        await certificateDialog.waitFor()
      }
      const checkCertificateRange = async (start, count) => {
        assert.equal(await certificateDialog.getByLabel('開始№', { exact: true }).inputValue(), start)
        assert.equal(await certificateDialog.getByLabel('枚数', { exact: true }).inputValue(), count)
      }
      const closeCertificate = async () => certificateDialog.getByRole('button', { name: '閉じる', exact: true }).click()
      const backToList = async () => page.getByRole('button', { name: '検査記録へ戻る', exact: true }).click()

      await openProducer()
      await openCertificate('standard')
      await checkCertificateRange('2', '19') // No. 1 has a non-certificate quantity.
      await closeCertificate()
      await openCertificate('bulk')
      await checkCertificateRange('1', '1')
      await closeCertificate()
      await backToList()

      await db.exec("update flexcon_inspection_flexcons set certificate_print_count=1 where record_kind='standard' and flexcon_no between 2 and 10")
      await reloadList()
      await openProducer()
      await openCertificate('standard')
      await checkCertificateRange('11', '10')
      await closeCertificate()
      await backToList()

      await db.exec("update flexcon_inspection_flexcons set certificate_print_count=0 where record_kind='standard' and flexcon_no=5")
      await reloadList()
      await openProducer()
      await openCertificate('standard')
      await checkCertificateRange('5', '1')
      await certificateDialog.getByLabel('開始№', { exact: true }).fill('12')
      await certificateDialog.getByLabel('枚数', { exact: true }).fill('2')
      assert.match(await certificateDialog.locator('.certificate-range-summary').innerText(), /対象 2本/)
      await closeCertificate()
      await openCertificate('standard')
      await checkCertificateRange('5', '1')
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-certificate-default-gap-${width}.png`) })
      await closeCertificate()
      await backToList()

      await db.exec("update flexcon_inspection_flexcons set certificate_print_count=1 where record_kind='standard' and flexcon_no between 2 and 20")
      await reloadList()
      await openProducer()
      await openCertificate('standard')
      await checkCertificateRange('', '')
      assert.equal(await certificateDialog.locator('.certificate-range-summary').innerText(), 'すべて印刷済み')
      await certificateDialog.getByLabel('開始№', { exact: true }).fill('12')
      await certificateDialog.getByLabel('枚数', { exact: true }).fill('2')
      assert.match(await certificateDialog.locator('.certificate-range-summary').innerText(), /対象 2本/)
      await closeCertificate()
      await backToList()

      // Multiple producers make vertical and horizontal restoration observable.
      await db.exec(`
        insert into flexcon_authorizations(authorization_no,full_name,prefecture)
        select (1000+n)::text,'Return Producer ' || lpad(n::text,2,'0'),'青森県' from generate_series(0,59) n;
        insert into flexcon_inspection_registrations(authorization_id,warehouse_id,settlement_no,created_by_worker_id)
        select id,'00000000-0000-0000-0000-000000000011','RETURN','tester' from flexcon_authorizations where authorization_no::integer>=1000;
        insert into flexcon_inspection_flexcons(registration_id,authorization_id,fiscal_year,purchase_date,inspection_date,inspector_name,inspection_location,record_kind,flexcon_no,lot_number,brand,quantity_kg,grade,moisture,created_by_worker_id,updated_by_worker_id)
        select r.id,a.id,8,'2026-09-29','2026-09-29','Tester',case when a.authorization_no::integer%2=0 then 'B' else 'A' end,'standard',1,'RETURN-' || a.authorization_no,'Rice',1020,'1等',15,'tester','tester'
        from flexcon_authorizations a join flexcon_inspection_registrations r on r.authorization_id=a.id where a.authorization_no::integer>=1000;
      `)
      await reloadList()
      const openFilter = async name => {
        const trigger = page.getByRole('button', { name: `${name}を絞り込む`, exact: true })
        await trigger.scrollIntoViewIfNeeded()
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await trigger.click()
      }
      await openFilter('氏名')
      await page.getByRole('searchbox', { name: '氏名を文字で絞り込む', exact: true }).fill('Return Producer')
      await page.keyboard.press('Escape')
      assert.equal(await table.locator('tbody tr').count(), 60)
      await openFilter('検査場所')
      await page.locator('.shipment-filter-menu').getByLabel('B', { exact: true }).uncheck()
      await page.keyboard.press('Escape')
      assert.equal(await table.locator('tbody tr').count(), 30)
      await openFilter('検査日')
      await page.getByRole('searchbox', { name: '検査日を文字で絞り込む', exact: true }).fill('令和8年9月29日')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '委任状', exact: true }).click()
      await page.getByRole('button', { name: '委任状', exact: true }).click()
      const summaryWrap = page.locator('.inspection-summary-wrap')
      const getPosition = () => summaryWrap.evaluate(el => ({ top: el.scrollTop, left: el.scrollLeft, pageTop: window.scrollY, pageLeft: window.scrollX, mainTop: el.closest('main').scrollTop, mainLeft: el.closest('main').scrollLeft }))
      const expectedRows = await table.locator('tbody tr').allTextContents()
      const selectedRow = table.locator('tbody tr').nth(12)
      const selectedName = await selectedRow.locator('td').nth(5).innerText()
      const selectedCell = selectedRow.getByRole('cell', { name: selectedName, exact: true })
      await selectedCell.scrollIntoViewIfNeeded()
      await summaryWrap.evaluate(el => { el.scrollLeft = 400; el.scrollTop = 400 })
      if (width === 390) await page.evaluate(() => window.scrollTo(0,400))
      await selectedCell.scrollIntoViewIfNeeded()
      const savedPosition = await getPosition()
      assert.ok(savedPosition.left > 0)
      assert.ok(savedPosition.top > 0 || savedPosition.pageTop > 0)
      await selectedCell.click()
      await page.locator('.producer-inspection-heading h1').getByText(selectedName, { exact: true }).waitFor()
      await page.locator('.producer-inspection-page').evaluate(el => { el.scrollTop = el.scrollHeight })
      await page.getByRole('button', { name: '検査記録へ戻る', exact: true }).click()
      await table.getByRole('cell', { name: selectedName, exact: true }).waitFor()
      assert.deepEqual(await table.locator('tbody tr').allTextContents(), expectedRows)
      assert.deepEqual(await getPosition(), savedPosition)
      for (const name of ['氏名', '検査日', '検査場所']) assert.equal(await page.getByRole('button', { name: `${name}を絞り込む`, exact: true }).evaluate(el => el.parentElement.classList.contains('active')), true)
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-list-restored-${width}.png`) })

      // Keyboard navigation must preserve the same snapshot on the next round trip.
      await selectedRow.focus()
      const keyboardPosition = await getPosition()
      await selectedRow.press('Enter')
      await page.locator('.producer-inspection-heading h1').getByText(selectedName, { exact: true }).waitFor()
      await page.getByRole('button', { name: '検査記録へ戻る', exact: true }).click()
      await table.getByRole('cell', { name: selectedName, exact: true }).waitFor()
      assert.deepEqual(await table.locator('tbody tr').allTextContents(), expectedRows)
      assert.deepEqual(await getPosition(), keyboardPosition)
      await openFilter('検査日')
      assert.equal(await page.getByRole('searchbox', { name: '検査日を文字で絞り込む', exact: true }).inputValue(), '令和8年9月29日')
      await page.keyboard.press('Escape')
      await openFilter('検査場所')
      assert.equal(await page.locator('.shipment-filter-menu').getByLabel('B', { exact: true }).isChecked(), false)
      await page.keyboard.press('Escape')

      await db.exec("update flexcon_inspection_flexcons set inspection_date='2026-09-30' where lot_number='RETURN-1000'; update flexcon_inspection_flexcons set inspection_date='2026-10-01' where lot_number='RETURN-1001'; update flexcon_inspection_paper_bags set inspection_date=null where registration_id='00000000-0000-0000-0000-000000000021'")
      await reloadList()
      await page.getByRole('tab', { name: '集計' }).click()
      const progress = page.locator('.inspection-progress-section')
      const startDate = progress.getByRole('textbox', { name: '期間の開始日', exact: true })
      const endDate = progress.getByRole('textbox', { name: '期間の終了日', exact: true })
      const progressTotals = () => progress.locator('.inspection-progress-totals strong').allTextContents()
      await progress.locator('.inspection-progress-totals strong').first().waitFor()
      assert.deepEqual(await progressTotals(), ['81,680kg', '300kg'])
      await startDate.fill('令和8年9月30日')
      await startDate.press('Tab')
      await endDate.fill('令和8年10月1日')
      await endDate.press('Tab')
      assert.deepEqual(await progressTotals(), ['2,040kg', '0kg'])
      assert.match(await progress.locator('.inspection-record-detail-list.inspected summary').innerText(), /2件\s+2,040kg/)
      assert.match(await progress.locator('.inspection-record-detail-list.uninspected summary').innerText(), /0件\s+0kg/)
      await endDate.fill('令和8年9月30日')
      await endDate.press('Tab')
      assert.deepEqual(await progressTotals(), ['1,020kg', '0kg'])
      await progress.getByRole('combobox', { name: '期間の基準日', exact: true }).selectOption('purchase')
      await startDate.fill('令和8年9月3日')
      await startDate.press('Tab')
      await endDate.fill('令和8年9月3日')
      await endDate.press('Tab')
      assert.deepEqual(await progressTotals(), ['1,020kg', '300kg'])
      assert.match(await progress.locator('.inspection-record-detail-list.uninspected summary').innerText(), /1件\s+300kg/)
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-quantity-period-${width}.png`) })
      await page.getByRole('tab', { name: '一覧' }).click()
      await page.getByRole('tab', { name: '集計' }).click()
      assert.deepEqual(await progressTotals(), ['1,020kg', '300kg'])
      assert.equal(await startDate.inputValue(), '令和8年9月3日')
      await startDate.fill('令和8年10月1日')
      await startDate.press('Tab')
      assert.deepEqual(await progressTotals(), ['0kg', '0kg'])
      await progress.getByRole('alert').getByText('開始日は終了日以前にしてください。').waitFor()
      await progress.getByRole('button', { name: '期間をクリア' }).click()
      assert.deepEqual(await progressTotals(), ['81,680kg', '300kg'])
      assert.deepEqual(errors, [])
      console.log(`PASS ${width}px: certificate defaults, date-separated summaries, inspection quantity periods and list state`)
    } finally { await context.close(); await db.close() }
  }
} finally {
  await browser.close()
}
