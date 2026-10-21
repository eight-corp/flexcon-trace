import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const root = path.resolve('dist')
const shipment = (index) => ({
  id: `shipment-${index}`, destination_id: `destination-${index}`,
  shipped_at: '2026-10-21T03:00:00Z', shipment_kind: 'manual_record',
  product_name: '米', quantity_count: 1, flexcon_destinations: { name: `納品先${index === 1 ? 'A' : 'B'}` },
  workers: { worker_name: 'Tester' }, flexcon_shipment_items: [],
  flexcon_manual_shipment_items: [{ id: `item-${index}`, crop_year: 2026, origin_prefecture: '青森県', product_name: '米', quantity_count: 1, unit: '本', grade: '1等', moisture: null, reason: null, sort_order: 0 }],
})
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const scenario of [
    { width: 1440, role: 'admin' }, { width: 1440, role: 'operator' },
    { width: 820, role: 'operator' }, { width: 390, role: 'operator' },
    { width: 320, role: 'operator' }, { width: 1440, role: 'viewer' },
    { width: 390, role: 'viewer' },
  ]) {
    const context = await browser.newContext({ viewport: { width: scenario.width, height: 900 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' })
    let records = [shipment(1)]
    let historyReads = 0
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
        if (resource === 'rpc/business_session') body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: scenario.role } }
        else if (resource === 'flexcon_shipments') {
          if (new URL(route.request().url()).searchParams.get('select')?.includes('flexcon_destinations')) historyReads++
          body = records
        }
        else if (resource === 'flexcon_inspection_options') body = [
          { id: 'warehouse', option_type: 'warehouse', name: '倉庫A', active: true },
          { id: 'product', option_type: 'shipment_product', name: '米', active: true },
        ]
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.clock.setFixedTime('2026-10-21T12:00:00+09:00')
      await page.goto('https://shipment.test/')
      const nav = page.getByRole('navigation', { name: 'メインメニュー' })
      const shipping = nav.getByRole('button', { name: '出荷記録', exact: true })
      await shipping.click()
      assert.equal(await nav.getByRole('button', { name: '出荷履歴', exact: true }).count(), 0)
      assert.equal(await nav.getByRole('button').count(), scenario.role === 'admin' ? 7 : scenario.role === 'operator' ? 6 : 3)
      assert.equal(await shipping.getAttribute('class'), 'active')
      const tabs = page.getByRole('tablist', { name: '出荷記録の表示' })
      const historyTab = tabs.getByRole('tab', { name: '履歴', exact: true })
      const registerTab = tabs.getByRole('tab', { name: '登録', exact: true })
      const historyPanel = page.getByRole('tabpanel', { name: '履歴', exact: true })
      const rows = historyPanel.locator('.shipment-table tbody tr')
      const openDestinationFilter = async () => {
        const trigger = historyPanel.getByRole('button', { name: '納品先を絞り込む', exact: true })
        await trigger.scrollIntoViewIfNeeded()
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await trigger.click()
      }
      if (scenario.role === 'viewer') {
        assert.equal(await registerTab.count(), 0)
        assert.equal(await historyTab.getAttribute('aria-selected'), 'true')
        await rows.first().waitFor()
        assert.equal(await page.getByRole('button', { name: /出荷履歴を編集|出荷履歴を削除|出荷を登録|QRで出荷/ }).count(), 0)
      } else {
        const registerPanel = page.getByRole('tabpanel', { name: '登録', exact: true })
        await registerPanel.getByLabel('出庫元倉庫').selectOption('warehouse')
        assert.equal(historyReads, 0, 'History loads only when its tab opens')
        assert.equal(await registerTab.getAttribute('aria-selected'), 'true')
        assert.equal(await registerPanel.getByRole('button', { name: 'QRで出荷', exact: true }).count(), scenario.role === 'admin' ? 1 : 0)
        await registerPanel.getByLabel('ドライバー名（任意）').fill('入力途中')
        const editor = registerPanel.getByRole('region', { name: '出荷明細' })
        await editor.getByLabel('産地').first().selectOption('青森県')
        await editor.getByLabel('種類').first().selectOption('米')
        await editor.getByRole('button', { name: '追加', exact: true }).click()
        await historyTab.click()
        await rows.first().waitFor()
        assert.equal(await registerPanel.isVisible(), false)
        assert.equal(await shipping.getAttribute('class'), 'active')
        await openDestinationFilter()
        await page.getByRole('searchbox', { name: '納品先を文字で絞り込む', exact: true }).fill('納品先A')
        records = [shipment(1), shipment(2)]
        await registerTab.click()
        assert.equal(await page.locator('.shipment-filter-menu-floating').count(), 0)
        assert.equal(await registerPanel.getByLabel('ドライバー名（任意）').inputValue(), '入力途中')
        assert.equal(await editor.locator('.record-item-row').count(), 1, 'Added draft items survive tab switching')
        assert.equal(await registerPanel.getByLabel('出庫元倉庫').inputValue(), 'warehouse')
        await page.evaluate(() => window.scrollTo(0, 0))
        if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `shipment-register-${scenario.role}-${scenario.width}.png`) })
        await registerTab.focus()
        const refreshed = page.waitForResponse(response => response.url().includes('/rest/v1/flexcon_shipments') && new URL(response.url()).searchParams.get('select')?.includes('flexcon_destinations'))
        await page.keyboard.press('ArrowRight')
        await refreshed
        assert.equal(await historyTab.getAttribute('aria-selected'), 'true')
        assert.equal(await historyTab.evaluate(element => document.activeElement === element), true)
        assert.equal(await rows.count(), 1, 'History filters survive tab switching and refreshed data')
        assert.ok(historyReads >= 2, 'Opening history refreshes the server records')
        await openDestinationFilter()
        const search = page.getByRole('searchbox', { name: '納品先を文字で絞り込む', exact: true })
        assert.equal(await search.inputValue(), '納品先A')
        await search.fill('')
        await search.press('Escape')
        await rows.filter({ hasText: '納品先B' }).waitFor()
        assert.equal(await rows.count(), 2)
        assert.equal(await historyPanel.getByRole('button', { name: /出荷履歴を編集/ }).count(), 2)
        assert.equal(await historyPanel.getByRole('button', { name: /出荷履歴を削除/ }).count(), scenario.role === 'admin' ? 2 : 0)
        await historyTab.focus()
        await page.keyboard.press('Home')
        assert.equal(await registerTab.getAttribute('aria-selected'), 'true')
        await page.keyboard.press('End')
        assert.equal(await historyTab.getAttribute('aria-selected'), 'true')
      }
      await page.evaluate(() => window.scrollTo(0, 0))
      for (const tab of await tabs.getByRole('tab').all()) {
        const rect = await tab.boundingBox()
        assert.ok(rect.x >= 0 && rect.x + rect.width <= scenario.width)
      }
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `shipment-history-${scenario.role}-${scenario.width}.png`) })
      assert.deepEqual(errors, [])
      console.log(`PASS shipment tabs ${scenario.role} ${scenario.width}px: navigation, permissions, drafts, filters, fresh data and keyboard access`)
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}
