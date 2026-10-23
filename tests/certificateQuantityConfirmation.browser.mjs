import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { PDFDocument } from 'pdf-lib'

const artifacts = process.env.QA_ARTIFACTS || process.argv[2]
const base = { authorization_id: 'a', registration_id: 'r', fiscal_year: 8, purchase_date: '2026-10-23', inspection_date: '2026-10-23', inspection_location: '検査場', inspector_name: '検査員', grade: '1等', moisture: 13, reason: '', record_kind: 'standard', certificate_print_count: 0 }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) for (const scenario of ['changed-only', 'mixed']) {
    const flexcons = (scenario === 'changed-only'
      ? Array.from({ length: 40 }, () => ({ brand: 'まっしぐら', quantity_kg: 1080 }))
      : [{ brand: 'まっしぐら', quantity_kg: 1020 }, { brand: 'まっしぐら', quantity_kg: 1080 }, { brand: '飼料用玄米', quantity_kg: 1030, grade: '合格' }, { brand: '飼料用玄米', quantity_kg: 1000, grade: '合格' }, { brand: 'まっしぐら', quantity_kg: 125, record_kind: 'bulk' }])
      .map((item, index) => ({ ...base, ...item, id: `f${index + 1}`, flexcon_no: index + 1, lot_number: `20260600${String(index + 1).padStart(3, '0')}` }))
    const data = {
      flexcon_authorizations: [{ id: 'a', authorization_no: '600', full_name: '証明書確認用', address: '青森県', prefecture: '青森県', feed_rice_variety: '飼料用品種' }],
      flexcon_inspection_registrations: [{ id: 'r', authorization_id: 'a', registration_no: 1 }],
      flexcon_inspection_flexcons: flexcons,
      flexcon_inspection_weights: [{ weight_type: 'feed_rice', weight_kg: 1000 }, { weight_type: 'branded_rice', weight_kg: 1020 }],
    }
    const original = structuredClone(data)
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' })
    const errors = [], mutations = [], dialogs = []
    let decision = 'accept'
    try {
      await context.addInitScript(() => {
        localStorage.setItem('business.session.v1', 'mock-session')
        window.certificatePdfs = []
        window.certificateTexts = []
        const fillText = CanvasRenderingContext2D.prototype.fillText
        CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
          window.certificateTexts.push(text)
          return fillText.call(this, text, ...args)
        }
        const createObjectURL = URL.createObjectURL.bind(URL)
        URL.createObjectURL = blob => {
          if (blob.type === 'application/pdf') window.certificatePdfs.push(blob)
          return createObjectURL(blob)
        }
      })
      await context.route('**/*', route => route.abort())
      await context.route('https://certificate.test/**', route => {
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
      page.on('dialog', async dialog => {
        dialogs.push(dialog.message())
        if (decision === 'accept') await dialog.accept()
        else await dialog.dismiss()
      })
      await page.clock.setFixedTime('2026-10-23T12:00:00+09:00')
      await page.goto('https://certificate.test/')
      await page.getByRole('button', { name: '検査記録', exact: true }).click()
      await page.locator('.inspection-summary-table tbody tr').first().click()
      await page.locator('.producer-inspection-page').waitFor()
      const modal = page.getByRole('dialog', { name: '検査証明書作成', exact: true })
      const open = async (section = 0) => {
        const button = page.locator('.inspection-detail-section').nth(section).getByRole('button', { name: '検査証明書作成', exact: true })
        assert.equal(await button.isEnabled(), true)
        await button.click()
        await modal.waitFor()
      }
      const range = async (start, count) => {
        await modal.getByLabel('開始№', { exact: true }).fill(String(start))
        await modal.getByLabel('枚数', { exact: true }).fill(String(count))
      }
      const generate = async (pages, expectedQuantity) => {
        const before = await page.evaluate(() => window.certificatePdfs.length)
        await modal.getByRole('button', { name: 'PDFを作成', exact: true }).click()
        await page.waitForFunction(count => window.certificatePdfs.length === count + 1, before)
        await modal.getByText(`${pages}ページのPDFを作成しました`, { exact: true }).waitFor()
        assert.equal(await page.evaluate(text => window.certificateTexts.includes(text), expectedQuantity), true)
        const bytes = Buffer.from(await page.evaluate(async () => [...new Uint8Array(await window.certificatePdfs.at(-1).arrayBuffer())]))
        assert.equal((await PDFDocument.load(bytes)).getPageCount(), pages)
        if (artifacts) {
          fs.mkdirSync(artifacts, { recursive: true })
          fs.writeFileSync(path.join(artifacts, `certificate-${scenario}-${width}-${expectedQuantity.replaceAll(',', '')}.pdf`), bytes)
        }
        await modal.locator('.modal-actions').getByRole('button', { name: '閉じる', exact: true }).click()
      }
      await open()
      if (scenario === 'changed-only') {
        assert.equal(await modal.getByLabel('開始№', { exact: true }).inputValue(), '1')
        assert.equal(await modal.getByLabel('枚数', { exact: true }).inputValue(), '40')
        await range(1, 2)
        decision = 'dismiss'
        await modal.getByRole('button', { name: 'PDFを作成', exact: true }).click()
        assert.match(dialogs.at(-1), /№1～2（2本）/)
        assert.match(dialogs.at(-1), /現在：1,080kg／本　初期値：1,020kg／本/)
        assert.equal(await page.evaluate(() => window.certificatePdfs.length), 0)
        assert.equal(context.pages().length, 1, 'Cancel must not open a blank PDF tab')
        assert.equal(await modal.getByLabel('枚数', { exact: true }).inputValue(), '2')
        decision = 'accept'
        await generate(2, '1,080')
        assert.equal(dialogs.length, 2, 'Retry must ask again rather than retain an old approval')
      } else {
        await range(1, 4)
        decision = 'dismiss'
        await modal.getByRole('button', { name: 'PDFを作成', exact: true }).click()
        assert.match(dialogs.at(-1), /まっしぐら　№2（1本）/)
        assert.match(dialogs.at(-1), /飼料用玄米　№3（1本）/)
        assert.doesNotMatch(dialogs.at(-1), /№1|№4/)
        await range(1, 1)
        const previous = dialogs.length
        await generate(1, '1,020')
        assert.equal(dialogs.length, previous, 'Other out-of-range quantities must not trigger confirmation')
        await open()
        await range(3, 1)
        decision = 'accept'
        await generate(1, '1,030')
        assert.match(dialogs.at(-1), /現在：1,030kg／本　初期値：1,000kg／本/)
        const beforeBulk = dialogs.length
        await open(1)
        await generate(1, '125')
        assert.equal(dialogs.length, beforeBulk, 'Bulk does not use the per-standard-flexcon initial weight')
      }
      assert.deepEqual(mutations, [], 'Generating or cancelling a PDF must not change quantities or printed flags')
      assert.deepEqual(data, original)
      assert.deepEqual(errors, [])
      console.log(`PASS ${width}px ${scenario}: availability, range-scoped confirmation, cancel/retry, actual PDF quantity, unchanged records and flags`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
