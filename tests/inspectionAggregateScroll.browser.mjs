import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const root = path.resolve('dist')
const artifacts = process.env.QA_ARTIFACTS
if (artifacts) fs.mkdirSync(artifacts, { recursive: true })
const authorizationId = '00000000-0000-0000-0000-000000000001'
const registrationId = '00000000-0000-0000-0000-000000000002'
const base = { authorization_id: authorizationId, registration_id: registrationId, fiscal_year: 8, purchase_date: '2026-10-06', inspection_date: '2026-10-06', inspection_location: 'A', inspector_name: 'Tester', moisture: 15, grade: '1等', moisture_values: [] }
const records = {
  flexcon_authorizations: [{ id: authorizationId, authorization_no: '1', full_name: 'Scroll Test Producer', prefecture: '青森県' }],
  flexcon_inspection_registrations: [{ id: registrationId, registration_no: 1, authorization_id: authorizationId, settlement_no: 'TEST' }],
  flexcon_inspection_options: Array.from({ length: 8 }, (_, index) => ({ id: `grade-${index}`, option_type: 'grade', name: `${index + 1}等`, active: true })),
  flexcon_inspection_flexcons: Array.from({ length: 30 }, (_, index) => ({ ...base, id: `flexcon-${index}`, flexcon_no: index + 1, record_kind: 'standard', lot_number: String(index + 1), brand: `Rice ${index + 1}`, quantity_kg: 1020 })),
  flexcon_inspection_paper_bags: Array.from({ length: 30 }, (_, index) => ({ ...base, id: `paper-${index}`, brand: `Rice ${index + 1}`, bag_count: 10, inspection_date: index % 2 ? null : base.inspection_date })),
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const [width, height] of [[1440, 640], [980, 480], [820, 640], [390, 640]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' })
    const errors = []
    try {
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://scroll.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.join(root, pathname === '/' ? 'index.html' : pathname)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      await context.route('**/rest/v1/**', async route => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        const body = resource === 'rpc/business_session'
          ? { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'admin' } }
          : records[resource] ?? []
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.goto('https://scroll.test/')
      await page.getByRole('button', { name: '検査記録', exact: true }).click()
      await page.locator('.inspection-summary-table tbody tr').first().waitFor()
      await page.getByRole('tab', { name: '集計', exact: true }).click()
      const paper = page.getByRole('region', { name: '紙袋の集計', exact: true })
      const lastSummary = paper.locator('.inspection-record-detail-list.uninspected summary')
      // Real wheel input must reveal the bottom of the aggregate, not just move a clipped child.
      await page.mouse.move(width - 8, height / 2)
      await page.mouse.wheel(0, 10000)
      await page.waitForFunction(() => {
        const summary = document.querySelector('[data-kind="paper"] .uninspected summary')
        const box = summary?.getBoundingClientRect()
        const nav = document.querySelector('.bottom-nav').getBoundingClientRect()
        const bottom = nav.top > innerHeight / 2 ? nav.top : innerHeight
        return window.scrollY > 0 && box && box.top >= 64 && box.bottom <= bottom
      }, null, { timeout: 3000 })
      await lastSummary.click()
      assert.equal(await paper.locator('.inspection-record-detail-list.uninspected').getAttribute('open'), '')
      await page.mouse.move(width - 8, height / 2)
      await page.mouse.wheel(0, 10000)
      const detailWrap = paper.locator('.inspection-record-detail-list.uninspected .inspection-record-detail-table-wrap')
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-kind="paper"] .uninspected .inspection-record-detail-table-wrap')
        const box = el.getBoundingClientRect()
        const nav = document.querySelector('.bottom-nav').getBoundingClientRect()
        return box.bottom <= (nav.top > innerHeight / 2 ? nav.top : innerHeight)
      })
      await detailWrap.evaluate(el => { el.scrollTop = el.scrollHeight; el.scrollLeft = el.scrollWidth })
      assert.ok(await detailWrap.evaluate(el => el.scrollTop > 0 && (el.scrollWidth <= el.clientWidth || el.scrollLeft > 0)))
      const lastRow = detailWrap.locator('tbody tr').last()
      const lastBox = await lastRow.boundingBox()
      const wrapBox = await detailWrap.boundingBox()
      assert.ok(lastBox.y + lastBox.height <= wrapBox.y + wrapBox.height)
      if (artifacts) await page.screenshot({ path: path.join(artifacts, `aggregate-bottom-${width}x${height}.png`) })

      const tableWrap = paper.locator('.inspection-progress-table-wrap')
      await tableWrap.scrollIntoViewIfNeeded()
      const canScrollHorizontally = await tableWrap.evaluate(el => el.scrollWidth > el.clientWidth)
      if (width === 390) assert.equal(canScrollHorizontally, true)
      if (canScrollHorizontally) {
        await tableWrap.hover()
        await page.mouse.wheel(2000, 0)
        await page.waitForFunction(() => document.querySelector('[data-kind="paper"] .inspection-progress-table-wrap').scrollLeft > 0)
      }
      await page.getByRole('button', { name: '検査記録', exact: true }).click()
      await page.getByRole('tab', { name: '一覧', exact: true }).click()
      assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).height === `${el.scrollHeight}px` || getComputedStyle(el).overflowY !== 'hidden'), true)
      assert.deepEqual(errors, [])
      console.log(`Aggregate page and tables scroll to all content at ${width}x${height}`)
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}
