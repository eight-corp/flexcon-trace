import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const base = { authorization_id: 'a', registration_id: 'r', fiscal_year: 8, purchase_date: '2026-10-01', inspection_location: 'A', inspector_name: 'Tester', brand: 'Rice A', grade: '1等', moisture: 13, reason: '', certificate_print_count: 0, settlement_no: 'TEST' }
const flexcons = Array.from({ length: 57 }, (_, index) => {
  const no = index + 1
  return { ...base, id: `f${no}`, flexcon_no: no, lot_number: String(no), quantity_kg: no > 50 && no < 57 ? 75 : 1020,
    record_kind: no > 50 && no < 57 ? 'bulk' : 'standard', brand: no <= 40 ? 'Rice A' : no < 57 ? 'Rice B' : 'Rice C',
    certificate_print_count: no === 41 || no === 42 ? 1 : 0,
    purchase_date: no > 40 ? `2026-10-${String(Math.min(no - 30, 28)).padStart(2, '0')}` : base.purchase_date,
    inspection_date: no <= 40 ? no <= 30 ? `2026-09-${String(no).padStart(2, '0')}` : `2026-10-${String(no - 30).padStart(2, '0')}` : no <= 50 ? '2026-10-15' : no < 57 ? '2026-10-16' : null }
}).reverse() // Fetch order is not the same as the numbered detail display order.
const paper = Array.from({ length: 16 }, (_, index) => ({ ...base, id: `p${index + 1}`, bag_count: 10, brand: index < 10 ? 'Rice A' : 'Rice B', inspection_date: index < 10 ? '2026-10-03' : '2026-10-17', created_at: `2026-10-01T00:00:${String(index).padStart(2, '0')}Z` }))
const data = {
  flexcon_authorizations: [{ id: 'a', authorization_no: '1', full_name: 'Navigation Producer', prefecture: '青森県' }],
  flexcon_inspection_registrations: [{ id: 'r', authorization_id: 'a', registration_no: 1 }],
  flexcon_inspection_flexcons: flexcons, flexcon_inspection_paper_bags: paper,
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const viewport of [{ width: 1440, height: 800 }, { width: 820, height: 480 }, { width: 390, height: 800 }]) {
    const context = await browser.newContext({ viewport, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' })
    const errors = [], mutations = []
    try {
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://inspection-navigation.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.resolve('dist', pathname === '/' ? 'index.html' : `.${pathname}`)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      await context.route('**/rest/v1/**', async route => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        let body = []
        if (resource === 'rpc/business_session') body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'operator' } }
        else if (resource === 'rpc/flexcon_get_undo_status') body = { operation_id: null }
        else if (route.request().method() !== 'GET') mutations.push(resource)
        else {
          // The detail component remounts and reloads records before its scroll target exists.
          if (resource === 'flexcon_inspection_flexcons') await new Promise(resolve => setTimeout(resolve, 100))
          body = data[resource] ?? []
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.clock.setFixedTime('2026-10-20T12:00:00+09:00')
      await page.goto('https://inspection-navigation.test/')
      await page.getByRole('button', { name: '検査記録', exact: true }).click()
      const table = page.locator('.inspection-summary-table')
      const summaryRow = (date, brand, kind) => table.locator('tbody tr')
        .filter({ has: page.locator('td:nth-child(5)', { hasText: date ? new RegExp(`^${date}$`) : /^$/ }) })
        .filter({ has: page.getByRole('cell', { name: brand, exact: true }) })
        .filter({ has: page.getByRole('cell', { name: kind, exact: true }) })
      const scenarios = [
        { date: '令和8年10月15日', brand: 'Rice B', kind: '推フレ', target: 'f41', keyboard: true },
        { date: '令和8年10月16日', brand: 'Rice B', kind: 'バラ', target: 'f51' },
        { date: '令和8年10月17日', brand: 'Rice B', kind: '紙袋', target: 'p11' },
        { date: '', brand: 'Rice C', kind: '推フレ', target: 'f57' },
      ]
      for (const scenario of scenarios) {
        const row = summaryRow(scenario.date, scenario.brand, scenario.kind)
        await row.waitFor()
        if (scenario.keyboard) { await row.focus(); await row.press('Enter') } else await row.click()
        const target = page.locator(`#inspection-record-${scenario.target}.inspection-target-row`)
        await target.waitFor()
        await page.waitForFunction(id => {
          const row = document.getElementById(`inspection-record-${id}`)
          const detail = document.querySelector('.producer-inspection-page')
          const heading = document.querySelector('.producer-inspection-heading')
          if (!row || !detail || !heading || detail.scrollTop <= 0) return false
          const box = row.getBoundingClientRect(), container = detail.getBoundingClientRect(), header = heading.getBoundingClientRect()
          return box.top >= Math.max(container.top, header.bottom) - 1 && box.bottom <= Math.min(container.bottom, window.innerHeight) + 1
        }, scenario.target)
        const expectedIds = (scenario.target === 'f41' ? Array.from({ length: 10 }, (_, i) => `f${41 + i}`)
          : scenario.target === 'f51' ? Array.from({ length: 6 }, (_, i) => `f${51 + i}`)
          : scenario.target === 'p11' ? Array.from({ length: 6 }, (_, i) => `p${11 + i}`) : ['f57'])
          .map(id => `inspection-record-${id}`)
        assert.deepEqual(await page.locator('.inspection-target-row').evaluateAll(rows => rows.map(row => row.id)), expectedIds, 'Highlight all and only the matching group')
        await page.mouse.move(5, 5)
        const styles = await page.locator('.inspection-target-row').evaluateAll(rows => rows.map(row => {
          const style = getComputedStyle(row)
          const fields = [...row.querySelectorAll('input,select')]
          const colors = () => [getComputedStyle(row).backgroundColor, ...fields.map(field => [getComputedStyle(field).backgroundColor, getComputedStyle(field).borderColor])]
          const result = {
            top: style.getPropertyValue('--inspection-target-top').trim(),
            bottom: style.getPropertyValue('--inspection-target-bottom').trim(),
            shadow: style.boxShadow,
            before: colors(),
          }
          row.classList.remove('inspection-target-row')
          result.after = colors()
          row.classList.add('inspection-target-row')
          return result
        }))
        for (const [index, style] of styles.entries()) {
          assert.equal(style.top, index === 0 ? '2px' : '0px', 'Only the group start has a top border')
          assert.equal(style.bottom, index === styles.length - 1 ? '-2px' : '0px', 'Only the group end has a bottom border')
          assert.match(style.shadow, /rgb\(49, 119, 173\)/)
          assert.deepEqual(style.before, style.after, 'Selection must preserve row and field colors, including printed status')
        }
        assert.equal(await page.locator('.inspection-detail-table tbody tr[id]').count(), 73, 'Other records stay available')
        assert.equal(await target.locator('..').evaluate(tbody => tbody.closest('.inspection-detail-table-wrap').scrollLeft), 0)
        if (process.env.QA_ARTIFACTS && scenario.kind === 'バラ') await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `summary-target-${viewport.width}.png`) })
        await page.getByRole('button', { name: '検査記録へ戻る', exact: true }).click()
        await row.waitFor()
        assert.equal(await page.locator('.inspection-target-row').count(), 0)
      }
      // Reopening the same group must scroll again, not reuse the prior detail scroll position.
      await summaryRow(scenarios[0].date, 'Rice B', '推フレ').click()
      await page.locator('#inspection-record-f41.inspection-target-row').waitFor()
      await page.waitForFunction(() => document.querySelector('.producer-inspection-page')?.scrollTop > 0)
      assert.deepEqual(mutations, [])
      assert.deepEqual(errors, [])
      console.log(`PASS ${viewport.width}x${viewport.height}: group outline only, original colors, first display order, delayed loading, click/Enter, all kinds, undated, reopening and full details`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
