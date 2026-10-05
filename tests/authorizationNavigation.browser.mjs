import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const root = path.resolve('dist')
const records = Array.from({ length: 160 }, (_, index) => {
  const number = index + 1
  return {
    id: `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`,
    authorization_no: String(number), full_name: `${number % 3 ? 'Producer' : 'Other'} ${number}`,
    seed_purchase_slip: false, farming_plan: false, address: 'Test address',
    prefecture: '青森県', municipality: 'Test town', phone: null,
    crop_type: null, feed_rice_variety: null, notes: null,
  }
})
const purchased = records.filter(record => Number(record.authorization_no) % 2 === 0)
const expectedNumbers = purchased.filter(record => record.full_name.startsWith('Producer'))
  .map(record => record.authorization_no).reverse()
const position = el => ({
  top: el.scrollTop, left: el.scrollLeft, pageTop: window.scrollY, pageLeft: window.scrollX,
  mainTop: el.closest('main').scrollTop, mainLeft: el.closest('main').scrollLeft,
})
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    const errors = []
    try {
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://authorization.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.join(root, pathname === '/' ? 'index.html' : pathname)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      // Block production requests; navigation uses only these synthetic records.
      await context.route('**/rest/v1/**', async route => {
        const url = new URL(route.request().url())
        const resource = url.pathname.split('/rest/v1/')[1]
        let body = []
        if (resource === 'rpc/business_session') {
          body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'admin' } }
        } else if (resource === 'flexcon_authorizations') {
          await new Promise(resolve => setTimeout(resolve, 80))
          body = records
        } else if (resource === 'flexcon_inspection_flexcons' && url.searchParams.get('select') === 'authorization_id') {
          body = purchased.map(record => ({ authorization_id: record.id }))
        } else if (resource.startsWith('rpc/') && resource !== 'rpc/flexcon_list_memos') {
          errors.push(`Unexpected RPC: ${resource}`)
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.goto('https://authorization.test/')
      await page.getByRole('button', { name: '委任状一覧', exact: true }).click()
      const table = page.locator('.authorization-table')
      const wrap = page.locator('.authorization-table-wrap')
      const dataRows = table.locator('.authorization-data-row')
      await dataRows.first().waitFor()
      const openFilter = async label => {
        const trigger = page.getByRole('button', { name: `${label}を絞り込む`, exact: true })
        await trigger.scrollIntoViewIfNeeded()
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await trigger.click()
      }
      await openFilter('氏名')
      await page.getByRole('searchbox', { name: '氏名を文字で絞り込む', exact: true }).fill('Producer')
      await page.keyboard.press('Escape')
      await openFilter('仕入れ')
      await page.locator('.shipment-filter-menu').getByLabel('なし', { exact: true }).uncheck()
      await page.keyboard.press('Escape')
      const numberSort = table.locator('thead th').first().getByRole('button', { name: '№', exact: true })
      await numberSort.click()
      await numberSort.click()
      const numbers = () => dataRows.locator('.authorization-no').allTextContents()
      assert.deepEqual(await numbers(), expectedNumbers)

      const roundTrip = async () => {
        const cell = dataRows.nth(25).locator('.authorization-name')
        await cell.scrollIntoViewIfNeeded()
        await wrap.evaluate(el => { el.scrollLeft = 80 })
        const saved = await wrap.evaluate(position)
        assert.ok(saved.left > 0)
        assert.ok(width === 1440 ? saved.top > 0 : saved.pageTop > 0)
        const box = await cell.boundingBox()
        await page.mouse.click(Math.max(25, box.x + box.width / 2), box.y + box.height / 2)
        await page.locator('.producer-inspection-page').waitFor()
        await page.getByRole('button', { name: '委任状一覧へ戻る', exact: true }).click()
        await dataRows.first().waitFor()
        await page.waitForFunction(saved => {
          const el = document.querySelector('.authorization-table-wrap')
          if (!el) return false
          const current = {
            top: el.scrollTop, left: el.scrollLeft, pageTop: window.scrollY, pageLeft: window.scrollX,
            mainTop: el.closest('main').scrollTop, mainLeft: el.closest('main').scrollLeft,
          }
          return Object.keys(saved).every(key => Math.abs(current[key] - saved[key]) <= 1)
        }, saved)
        assert.deepEqual(await wrap.evaluate(position), saved)
      }
      await roundTrip()
      assert.deepEqual(await numbers(), expectedNumbers)
      assert.equal(await table.locator('thead th').first().getAttribute('aria-sort'), 'descending')
      await openFilter('氏名')
      assert.equal(await page.getByRole('searchbox', { name: '氏名を文字で絞り込む', exact: true }).inputValue(), 'Producer')
      await page.keyboard.press('Escape')
      await openFilter('仕入れ')
      assert.equal(await page.locator('.shipment-filter-menu').getByLabel('なし', { exact: true }).isChecked(), false)
      await page.keyboard.press('Escape')

      await page.getByRole('button', { name: '絞り込み解除', exact: true }).click()
      assert.equal(await dataRows.count(), records.length)
      await roundTrip()
      assert.equal(await dataRows.count(), records.length)
      assert.equal(await page.getByRole('button', { name: '絞り込み解除', exact: true }).isDisabled(), true)

      const beforeTabSwitch = await wrap.evaluate(position)
      await page.getByRole('button', { name: 'メモ書き', exact: true }).click()
      await page.locator('.memo-page').waitFor()
      await page.getByRole('button', { name: '委任状一覧', exact: true }).click()
      await dataRows.first().waitFor()
      assert.deepEqual(await wrap.evaluate(position), beforeTabSwitch)
      assert.equal(await table.locator('thead th').first().getAttribute('aria-sort'), 'descending')
      assert.deepEqual(errors, [])
      if (process.env.QA_ARTIFACTS) {
        fs.mkdirSync(process.env.QA_ARTIFACTS, { recursive: true })
        await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `authorization-navigation-${width}.png`) })
      }
      console.log(`Authorization navigation preserved filters, sorting and scroll at ${width}px`)
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}
