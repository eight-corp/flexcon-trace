import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const base = { fiscal_year: 8, purchase_date: '2026-10-19', inspection_date: '2026-10-19', inspection_location: 'Test Place', inspector_name: 'Tester', moisture: 13, reason: null, grade: '合格', brand: '飼料用玄米', authorization_id: 'a', registration_id: 'ra' }
const records = {
  flexcon_authorizations: [
    { id: 'a', authorization_no: '1', full_name: 'Feed Producer', prefecture: '青森県' },
    { id: 'b', authorization_no: '2', full_name: 'Rice Producer', prefecture: '青森県' },
    { id: 'c', authorization_no: '3', full_name: 'Iwate Producer', prefecture: '岩手県' },
  ],
  flexcon_inspection_registrations: ['a', 'b', 'c'].map((id, i) => ({ id: `r${id}`, authorization_id: id, registration_no: i + 1, settlement_no: 'TEST' })),
  flexcon_inspection_flexcons: [
    { ...base, id: 'f1', record_kind: 'standard', flexcon_no: 1, quantity_kg: 1000 },
    { ...base, id: 'f2', record_kind: 'bulk', flexcon_no: 2, quantity_kg: 50, moisture: null },
    { ...base, id: 'f3', record_kind: 'standard', flexcon_no: 1, quantity_kg: 1020, brand: 'まっしぐら', grade: '1等', authorization_id: 'b', registration_id: 'rb' },
    { ...base, id: 'f4', record_kind: 'standard', flexcon_no: 1, quantity_kg: 500, brand: 'ひとめぼれ', grade: '2等', reason: '整粒', authorization_id: 'c', registration_id: 'rc', fiscal_year: 7 },
    { ...base, id: 'f5', record_kind: 'standard', flexcon_no: 3, quantity_kg: 1000, inspection_date: '2026-10-18' },
  ],
  flexcon_inspection_paper_bags: [
    { ...base, id: 'p1', bag_count: 10 },
    { ...base, id: 'p2', bag_count: 5, brand: 'まっしぐら', grade: '1等', moisture: null, authorization_id: 'b', registration_id: 'rb' },
    { ...base, id: 'p3', bag_count: 2, brand: 'ひとめぼれ', grade: '2等', reason: '整粒', authorization_id: 'c', registration_id: 'rc', fiscal_year: 7 },
  ],
  flexcon_inspection_options: [
    ...['1等', '2等', '合格'].map(name => ({ id: name, option_type: 'grade', name, active: true })),
    { id: 'brand-a', option_type: 'brand_aomori', name: '飼料用玄米', active: true },
    { id: 'brand-b', option_type: 'brand_aomori', name: 'まっしぐら', active: true },
    { id: 'brand-c', option_type: 'brand_iwate', name: 'ひとめぼれ', active: true },
    { id: 'inspector', option_type: 'inspector', name: 'Tester', active: true },
    { id: 'place', option_type: 'location', name: 'Test Place', active: true },
  ],
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    const errors = []
    try {
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://aggregate-filters.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.resolve('dist', pathname === '/' ? 'index.html' : `.${pathname}`)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      await context.route('**/rest/v1/**', route => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        assert.ok(resource === 'rpc/business_session' || route.request().method() === 'GET', 'filters never write business data')
        const body = resource === 'rpc/business_session'
          ? { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'operator' } }
          : records[resource] ?? []
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.goto('https://aggregate-filters.test/')
      const nav = page.getByRole('navigation', { name: 'メインメニュー' })
      await nav.getByRole('button', { name: '検査記録', exact: true }).click()
      await page.locator('.inspection-summary-table tbody tr').first().waitFor()
      const openFilter = async (scope, label) => {
        const trigger = scope.getByRole('button', { name: `${label}を絞り込む`, exact: true })
        await trigger.scrollIntoViewIfNeeded()
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await trigger.click()
      }
      const search = async (scope, label, value) => {
        await openFilter(scope, label)
        await page.getByRole('searchbox', { name: `${label}を文字で絞り込む`, exact: true }).fill(value)
        await page.keyboard.press('Escape')
      }
      await search(page.locator('.inspection-summary-table'), '氏名', 'Feed Producer')
      await page.getByRole('tab', { name: '集計', exact: true }).click()
      const flexcon = page.getByRole('region', { name: 'フレコンの集計', exact: true })
      const paper = page.getByRole('region', { name: '紙袋の集計', exact: true })
      const clear = page.getByRole('button', { name: '絞り込み解除', exact: true })
      const waitTotals = expected => page.waitForFunction(values => {
        const actual = Array.from(document.querySelectorAll('.inspection-summary-aggregate > .section-title .inspection-progress-totals strong')).map(el => Number(el.textContent.replace(/[^0-9]/g, '')))
        return JSON.stringify(actual) === JSON.stringify(values)
      }, expected)
      await waitTotals([3880, 200])
      assert.equal(await clear.isDisabled(), true, 'list filters are independent of aggregate filters')
      assert.equal(await flexcon.locator('thead .shipment-column-filter-trigger').count(), 8)
      for (const label of ['期間の開始日', '期間の終了日']) {
        await page.getByRole('textbox', { name: label, exact: true }).fill('令和8年10月19日')
        await page.getByRole('textbox', { name: label, exact: true }).press('Tab')
      }
      await waitTotals([2880, 200])
      await search(flexcon, '銘柄', '飼料用')
      await waitTotals([1300, 50])
      assert.equal(await paper.getByRole('button', { name: '銘柄を絞り込む', exact: true }).evaluate(el => el.parentElement.classList.contains('active')), true)
      await flexcon.locator('.inspection-record-detail-list.inspected summary').click()
      await flexcon.locator('.inspection-record-detail-list.uninspected summary').click()
      assert.equal(await flexcon.locator('.inspection-record-detail-list.inspected tbody tr').count(), 1)
      assert.equal(await flexcon.locator('.inspection-record-detail-list.uninspected tbody tr').count(), 1)
      assert.equal(await paper.locator('.inspection-record-detail-list.inspected summary').innerText().then(text => /1件.*300kg/.test(text)), true)
      await search(paper, '産地', '岩手')
      await waitTotals([0, 0])
      assert.equal(await flexcon.locator('.inspection-progress-table .empty-state').count(), 1)
      assert.equal(await paper.locator('.inspection-progress-table .empty-state').count(), 1)
      await clear.click()
      await waitTotals([2880, 200])
      assert.equal(await page.getByRole('textbox', { name: '期間の開始日', exact: true }).inputValue(), '令和8年10月19日')
      await openFilter(flexcon, '産年')
      await page.getByRole('checkbox', { name: 'すべて', exact: true }).uncheck()
      await page.getByRole('checkbox', { name: '令和7年産', exact: true }).check()
      await page.keyboard.press('Escape')
      await waitTotals([560, 0])
      await page.getByRole('switch', { name: '西暦表示' }).click()
      await waitTotals([2880, 200])
      assert.equal(await clear.isDisabled(), true, 'year display changes clear only presentation-dependent year filters')
      await search(flexcon, '合格', '1,000')
      await waitTotals([1000, 50])
      assert.equal(await paper.locator('.inspection-progress-table .empty-state').count(), 1)
      await flexcon.locator('.inspection-record-detail-list.uninspected tbody tr').first().click()
      await page.locator('.producer-inspection-page').waitFor()
      await page.getByRole('button', { name: '検査記録へ戻る', exact: true }).click()
      await waitTotals([1000, 50])
      await nav.getByRole('button', { name: '在庫', exact: true }).click()
      await nav.getByRole('button', { name: '検査記録', exact: true }).click()
      await waitTotals([1000, 50])
      await clear.click()
      await waitTotals([2880, 200])
      await openFilter(flexcon, '合格')
      await page.getByRole('checkbox', { name: 'すべて', exact: true }).uncheck()
      await page.getByRole('checkbox', { name: '（空白）', exact: true }).check()
      await page.keyboard.press('Escape')
      await waitTotals([1580, 150])
      await clear.click()
      await search(flexcon, '銘柄', '飼料用')
      await waitTotals([1300, 50])
      await openFilter(paper, '銘柄')
      assert.equal(await page.getByRole('searchbox', { name: '銘柄を文字で絞り込む', exact: true }).inputValue(), '飼料用')
      const menu = page.locator('.shipment-filter-menu-floating')
      const menuBox = await menu.boundingBox()
      assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width && menuBox.y >= 0 && menuBox.y + menuBox.height <= 900)
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `aggregate-filters-${width}.png`) })
      await page.keyboard.press('Escape')
      await page.getByRole('tab', { name: '一覧', exact: true }).click()
      assert.ok((await page.locator('.inspection-summary-table tbody tr').allTextContents()).every(text => text.includes('Feed Producer')))
      await page.getByRole('tab', { name: '集計', exact: true }).click()
      await waitTotals([1300, 50])
      assert.deepEqual(errors, [])
      console.log(`PASS aggregate filters: shared columns, periods, totals/details, empty values, calendar, navigation, reset ${width}px`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
