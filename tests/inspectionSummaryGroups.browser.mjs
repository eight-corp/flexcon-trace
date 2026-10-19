import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { undoDatabase } from './fixtures/undoDatabase.mjs'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const { db, rpc } = await undoDatabase()
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    const errors = [], deletes = []
    try {
      const call = (name, args, actor = 'tester') => rpc(actor, name, { p_worker_id: actor, ...args })
      const option = (type, name) => call('flexcon_save_inspection_option', { p_option_id: null, p_option_type: type, p_name: name }, 'admin')
      const warehouse = await option('warehouse', 'Group Place')
      await option('location', 'Group Place')
      await option('inspector', 'Tester')
      await option('brand_aomori', 'Rice A')
      await option('brand_aomori', 'Rice B')
      const producer = no => call('flexcon_add_authorization', { p_authorization_no: no, p_full_name: 'Group Producer', p_seed_purchase_slip: false, p_farming_plan: false, p_prefecture: '青森県', p_municipality: 'Test', p_address: no, p_phone: '', p_crop_type: '', p_feed_rice_variety: '', p_notes: '' })
      const first = await producer('901'), second = await producer('902')
      const add = (authorization, brand, date, counts = {}) => call('flexcon_add_inspection_group_with_warehouse', {
        p_authorization_id: authorization, p_fiscal_year: 8, p_purchase_date: '2026-10-04', p_inspection_date: date,
        p_inspection_location: 'Group Place', p_brand: brand, p_flexcon_count: 2, p_paper_bag_count: 5,
        p_flexcon_quantity_kg: 1020, p_bulk_quantity_kg: 50, p_warehouse_id: warehouse, p_settlement_no: 'GROUP', ...counts,
      })
      await add(first, 'Rice A', '2026-10-04')
      await add(first, 'Rice B', '2026-10-04')
      await add(first, 'Rice A', '2026-10-06', { p_flexcon_count: 1, p_paper_bag_count: 0, p_bulk_quantity_kg: 0 })
      await add(second, 'Rice A', '2026-10-04', { p_flexcon_count: 1, p_paper_bag_count: 0, p_bulk_quantity_kg: 0 })
      await db.exec("update flexcon_inspection_flexcons set grade='1等',moisture=13,moisture_values='{13}',inspector_name='Tester'; update flexcon_inspection_paper_bags set grade='1等',moisture=13,inspector_name='Tester'; update flexcon_inspection_flexcons set purchase_date='2026-10-05' where brand='Rice B' and record_kind='standard'")
      const original = (await db.query('select to_jsonb(t) row from flexcon_inspection_flexcons t order by id')).rows
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://summary-groups.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.resolve('dist', pathname === '/' ? 'index.html' : `.${pathname}`)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      await context.route('**/rest/v1/**', async route => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        try {
          let body
          if (resource === 'rpc/business_session') body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'operator' } }
          else if (resource.startsWith('rpc/')) {
            const fn = resource.slice(4), args = route.request().postDataJSON()
            assert.ok(['flexcon_delete_inspection_summary_group', 'flexcon_get_undo_status', 'flexcon_undo_last_operation'].includes(fn))
            if (fn === 'flexcon_delete_inspection_summary_group') {
              deletes.push(args)
              args.p_flexcon_ids = `{${args.p_flexcon_ids.join(',')}}`
              args.p_paper_bag_ids = `{${args.p_paper_bag_ids.join(',')}}`
            }
            body = await rpc('tester', fn, args)
          } else {
            assert.match(resource, /^flexcon_[a-z_]+$/)
            body = (await db.query(`select to_jsonb(t) data from public.${resource} t`)).rows.map(row => row.data)
          }
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
        } catch (error) {
          errors.push(error.message)
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: error.message }) })
        }
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.goto('https://summary-groups.test/')
      await page.getByRole('button', { name: '検査記録', exact: true }).click()
      const table = page.locator('.inspection-summary-table'), rows = table.locator('tbody tr')
      await page.waitForFunction(() => document.querySelectorAll('.inspection-summary-table tbody tr').length === 8)
      const firstRows = rows.filter({ has: page.locator('td:nth-child(2)', { hasText: /^901$/ }) })
      const groupRow = (brand, kind) => firstRows.filter({ has: page.locator('td:nth-child(5)', { hasText: '令和8年10月4日' }) }).filter({ has: page.getByRole('cell', { name: brand, exact: true }) }).filter({ has: page.getByRole('cell', { name: kind, exact: true }) })
      assert.equal(await firstRows.count(), 7)
      for (const brand of ['Rice A', 'Rice B']) for (const kind of ['推フレ', 'バラ', '紙袋']) assert.equal(await groupRow(brand, kind).count(), 1)
      const totals = await rows.evaluateAll(items => items.reduce((total, row) => {
        const value = index => Number(row.children[index].textContent.replace(/[^0-9]/g, ''))
        return total + value(15) + value(16)
      }, 0))
      assert.equal(totals, 6520)
      for (const kind of ['推フレ', 'バラ', '紙袋']) {
        await groupRow('Rice A', kind).click()
        await page.locator('.producer-inspection-page').waitFor()
        assert.equal(await page.locator('.inspection-detail-table').first().locator('tbody tr[id]').count(), 5)
        assert.equal(await page.locator('.inspection-detail-table').nth(1).locator('tbody tr[id]').count(), 2)
        assert.equal(await page.locator('.paper-detail-table tbody tr[id]').count(), 2)
        await page.getByRole('button', { name: '検査記録へ戻る', exact: true }).click()
        await groupRow('Rice A', kind).waitFor()
      }
      const search = async (label, value) => {
        const trigger = table.getByRole('button', { name: `${label}を絞り込む`, exact: true })
        await trigger.scrollIntoViewIfNeeded()
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await trigger.click()
        await page.getByRole('searchbox', { name: `${label}を文字で絞り込む`, exact: true }).fill(value)
        await page.keyboard.press('Escape')
      }
      await search('種類', '紙袋')
      assert.equal(await rows.count(), 2)
      await search('銘柄', 'Rice A')
      assert.equal(await rows.count(), 1)
      await groupRow('Rice A', '紙袋').click()
      await page.getByRole('button', { name: '検査記録へ戻る', exact: true }).click()
      assert.equal(await rows.count(), 1)
      await page.getByRole('button', { name: '絞り込み解除', exact: true }).click()
      const undoButton = page.getByRole('button', { name: '直前の操作を取り消す', exact: true })
      for (const [brand, kind] of [['Rice A', '推フレ'], ['Rice A', '紙袋'], ['Rice B', 'バラ']]) {
        const row = groupRow(brand, kind)
        let confirmation = ''
        page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.dismiss() })
        await row.getByRole('button', { name: /の行を削除$/ }).click()
        assert.match(confirmation, new RegExp(`${brand}・${kind}`))
        assert.match(confirmation, /同じ検査日でも他の銘柄・種類/)
        const count = deletes.length
        page.once('dialog', dialog => dialog.accept())
        await row.getByRole('button', { name: /の行を削除$/ }).click()
        await page.waitForFunction(() => document.querySelectorAll('.inspection-summary-table tbody tr').length === 7)
        assert.equal(deletes.length, count + 1)
        assert.equal(deletes.at(-1).p_brand, brand)
        assert.equal(deletes.at(-1).p_record_kind, { 推フレ: 'standard', バラ: 'bulk', 紙袋: 'paper' }[kind])
        assert.equal(await row.count(), 0)
        assert.equal(await rows.filter({ has: page.locator('td:nth-child(2)', { hasText: /^902$/ }) }).count(), 1)
        await undoButton.click()
        const undoDialog = page.getByRole('dialog', { name: '直前の操作を取り消す' })
        await undoDialog.getByRole('button', { name: '取り消す', exact: true }).click()
        await page.waitForFunction(() => document.querySelectorAll('.inspection-summary-table tbody tr').length === 8)
        await page.getByRole('button', { name: '通知を閉じる', exact: true }).click()
        assert.deepEqual((await db.query('select to_jsonb(t) row from flexcon_inspection_flexcons t order by id')).rows, original)
      }
      await search('仕入日', '令和8年10月5日')
      assert.equal(await rows.count(), 1)
      await page.getByRole('tab', { name: '集計', exact: true }).click()
      assert.deepEqual(await page.locator('.inspection-summary-aggregate > .section-title .inspection-progress-totals strong').allTextContents(), ['2,040kg', '0kg'])
      await page.getByRole('tab', { name: '一覧', exact: true }).click()
      await page.getByRole('button', { name: '絞り込み解除', exact: true }).click()
      if (process.env.QA_ARTIFACTS) {
        await table.getByRole('columnheader', { name: '種類 種類を絞り込む', exact: true }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `summary-groups-${width}.png`) })
      }
      assert.deepEqual(errors, [])
      console.log(`PASS summary brand/kind rows, all-producer details, row-only deletion/undo, date aggregation ${width}px`)
    } finally { await context.close(); await db.close() }
  }
} finally { await browser.close() }
