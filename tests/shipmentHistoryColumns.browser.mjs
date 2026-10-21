import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const root = path.resolve('dist')
const shipments = [12345.67, 900, 1000, 0, null].map((price, index) => ({
  id: `shipment-${index}`, destination_id: 'destination', transport_profile_id: 'transport',
  shipped_at: index === 1 ? '2026-10-21T15:30:00Z' : '2026-10-20T15:30:00Z',
  shipment_kind: 'manual_record', product_name: '米', quantity_count: 1,
  purchase_price_per_bale: price, note: `Record ${index}`,
  source_warehouse: index === 4 ? null : { name: index % 2 === 0 ? '倉庫A' : '倉庫B' },
  carrier_name: '運送会社A', driver_name: 'ドライバーA', vehicle_no: '車両A',
  flexcon_destinations: { name: '納品先A' }, workers: { worker_name: '担当者A' },
  flexcon_shipment_items: [], flexcon_manual_shipment_items: [{
    id: `item-${index}`, crop_year: 2026, origin_prefecture: '青森県', product_name: '米',
    quantity_count: index + 1, unit: ['本', '袋', 'kg', '本', '本'][index],
    grade: '1等', moisture: 15.1, reason: '理由A', sort_order: 0,
  }],
}))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' })
    const mutations = []
    const errors = []
    try {
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://shipment.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.join(root, pathname === '/' ? 'index.html' : pathname)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      await context.route('**/rest/v1/**', route => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        let body = []
        if (resource === 'rpc/business_session') body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'operator' } }
        else if (resource === 'flexcon_shipments') body = shipments
        else if (resource === 'flexcon_destinations') body = [{ id: 'destination', name: '納品先A', active: true }]
        else if (resource === 'flexcon_transport_profiles') body = [{ id: 'transport', company_name: '運送会社A', active: true }]
        else if (resource.startsWith('rpc/flexcon_') && !resource.startsWith('rpc/flexcon_undo_')) mutations.push(resource)
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.clock.setFixedTime('2026-10-21T12:00:00+09:00')
      await page.goto('https://shipment.test/')
      await page.getByRole('button', { name: '出荷記録', exact: true }).click()
      await page.getByRole('tab', { name: '履歴', exact: true }).click()
      const table = page.locator('.shipment-table')
      const rows = table.locator('tbody tr')
      await rows.nth(4).waitFor()
      assert.deepEqual(await table.locator('thead th').allTextContents(), ['操作', '出荷日', '出荷元', '納品先', '産年', '産地', '品名', '等級', 'フレコン本数', '紙袋数', 'kg数量', '仕入れ値（円／俵）', '備考'])
      assert.deepEqual((await rows.first().locator('td').allTextContents()).slice(1), ['令和8年10月21日', '倉庫A', '納品先A', '令和8年産', '青森県', '米', '1等', '1本', '', '', '12,345.67', 'Record 0'])
      assert.equal(await rows.nth(4).locator('td').nth(2).innerText(), '未設定', 'Legacy shipments do not borrow a current warehouse')
      assert.equal(await rows.nth(1).locator('td').nth(1).innerText(), '令和8年10月22日', 'Display uses the local date, not the UTC date')
      assert.equal(await rows.nth(3).locator('td').nth(11).innerText(), '0', 'Zero is not an unset price')
      assert.equal(await rows.nth(4).locator('td').nth(11).innerText(), '', 'Unset prices stay blank')
      const priceSort = table.locator('.shipment-column-purchasePrice .shipment-column-sort')
      await priceSort.click()
      assert.deepEqual(await rows.locator('td:nth-child(12)').allTextContents(), ['', '0', '900', '1,000', '12,345.67'])
      await priceSort.click()
      assert.deepEqual(await rows.locator('td:nth-child(12)').allTextContents(), ['12,345.67', '1,000', '900', '0', ''])
      await priceSort.click()
      await page.getByRole('switch', { name: '西暦表示', exact: true }).click()
      assert.equal(await rows.first().locator('td').nth(1).innerText(), '2026年10月21日')
      assert.equal(await rows.first().locator('td').nth(4).innerText(), '2026年産')
      const sourceSort = table.locator('.shipment-column-sourceWarehouse .shipment-column-sort')
      await sourceSort.click()
      const sources = await rows.locator('td:nth-child(3)').allTextContents()
      assert.deepEqual(sources, ['倉庫A', '倉庫A', '倉庫B', '倉庫B', '未設定'].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true })))
      await sourceSort.click()
      assert.deepEqual(await rows.locator('td:nth-child(3)').allTextContents(), sources.toReversed())
      await sourceSort.click()
      await table.getByRole('button', { name: '出荷元を絞り込む', exact: true }).click()
      const sourceSearch = page.getByRole('searchbox', { name: '出荷元を文字で絞り込む', exact: true })
      await sourceSearch.fill('倉庫B')
      assert.equal(await rows.count(), 2)
      assert.deepEqual(await rows.locator('td:nth-child(3)').allTextContents(), ['倉庫B', '倉庫B'])
      await sourceSearch.fill('')
      await sourceSearch.press('Escape')
      assert.equal(await rows.count(), 5)
      const filter = table.getByRole('button', { name: '仕入れ値（円／俵）を絞り込む', exact: true })
      await filter.scrollIntoViewIfNeeded()
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await filter.click()
      const search = page.getByRole('searchbox', { name: '仕入れ値（円／俵）を文字で絞り込む', exact: true })
      await search.fill('12,345')
      assert.equal(await rows.count(), 1)
      await search.fill('')
      await search.press('Escape')
      assert.equal(await rows.count(), 5)
      await rows.first().getByRole('button', { name: /出荷履歴を編集/ }).click()
      const dialog = page.getByRole('dialog', { name: '出荷履歴を編集', exact: true })
      assert.equal(await dialog.getByLabel('運送会社（任意）').inputValue(), 'transport')
      assert.equal(await dialog.getByLabel('ドライバー名（任意）').inputValue(), 'ドライバーA')
      assert.equal(await dialog.getByLabel('車体番号（任意）').inputValue(), '車両A')
      assert.equal(await dialog.getByLabel('仕入値（任意・1俵当たり）').inputValue(), '12345.67')
      await dialog.getByRole('button', { name: '編集画面を閉じる', exact: true }).click()
      await page.locator('.shipment-table-wrap').evaluate(element => { element.scrollLeft = 0 })
      await page.evaluate(() => window.scrollTo(0, 0))
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `shipment-columns-${width}.png`) })
      assert.deepEqual(mutations, [], 'Display changes never write business data')
      assert.deepEqual(errors, [])
      console.log(`PASS ${width}px: shipment column order, date-only local dates, calendar modes, price formatting/sorting/filtering, retained edit fields`)
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}
