import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { PDFDocument } from 'pdf-lib'

const artifacts = process.env.QA_ARTIFACTS || process.argv[2]
const base = { authorization_id: 'a', registration_id: 'r', fiscal_year: 8, purchase_date: '2026-10-01', inspection_date: '2026-10-02', inspection_location: '検査場', inspector_name: '検査員', grade: '1等', moisture: 13, reason: '', record_kind: 'standard' }
const flexcons = [
  { brand: '飼料用玄米', grade: '合格', quantity_kg: 1030 },
  { brand: '飼料用玄米', grade: '合格', quantity_kg: 1030 },
  { brand: '飼料用玄米', grade: '合格', quantity_kg: 1000 },
  { brand: 'まっしぐら', quantity_kg: 1040 },
  { brand: 'まっしぐら', quantity_kg: 1020 },
  { brand: 'まっしぐら', quantity_kg: 125, record_kind: 'bulk' },
].map((item, index) => ({ ...base, ...item, id: `f${index}`, flexcon_no: index + 1, lot_number: String(index + 1) }))
const data = {
  flexcon_authorizations: [{ id: 'a', authorization_no: '1', full_name: '台帳確認用', address: '青森県', prefecture: '青森県', feed_rice_variety: '飼料用米品種' }],
  flexcon_inspection_registrations: [{ id: 'r', authorization_id: 'a', registration_no: 1 }],
  flexcon_inspection_flexcons: flexcons,
  flexcon_inspection_paper_bags: [{ ...base, id: 'p1', brand: 'まっしぐら', bag_count: 3 }],
  flexcon_inspection_weights: [{ weight_type: 'feed_rice', weight_kg: 1000 }, { weight_type: 'branded_rice', weight_kg: 1020 }],
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' })
    const errors = [], mutations = []
    try {
      await context.addInitScript(() => {
        localStorage.setItem('business.session.v1', 'mock-session')
        window.ledgerDraws = []
        const fillText = CanvasRenderingContext2D.prototype.fillText
        CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) {
          window.ledgerDraws.push({ text, x, y })
          window.ledgerCanvas = this.canvas
          return fillText.call(this, text, x, y, ...args)
        }
        const createObjectURL = URL.createObjectURL.bind(URL)
        URL.createObjectURL = blob => {
          if (blob.type === 'application/pdf') window.ledgerPdf = blob
          return createObjectURL(blob)
        }
      })
      await context.route('**/*', route => route.abort())
      await context.route('https://ledger.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.resolve('dist', pathname === '/' ? 'index.html' : `.${pathname}`)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      await context.route('**/rest/v1/**', async route => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        let body = []
        if (resource === 'rpc/business_session') body = { ok: true, workerId: 'tester', workerName: '確認用', permissions: { rice_shipping: 'operator' } }
        else if (resource === 'rpc/flexcon_get_undo_status') body = { operation_id: null }
        else if (route.request().method() !== 'GET') mutations.push(resource)
        else body = data[resource] || []
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.clock.setFixedTime('2026-10-23T12:00:00+09:00')
      await page.goto('https://ledger.test/')
      await page.getByRole('button', { name: '委任状一覧', exact: true }).click()
      await page.locator('.authorization-data-row').first().click()
      await page.locator('.producer-inspection-page').waitFor()
      await page.getByRole('button', { name: '検査請求者別検査台帳', exact: true }).click()
      await page.waitForFunction(() => !!window.ledgerPdf)
      const draws = await page.evaluate(() => window.ledgerDraws)
      const rows = draws.filter(d => d.text.endsWith('kg')).map(weight => ({
        weight: weight.text,
        quantity: draws.find(d => d.y === weight.y && Math.abs(d.x - 724.32) < 0.01)?.text,
      }))
      const expected = [
        { weight: '1,030kg', quantity: '2,060' }, { weight: '1,000kg', quantity: '1,000' },
        { weight: '1,040kg', quantity: '1,040' }, { weight: '1,020kg', quantity: '1,020' },
        { weight: '125kg', quantity: '125' }, { weight: '30kg', quantity: '90' },
      ]
      const sorted = rows => rows.sort((a, b) => a.weight.localeCompare(b.weight))
      assert.deepEqual(sorted(rows), sorted(expected), 'Both unit weight and total must come from actual detail quantities, including non-feed rice and bulk')
      assert.equal(rows.reduce((total, row) => total + Number(row.quantity.replaceAll(',', '')), 0), 5335)
      const bytes = Buffer.from(await page.evaluate(async () => [...new Uint8Array(await window.ledgerPdf.arrayBuffer())]))
      const pdf = await PDFDocument.load(bytes)
      assert.equal(pdf.getPageCount(), 1)
      assert.deepEqual(mutations, [], 'Ledger generation must not modify inspection records or defaults')
      assert.deepEqual(errors, [])
      if (artifacts) {
        fs.mkdirSync(artifacts, { recursive: true })
        fs.writeFileSync(path.join(artifacts, `inspection-ledger-${width}.pdf`), bytes)
        const overlay = await page.evaluate(() => window.ledgerCanvas.toDataURL('image/png'))
        fs.writeFileSync(path.join(artifacts, `inspection-ledger-overlay-${width}.png`), Buffer.from(overlay.split(',')[1], 'base64'))
      }
      console.log(`PASS ${width}px: feed rice 1030kg, branded rice 1040kg, unchanged defaults, mixed weights, bulk, paper and actual PDF`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
