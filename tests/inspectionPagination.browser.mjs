import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const authorizations = Array.from({ length: 1002 }, (_, i) => ({
  id: `a-${i}`, authorization_no: String(i + 1).padStart(4, '0'),
  full_name: i === 1001 ? '飼料用米テスト生産者' : `一般生産者${i}`,
  prefecture: '青森県', municipality: 'テスト市', address: 'テスト',
  crop_type: i === 1001 ? '飼料用米' : '主食用米', feed_rice_variety: '',
}))
const registrations = authorizations.map((row, i) => ({ id: `r-${i}`, authorization_id: row.id, registration_no: i + 1, settlement_no: 'TEST' }))
const metadata = { fiscal_year: 8, inspector_name: 'Tester', inspection_location: 'テスト場所', moisture: 13, reason: null, settlement_no: 'TEST', certificate_print_count: 0 }
const flexcons = Array.from({ length: 1807 }, (_, i) => {
  const feed = i >= 1794
  return { ...metadata, id: `f-${String(i).padStart(4, '0')}`, authorization_id: feed ? 'a-1001' : 'a-0', registration_id: feed ? 'r-1001' : 'r-0',
    record_kind: 'standard', flexcon_no: feed ? i - 1793 : i + 1, lot_number: String(i + 1),
    purchase_date: feed ? '2026-08-01' : '2026-10-19', inspection_date: feed ? (i < 1800 ? '2026-08-01' : '2026-08-02') : '2026-10-19',
    brand: feed ? '飼料用玄米' : 'まっしぐら', grade: feed ? '合格' : '1等', quantity_kg: feed ? 1000 : 1020 }
})
const paper = Array.from({ length: 1001 }, (_, i) => ({ ...metadata, id: `p-${String(i).padStart(4, '0')}`,
  authorization_id: i === 1000 ? 'a-1001' : 'a-0', registration_id: i === 1000 ? 'r-1001' : 'r-0',
  purchase_date: i === 1000 ? '2026-08-01' : '2026-10-19', inspection_date: i === 1000 ? '2026-08-01' : '2026-10-19',
  created_at: '2026-10-19T00:00:00Z', brand: i === 1000 ? '飼料用玄米' : 'まっしぐら', grade: i === 1000 ? '合格' : '1等', bag_count: i === 1000 ? 5 : 1,
}))
const data = {
  flexcon_authorizations: authorizations, flexcon_inspection_registrations: registrations,
  flexcon_inspection_flexcons: flexcons, flexcon_inspection_paper_bags: paper,
  flexcon_inspection_weights: [{ weight_type: 'branded_rice', weight_kg: 1020 }, { weight_type: 'feed_rice', weight_kg: 1000 }],
  flexcon_inspection_options: [
    { id: 'o-1', option_type: 'brand_aomori', name: '飼料用玄米', active: true },
    { id: 'o-2', option_type: 'brand_aomori', name: 'まっしぐら', active: true },
    { id: 'o-3', option_type: 'grade', name: '合格', active: true },
    { id: 'o-4', option_type: 'inspector', name: 'Tester', active: true },
    { id: 'o-5', option_type: 'location', name: 'テスト場所', active: true },
  ],
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const scenario of [{ width: 1440 }, { width: 390 }, { width: 1440, failLaterPage: true }]) {
    const context = await browser.newContext({ viewport: { width: scenario.width, height: 900 }, serviceWorkers: 'block' })
    const requests = new Map()
    const errors = []
    try {
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://pagination.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.resolve('dist', pathname === '/' ? 'index.html' : `.${pathname}`)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      // Model the API's 1,000-row response cap, including related tables beyond that cap.
      await context.route('**/rest/v1/**', async route => {
        const url = new URL(route.request().url())
        const table = url.pathname.split('/rest/v1/')[1]
        if (table === 'rpc/business_session') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'operator' } }) })
          return
        }
        assert.equal(route.request().method(), 'GET', 'no business writes in pagination tests')
        const from = Number(url.searchParams.get('offset') ?? 0)
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), 1000)
        // Inventory also paginates the year lookup; assertions below target full inspection rows.
        if (url.searchParams.get('select') !== 'id,fiscal_year') requests.set(table, [...(requests.get(table) ?? []), { from, limit, order: url.searchParams.get('order') }])
        if (scenario.failLaterPage && table === 'flexcon_inspection_flexcons' && from === 1000) {
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'TEST_LATER_PAGE_FAILED' }) })
          return
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify((data[table] ?? []).slice(from, from + limit)) })
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.goto('https://pagination.test/')
      await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('button', { name: '検査記録', exact: true }).click()
      await page.getByRole('combobox', { name: '表示年度', exact: true }).selectOption('all')
      const table = page.locator('.inspection-summary-table')
      if (scenario.failLaterPage) {
        await page.getByText('登録No.対応の検査記録用SQLを実行してください。', { exact: true }).waitFor({ state: 'attached' })
        assert.equal(await table.locator('tbody tr').filter({ hasText: '一般生産者0' }).count(), 0)
        console.log('PASS a failed later page does not display partial inspection totals')
        continue
      }
      const feedRows = table.locator('tbody tr').filter({ hasText: '飼料用米テスト生産者' })
      await feedRows.first().waitFor()
      assert.equal(await feedRows.count(), 3, 'both feed-rice inspection dates and the separate paper group appear')
      assert.match(await feedRows.nth(0).innerText(), /飼料用玄米/)
      assert.match(await feedRows.nth(0).innerText(), /6,000/)
      assert.match(await feedRows.nth(1).innerText(), /150kg/)
      assert.match(await feedRows.nth(2).innerText(), /7,000/)
      for (const resource of ['flexcon_authorizations', 'flexcon_inspection_registrations', 'flexcon_inspection_flexcons', 'flexcon_inspection_paper_bags']) {
        assert.deepEqual(requests.get(resource).map(item => item.from), [0, 1000], resource)
        assert.ok(requests.get(resource).every(item => item.limit === 1000 && item.order.endsWith('id.asc')), 'stable unique row ordering across pages')
      }
      const trigger = table.getByRole('button', { name: '銘柄を絞り込む', exact: true })
      await trigger.scrollIntoViewIfNeeded()
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await trigger.click()
      await page.getByRole('searchbox', { name: '銘柄を文字で絞り込む', exact: true }).fill('飼料用')
      await page.keyboard.press('Escape')
      assert.equal(await table.locator('tbody tr').count(), 3)
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `feed-rice-list-${scenario.width}.png`) })
      await feedRows.first().click()
      await page.locator('.producer-inspection-page').waitFor()
      assert.equal(await page.locator('.inspection-detail-table').first().locator('tbody tr[id]').count(), 13)
      assert.equal(await page.locator('.paper-detail-table tbody tr[id]').count(), 1)
      assert.equal(await page.locator('.paper-detail-table').getByRole('textbox', { name: '数量（袋）', exact: true }).inputValue(), '5')
      assert.deepEqual(errors, [])
      console.log(`PASS feed rice beyond row 1,000: list, date groups, totals, filters, complete details ${scenario.width}px`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
