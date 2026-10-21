import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const root = path.resolve('dist')
const shipments = Array.from({ length: 80 }, (_, index) => ({
  id: `shipment-${index}`, destination_id: `destination-${index}`,
  shipped_at: '2026-10-21T03:00:00Z', shipment_kind: 'manual_record',
  origin_prefecture: '青森県', product_name: '米', quantity_count: 1,
  flexcon_destinations: { name: `納品先${String(index + 1).padStart(3, '0')}` },
  workers: { worker_name: 'Tester' }, flexcon_shipment_items: [],
  flexcon_manual_shipment_items: [{
    id: `item-${index}`, crop_year: 2026, origin_prefecture: '青森県',
    product_name: '米', quantity_count: 1, unit: '本', grade: '1等',
    moisture: null, reason: null, sort_order: 0,
  }],
}))

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const viewport of [
    { width: 1440, height: 640 }, { width: 980, height: 480 },
    { width: 820, height: 480 }, { width: 390, height: 640 },
  ]) {
    const context = await browser.newContext({ viewport, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' })
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
        const body = resource === 'rpc/business_session'
          ? { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'operator' } }
          : resource === 'flexcon_shipments' ? shipments : []
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.clock.setFixedTime('2026-10-21T12:00:00+09:00')
      await page.goto('https://shipment.test/')
      await page.getByRole('button', { name: '出荷記録', exact: true }).click()
      await page.getByRole('tab', { name: '履歴', exact: true }).click()
      const wrap = page.locator('.shipment-table-wrap')
      const rows = wrap.locator('tbody tr')
      await rows.nth(79).waitFor({ state: 'attached' })
      // Move to the table's bottom edge without bypassing any ancestor clipping.
      await wrap.evaluate(element => window.scrollTo(0, element.getBoundingClientRect().bottom + scrollY - innerHeight + (innerWidth < 960 ? 74 : 0)))
      const geometry = await wrap.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const top = document.querySelector('.app-top').getBoundingClientRect().bottom
        const nav = document.querySelector('.bottom-nav').getBoundingClientRect()
        const bottom = nav.top > top ? nav.top : innerHeight
        const main = document.querySelector('.app-main').getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, availableBottom: bottom, mainBottom: main.bottom }
      })
      assert.ok(geometry.bottom <= geometry.availableBottom + 1, `Table bottom must be reachable: ${JSON.stringify({ viewport, geometry })}`)
      assert.ok(geometry.bottom <= geometry.mainBottom + 1, 'Table must not be clipped by main')
      await wrap.hover({ position: { x: 150, y: (await wrap.boundingBox()).height - 40 } })
      await page.mouse.wheel(0, 10000)
      await page.waitForFunction(() => {
        const element = document.querySelector('.shipment-table-wrap')
        return element.scrollTop >= element.scrollHeight - element.clientHeight - 2
      })
      assert.equal(await rows.last().evaluate(element => {
        const row = element.getBoundingClientRect()
        const wrap = element.closest('.shipment-table-wrap').getBoundingClientRect()
        return row.top >= wrap.top && row.bottom <= wrap.bottom
      }), true, 'Last table row can be read')
      const heading = wrap.locator('thead th').first()
      assert.ok(Math.abs((await heading.boundingBox()).y - (await wrap.boundingBox()).y) < 3, 'Header remains sticky')
      const cell = rows.last().locator('td').first()
      const before = await cell.boundingBox()
      await wrap.evaluate(element => { element.scrollLeft = 500 })
      assert.ok(Math.abs((await cell.boundingBox()).x - before.x) < 2, 'Edit actions remain available after horizontal scrolling')
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `shipment-scroll-${viewport.width}.png`) })
      await page.getByRole('button', { name: 'パネル表示' }).click()
      const lastCard = page.locator('.shipment-item').last()
      await lastCard.evaluate(element => window.scrollTo(0, element.getBoundingClientRect().bottom + scrollY - innerHeight + (innerWidth < 960 ? 74 : 0)))
      const card = await lastCard.boundingBox()
      assert.ok(card.y + card.height <= viewport.height - (viewport.width < 960 ? 74 : 0) + 1, 'Last panel is reachable')
      assert.deepEqual(errors, [])
      console.log(`Shipment history scrolling passed at ${viewport.width}x${viewport.height}`)
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}
