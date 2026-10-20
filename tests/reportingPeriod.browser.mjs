import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const auth = { id: 'a', authorization_no: '1', full_name: '年度テスト生産者', prefecture: '青森県', municipality: 'テスト市' }
const metadata = { authorization_id: 'a', registration_id: 'r', fiscal_year: 8, inspector_name: 'Tester', inspection_location: 'A', brand: 'Rice', grade: '1等', moisture: 13, reason: null, quantity_kg: 1020, record_kind: 'standard', certificate_print_count: 0, settlement_no: 'TEST' }
const flexcons = [
  { ...metadata, id: 'f1', flexcon_no: 1, inspection_date: '2026-09-01', purchase_date: '2026-08-31' },
  { ...metadata, id: 'f2', flexcon_no: 2, inspection_date: '2026-08-31', purchase_date: '2026-09-01' },
  { ...metadata, id: 'f3', flexcon_no: 3, inspection_date: null, purchase_date: '2026-09-02' },
  { ...metadata, id: 'f4', flexcon_no: 4, inspection_date: null, purchase_date: '2026-08-31' },
  { ...metadata, id: 'f5', flexcon_no: 5, inspection_date: '2027-08-31', purchase_date: '2027-08-31' },
  { ...metadata, id: 'f6', flexcon_no: 6, inspection_date: '2027-09-01', purchase_date: '2027-09-01' },
]
const warehouse = (id, name) => ({ id, name, option_type: 'warehouse', active: true, created_at: '2026-01-01', sort_order: 0 })
const options = [warehouse('a', 'A'), warehouse('b', 'B'), warehouse('u', '倉庫未設定'), { id: 'grade', option_type: 'grade', name: '1等', active: true }]
const move = (id, date, quantity, from = null, to = 'a', source = 'manual') => ({ id, source_type: source, movement_type: from ? to ? 'transfer' : 'outbound' : 'inbound', movement_date: date, quantity, crop_year: 2026, from_warehouse_id: from, to_warehouse_id: to, movement_from: from?.toUpperCase() ?? '', movement_to: to?.toUpperCase() ?? '', origin: '青森県', product_name: 'Rice', grade: '1等', unit: '本', worker_name: 'Tester', producer_name: '', settlement_no: id, created_at: `${date}T00:00:00Z` })
const ledger = [
  ...Array.from({ length: 1001 }, (_, i) => move(`noise-${i}`, '2030-09-01', 0)),
  move('OPENING', '2026-08-31', 10), move('IN', '2026-09-01', 5),
  move('shipment-record:START-line', '2026-08-31', 3, 'a', null, 'shipment_record'),
  move('TRANSFER', '2026-10-01', 2, 'a', 'b'),
  move('shipment-manual:LAST-line', '2027-08-31', 1, 'a', null, 'shipment_manual'),
  move('shipment-record:AFTER-line', '2027-08-31', 4, 'a', null, 'shipment_record'),
]
const shipment = (id, shippedAt) => ({ id, shipped_at: shippedAt, shipment_kind: 'manual_record', carrier_name: '', driver_name: '', vehicle_no: '', note: id, flexcon_destinations: { name: id }, workers: { worker_name: 'Tester' }, flexcon_shipment_items: [], flexcon_manual_shipment_items: [{ id: `${id}-line`, crop_year: 2026, origin_prefecture: '青森県', product_name: 'Rice', quantity_count: 1, unit: '本', grade: '1等', moisture: null, reason: '', sort_order: 0 }] })
const shipments = [
  ...Array.from({ length: 1001 }, (_, i) => shipment(`OLD-${i}`, '2024-10-01T00:00:00Z')),
  shipment('START', '2026-08-31T15:00:00Z'), shipment('BEFORE', '2026-08-31T14:59:59Z'),
  shipment('LAST', '2027-08-31T14:59:59Z'), shipment('AFTER', '2027-08-31T15:00:00Z'),
]
const data = { flexcon_authorizations: [auth], flexcon_inspection_registrations: [{ id: 'r', authorization_id: 'a', registration_no: 1 }], flexcon_inspection_flexcons: flexcons, flexcon_inspection_options: options, flexcon_inventory_ledger: ledger, flexcon_shipments: shipments }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 820, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' })
    const errors = [], requests = []
    try {
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://reporting.test/**', route => {
        const url = new URL(route.request().url())
        const file = path.resolve('dist', url.pathname === '/' ? 'index.html' : `.${url.pathname}`)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      await context.route('**/rest/v1/**', async route => {
        const url = new URL(route.request().url()), table = url.pathname.split('/rest/v1/')[1]
        let body = []
        if (table === 'rpc/business_session') body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'admin', purchase_statements: 'admin' } }
        else if (table === 'rpc/flexcon_get_undo_status') body = { operation_id: null }
        else if (['rpc/flexcon_list_purchase_statements', 'rpc/flexcon_list_purchase_statement_master', 'rpc/flexcon_list_purchase_inventory_master'].includes(table)) body = []
        else {
          assert.equal(route.request().method(), 'GET', 'No business mutations allowed')
          const offset = Number(url.searchParams.get('offset') ?? 0), limit = Math.min(1000, Number(url.searchParams.get('limit') ?? 1000))
          requests.push({ table, offset })
          body = (data[table] ?? []).slice(offset, offset + limit)
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.clock.setFixedTime('2026-10-20T12:00:00+09:00')
      await page.goto('https://reporting.test/')
      const nav = page.getByRole('navigation', { name: 'メインメニュー' })
      const period = page.getByRole('region', { name: '共通の表示期間' })
      await period.waitFor()
      assert.equal(await period.getByRole('combobox', { name: '表示年度', exact: true }).inputValue(), '2026')
      assert.deepEqual(await period.locator('input[type=date]').evaluateAll(inputs => inputs.map(input => input.value)), ['2026-09-01', '2027-08-31'])
      await nav.getByRole('button', { name: '検査記録', exact: true }).click()
      const summary = page.locator('.inspection-summary-table')
      await summary.getByText('年度テスト生産者', { exact: true }).first().waitFor()
      assert.equal(await summary.locator('tbody tr').count(), 3)
      assert.equal(await summary.locator('tbody tr').filter({ hasText: '未設定' }).count(), 0)
      const undated = summary.locator('tbody tr').filter({ has: page.locator('td:nth-child(5):empty') })
      assert.equal(await undated.count(), 1)
      assert.equal(await undated.getByRole('button').isDisabled(), true, 'A period-hidden sibling must never be deleted from a partial group')
      await page.getByRole('tab', { name: '集計', exact: true }).click()
      const totals = page.locator('.inspection-summary-aggregate > .section-title .inspection-progress-totals')
      assert.match(await totals.innerText(), /2,040kg[\s\S]*1,020kg/)
      await page.getByRole('tab', { name: '一覧', exact: true }).click()
      await undated.click()
      await page.locator('.producer-inspection-page').waitFor()
      assert.equal(await page.locator('.inspection-detail-table tbody tr[id]').count(), 6)
      assert.deepEqual(await page.locator('.inspection-target-row').evaluateAll(rows => rows.map(row => row.id)), ['inspection-record-f3'], 'Hidden sibling dates must not be highlighted')
      assert.match(await page.locator('.producer-inspection-heading').innerText(), /全期間の明細/)

      await nav.getByRole('button', { name: '在庫', exact: true }).click()
      const stock = page.locator('.inventory-balance-table tbody tr').filter({ hasText: 'Rice' })
      await stock.first().waitFor()
      assert.equal(await stock.first().locator('td').nth(4).innerText(), '9')
      assert.equal(await stock.first().locator('td').last().innerText(), '4')
      await page.getByRole('combobox', { name: '在庫の集計方法' }).selectOption('net')
      assert.equal(await stock.first().locator('td').nth(4).innerText(), '-1')
      assert.equal(await stock.first().locator('td').last().innerText(), '4')
      await nav.getByRole('button', { name: '入出庫管理', exact: true }).click()
      await page.locator('.inventory-history-table').getByText('TRANSFER', { exact: true }).waitFor()
      assert.equal(await page.locator('.inventory-history-table').getByText('OPENING', { exact: true }).count(), 0)
      assert.equal(await page.locator('.inventory-history-table').getByText('NEXT', { exact: true }).count(), 0)
      assert.ok(requests.some(row => row.table === 'flexcon_inventory_ledger' && row.offset === 1000))
      await nav.getByRole('button', { name: '出荷履歴', exact: true }).click()
      const history = page.locator('.shipment-table tbody tr')
      await history.filter({ hasText: 'START' }).waitFor()
      assert.equal(await history.count(), 2)
      assert.equal(await history.filter({ hasText: 'LAST' }).count(), 1)
      assert.ok(requests.some(row => row.table === 'flexcon_shipments' && row.offset === 1000))
      await period.getByRole('button', { name: '前年度', exact: true }).click()
      assert.equal(await history.count(), 1)
      assert.match(await history.first().innerText(), /BEFORE/)
      await page.reload()
      assert.equal(await period.getByRole('combobox', { name: '表示年度', exact: true }).inputValue(), '2025')
      await nav.getByRole('button', { name: '検査記録', exact: true }).click()
      await summary.getByText('年度テスト生産者', { exact: true }).first().waitFor()
      assert.equal(await summary.locator('tbody tr').count(), 2)
      await period.getByRole('combobox', { name: '表示年度', exact: true }).selectOption('all')
      assert.equal(await summary.locator('tbody tr').count(), 5)
      await period.getByRole('button', { name: '今年度に戻す', exact: true }).click()
      const dateFields = period.locator('input[type=text]')
      await dateFields.nth(0).fill('令和8年9月1日')
      await dateFields.nth(1).fill('令和8年9月1日')
      await period.getByRole('combobox', { name: '表示年度', exact: true }).focus()
      assert.equal(await summary.locator('tbody tr').count(), 1)
      assert.equal(await period.getByRole('combobox', { name: '表示年度', exact: true }).inputValue(), 'custom')
      await dateFields.nth(0).fill('令和8年10月1日')
      await period.getByRole('combobox', { name: '表示年度', exact: true }).focus()
      assert.equal(await period.getByRole('alert').count(), 1)
      assert.equal(await summary.locator('tbody tr').count(), 1, 'Invalid drafts must not change the active period')
      await period.getByRole('button', { name: '今年度に戻す', exact: true }).click()
      await page.getByRole('switch', { name: '西暦表示', exact: true }).click()
      assert.equal(await dateFields.nth(0).inputValue(), '2026年9月1日')
      const box = await period.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= width)
      for (const control of await period.locator('input[type=text],select,button').all()) {
        const rect = await control.boundingBox()
        assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width, 'Period controls must stay inside the viewport')
      }
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `reporting-period-${width}.png`) })
      await page.goto('https://reporting.test/?app=statements')
      await page.getByRole('navigation', { name: 'メインメニュー' }).waitFor()
      assert.equal(await page.getByRole('region', { name: '共通の表示期間' }).count(), 0)
      assert.deepEqual(errors, [])
      console.log(`PASS ${width}px: shared annual/custom/all periods, persistence, inspection fallback, complete details, inventory basis, shipment timezone and pagination`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
