import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { chromium } from 'playwright'

const root = path.resolve('dist')
const artifacts = process.env.QA_ARTIFACTS
if (artifacts) fs.mkdirSync(artifacts, { recursive: true })
const authorizationId = '00000000-0000-0000-0000-000000000001'
const registrationId = '00000000-0000-0000-0000-000000000002'
const records = {
  flexcon_authorizations: [{ id: authorizationId, authorization_no: '1', full_name: 'QR Test Producer', prefecture: '青森県', address: 'Test address', feed_rice_variety: '' }],
  flexcon_inspection_registrations: [{ id: registrationId, registration_no: 1, authorization_id: authorizationId, settlement_no: 'TEST', created_at: '2026-10-06T00:00:00Z' }],
  flexcon_inspection_flexcons: ['standard', 'bulk'].map((record_kind, index) => ({
    id: `00000000-0000-0000-0000-${String(index + 3).padStart(12, '0')}`,
    authorization_id: authorizationId, registration_id: registrationId, record_kind,
    flexcon_no: index + 1, lot_number: `2026000100${index + 1}`, fiscal_year: 8,
    purchase_date: '2026-10-06', inspection_date: '2026-10-06', inspector_name: 'Tester',
    inspection_location: 'A', brand: 'Rice', quantity_kg: 1020, grade: '1等',
    reason: '', moisture: 15, moisture_values: [], certificate_print_count: 0,
  })),
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    for (const permission of ['admin', 'operator']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
      const errors = []
      try {
        // Capture only test PDF outputs and inspect the management QR area of its overlay.
        await context.addInitScript(() => {
          localStorage.setItem('business.session.v1', 'mock-session')
          window.qrTest = { outputs: [], qrPixels: [] }
          const createObjectURL = URL.createObjectURL.bind(URL)
          URL.createObjectURL = blob => {
            if (blob.type === 'application/pdf') window.qrTest.outputs.push(blob)
            return createObjectURL(blob)
          }
          const toBlob = HTMLCanvasElement.prototype.toBlob
          HTMLCanvasElement.prototype.toBlob = function (...args) {
            if (this.width > 2000) {
              const pixels = this.getContext('2d').getImageData(84 * 4, 310 * 4, 75 * 4, 75 * 4).data
              let dark = 0
              for (let index = 0; index < pixels.length; index += 4) {
                if (pixels[index + 3] > 128 && pixels[index] < 128) dark++
              }
              window.qrTest.qrPixels.push(dark)
            }
            return toBlob.apply(this, args)
          }
          window.open = () => null
          HTMLAnchorElement.prototype.click = function () {}
        })
        await context.route('**/*', route => route.abort())
        await context.route('https://certificate.test/**', route => {
          const pathname = new URL(route.request().url()).pathname
          const file = path.join(root, pathname === '/' ? 'index.html' : pathname)
          const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.pdf': 'application/pdf' }[path.extname(file)] || 'application/octet-stream'
          return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
        })
        await context.route('**/rest/v1/**', async route => {
          const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
          const body = resource === 'rpc/business_session'
            ? { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: permission } }
            : records[resource] ?? []
          if (resource.startsWith('rpc/') && resource !== 'rpc/business_session') errors.push(`Unexpected RPC: ${resource}`)
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
        })
        const page = await context.newPage()
        page.on('pageerror', error => errors.push(error.message))
        await page.goto('https://certificate.test/')
        await page.getByRole('button', { name: '検査記録', exact: true }).click()
        await page.locator('.inspection-summary-table tbody tr').first().click()
        await page.locator('.producer-inspection-page').waitFor()
        const dialog = page.getByRole('dialog', { name: '検査証明書作成', exact: true })
        const qrSwitch = dialog.getByRole('switch', { name: 'QRコードを付ける', exact: true })
        const openDialog = async kind => {
          await page.locator('.inspection-detail-section').filter({ has: page.getByRole('heading', { name: kind, exact: true }) }).getByRole('button', { name: '検査証明書作成', exact: true }).click()
          await dialog.waitFor()
          if (permission === 'admin') assert.equal(await qrSwitch.getAttribute('aria-checked'), 'false')
          else assert.equal(await qrSwitch.count(), 0)
        }
        const generate = async (name, expectedQr) => {
          const before = await page.evaluate(() => window.qrTest.outputs.length)
          await dialog.getByRole('button', { name: 'PDFを作成', exact: true }).click()
          await dialog.getByText('1ページのPDFを作成しました', { exact: true }).waitFor()
          const result = await page.evaluate(async () => ({
            count: window.qrTest.outputs.length,
            dark: window.qrTest.qrPixels.at(-1),
            bytes: Array.from(new Uint8Array(await window.qrTest.outputs.at(-1).arrayBuffer())),
          }))
          assert.equal(result.count, before + 1)
          assert.ok(expectedQr ? result.dark > 10000 : result.dark === 0, `QR pixels for ${name}: ${result.dark}`)
          const pdf = await PDFDocument.load(Uint8Array.from(result.bytes))
          assert.equal(pdf.getPageCount(), 1)
          if (artifacts && width === 1440) fs.writeFileSync(path.join(artifacts, `${permission}-${name}.pdf`), Uint8Array.from(result.bytes))
          await dialog.locator('.certificate-created-panel').getByRole('button', { name: '閉じる', exact: true }).click()
        }
        for (const [kind, name] of [['推フレ', 'standard'], ['バラ', 'bulk']]) {
          await openDialog(kind)
          if (artifacts) await page.screenshot({ path: path.join(artifacts, `${permission}-${name}-off-${width}.png`) })
          await generate(`${name}-off`, false)
          if (permission === 'admin') {
            await openDialog(kind)
            await qrSwitch.click()
            assert.equal(await qrSwitch.getAttribute('aria-checked'), 'true')
            if (artifacts) await page.screenshot({ path: path.join(artifacts, `${permission}-${name}-on-${width}.png`) })
            await generate(`${name}-on`, true)
            await openDialog(kind)
            await dialog.getByRole('button', { name: '取り消し', exact: true }).click()
          }
        }
        assert.deepEqual(errors, [])
        console.log(`Certificate QR defaults OFF and is opt-in for ${permission} at ${width}px`)
      } finally {
        await context.close()
      }
    }
  }
} finally {
  await browser.close()
}
