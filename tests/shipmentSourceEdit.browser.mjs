import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { shipmentSourceDatabase } from './fixtures/shipmentSourceDatabase.mjs'

const root = path.resolve('dist')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const f = await shipmentSourceDatabase()
    const { db, rpc, shipmentId, warehouseA, warehouseB, emptyWarehouse, snapshot, balance, status } = f
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' })
    const errors = []
    try {
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://source.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.join(root, pathname === '/' ? 'index.html' : pathname)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      await context.route('**/rest/v1/**', async route => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        try {
          let body
          if (resource === 'rpc/business_session') body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'operator' } }
          else if (resource.startsWith('rpc/')) body = await rpc('tester', resource.slice(4), route.request().postDataJSON())
          else if (resource === 'flexcon_shipments') body = (await db.query(`select to_jsonb(s) || jsonb_build_object(
            'source_warehouse',case when w.id is null then null else jsonb_build_object('name',w.name) end,
            'flexcon_destinations',jsonb_build_object('name',d.name),
            'workers',jsonb_build_object('worker_name','Tester'), 'flexcon_shipment_items','[]'::jsonb,
            'flexcon_manual_shipment_items',(select coalesce(jsonb_agg(to_jsonb(i) order by i.sort_order),'[]'::jsonb) from flexcon_manual_shipment_items i where i.shipment_id=s.id)) as row
            from flexcon_shipments s left join flexcon_inspection_options w on w.id=s.inventory_from_warehouse_id
            left join flexcon_destinations d on d.id=s.destination_id order by s.shipped_at desc`)).rows.map(row => row.row)
          else {
            assert.match(resource, /^flexcon_[a-z_]+$/)
            body = (await db.query(`select to_jsonb(t) row from public.${resource} t`)).rows.map(row => row.row)
          }
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
        } catch (error) {
          if (!error.message.includes('在庫が不足')) errors.push(`${resource}: ${error.message}`)
          return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: error.message }) })
        }
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.clock.setFixedTime('2026-10-21T12:00:00+09:00')
      await page.goto('https://source.test/')
      await page.getByRole('button', { name: '出荷記録', exact: true }).click()
      await page.getByRole('tab', { name: '履歴', exact: true }).click()
      const row = page.locator('.shipment-table tbody tr').first()
      const openEdit = () => row.getByRole('button', { name: /出荷履歴を編集/ }).click()
      const dialog = page.getByRole('dialog', { name: '出荷履歴を編集', exact: true })
      const source = dialog.getByRole('combobox', { name: '出荷元（出庫元倉庫）', exact: true })
      const quantity = dialog.locator('.record-item-row').getByRole('spinbutton', { name: '数量', exact: true })
      const before = await snapshot()
      await openEdit()
      assert.equal(await source.inputValue(), warehouseA)
      assert.equal(await dialog.getByLabel('納品先', { exact: true }).inputValue(), f.destination)
      await source.selectOption(warehouseB)
      await quantity.fill('3')
      await dialog.getByLabel('備考（任意）').fill('Source changed with quantity')
      await source.scrollIntoViewIfNeeded()
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `shipment-source-edit-${width}.png`) })
      await dialog.getByRole('button', { name: '変更を保存', exact: true }).click()
      await page.getByText('出荷履歴を更新しました。', { exact: true }).waitFor()
      await row.getByText('倉庫B', { exact: true }).waitFor()
      assert.equal(await balance(warehouseA), 20)
      assert.equal(await balance(warehouseB), 1)
      assert.equal((await status('tester')).action, 'flexcon_update_shipment_with_source')
      await page.getByRole('button', { name: '直前の操作を取り消す', exact: true }).click()
      const undo = page.getByRole('dialog', { name: '直前の操作を取り消す', exact: true })
      await undo.waitFor()
      assert.match(await undo.innerText(), /出荷記録の変更/)
      await undo.getByRole('button', { name: '取り消す', exact: true }).click()
      await page.getByRole('status').filter({ hasText: '直前の操作を取り消しました。' }).waitFor()
      await row.getByText('倉庫A', { exact: true }).waitFor()
      assert.deepEqual(await snapshot(), before)
      await openEdit()
      assert.equal(await quantity.inputValue(), '5')
      await source.selectOption(warehouseB)
      await dialog.getByRole('button', { name: '変更を保存', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: '在庫が不足' }).waitFor()
      assert.deepEqual(await snapshot(), before)
      assert.equal((await status('tester')).available, false, 'A rejected save does not replace Undo')
      await source.selectOption(emptyWarehouse)
      await quantity.fill('1')
      await dialog.getByRole('button', { name: '変更を保存', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: '在庫が不足' }).waitFor()
      assert.deepEqual(await snapshot(), before)
      await dialog.getByRole('button', { name: '編集画面を閉じる', exact: true }).click()
      await openEdit()
      assert.equal(await source.inputValue(), warehouseA)
      assert.equal(await quantity.inputValue(), '5')
      assert.equal((await db.query('select inventory_from_warehouse_id from flexcon_shipments where id=$1', [shipmentId])).rows[0].inventory_from_warehouse_id, warehouseA)
      assert.deepEqual(errors, [])
      console.log(`PASS ${width}px: source prefill/edit, atomic source and quantity changes, stock checks, one-step Undo, rejected-save recovery`)
    } finally { await context.close(); await db.close() }
  }
} finally { await browser.close() }
