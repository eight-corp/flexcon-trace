import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { undoDatabase } from './fixtures/undoDatabase.mjs'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const scenario of [
    { width: 1440, actor: 'tester' }, { width: 390, actor: 'tester' }, { width: 320, actor: 'tester' },
    { width: 1440, actor: 'admin' }, { width: 390, actor: 'tester', statements: true }, { width: 390, actor: 'viewer' },
  ]) {
    const { db, rpc } = await undoDatabase()
    const context = await browser.newContext({ viewport: { width: scenario.width, height: 900 }, serviceWorkers: 'block' })
    const errors = []
    let releaseSave
    let sawSave
    let waitSave
    try {
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://undo.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.resolve('dist', pathname === '/' ? 'index.html' : `.${pathname}`)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      await context.route('**/rest/v1/**', async route => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        const actor = scenario.actor
        const role = actor === 'admin' ? 'admin' : actor === 'viewer' ? 'viewer' : 'operator'
        let body
        try {
          if (resource === 'rpc/business_session') body = { ok: true, workerId: actor, workerName: actor, permissions: { rice_shipping: role, purchase_statements: role } }
          else if (resource === 'rpc/flexcon_list_memos') body = await db.transaction(async tx => {
            await tx.query("select set_config('fixture.actor',$1,true)", [actor])
            return (await tx.query('select * from flexcon_list_memos($1)', [actor])).rows
          })
          else if (resource.startsWith('rpc/')) {
            const fn = resource.slice(4)
            assert.match(fn, /^flexcon_[a-z_]+$/)
            const args = route.request().postDataJSON()
            if (fn === 'flexcon_add_memo_visible' && waitSave) { sawSave(); await waitSave; waitSave = null }
            body = await rpc(actor, fn, args)
          } else {
            assert.match(resource, /^flexcon_[a-z_]+$/)
            body = (await db.query(`select to_jsonb(t) data from public.${resource} t`)).rows.map(row => row.data)
          }
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
        } catch (error) {
          if (!resource.startsWith('rpc/flexcon_undo_')) errors.push(`${resource}: ${error.message}`)
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: error.message }) })
        }
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`https://undo.test/${scenario.statements ? '?app=statements' : ''}`)
      const navigation = page.getByRole('navigation', { name: 'メインメニュー' })
      await navigation.waitFor()
      const button = page.getByRole('button', { name: '直前の操作を取り消す', exact: true })
      if (scenario.actor === 'viewer') {
        assert.equal(await button.count(), 0)
        console.log('PASS viewer has no mutation/undo controls')
        continue
      }
      await button.waitFor()
      const originalPosition = await button.boundingBox()
      const checkPosition = async () => {
        const box = await button.boundingBox()
        assert.ok(box.x >= 0 && box.x + box.width <= scenario.width)
        assert.ok(Math.abs(box.x - originalPosition.x) < 1 && Math.abs(box.y - originalPosition.y) < 1)
        assert.equal(await button.evaluate(el => {
          const r = el.getBoundingClientRect()
          return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === el
        }), true, 'undo stays reachable above page dialogs')
      }
      const tabs = scenario.statements ? ['仕切書読込', '確認待ち', '仕切書一覧']
        : ['入出庫管理', '検査記録', '出荷記録', '出荷履歴', '在庫', '委任状一覧', 'メモ書き', ...(scenario.actor === 'admin' ? ['マスタ'] : [])]
      for (const tab of tabs) { await navigation.getByRole('button', { name: tab, exact: true }).click(); await checkPosition() }
      if (scenario.statements || scenario.actor === 'admin' || scenario.width === 320) {
        if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `undo-position-${scenario.actor}-${scenario.statements ? 'statements' : 'rice'}-${scenario.width}.png`) })
        assert.deepEqual(errors, [])
        console.log(`PASS persistent undo position ${scenario.actor} ${scenario.width}px ${scenario.statements ? 'statements' : 'rice'}`)
        continue
      }
      await button.click()
      await page.getByRole('alert').filter({ hasText: '取り消せる操作はありません。' }).waitFor()
      await page.getByRole('button', { name: '通知を閉じる', exact: true }).click()
      const addMemo = async body => {
        await page.locator('.memo-page').getByRole('button', { name: '追加', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'メモを追加' })
        await dialog.getByLabel('メモ内容', { exact: true }).fill(body)
        await dialog.getByRole('button', { name: '保存', exact: true }).click()
        await page.locator('.memo-preview').filter({ hasText: body }).waitFor()
      }
      await addMemo('Keep this memo')
      await addMemo('Undo this memo')
      await rpc('other', 'flexcon_add_memo_visible', { p_worker_id: 'other', p_body: 'Other operator', p_is_public: true })
      await page.locator('.memo-page').getByRole('button', { name: '追加', exact: true }).click()
      await checkPosition()
      await button.click()
      let confirmation = page.getByRole('dialog', { name: '直前の操作を取り消す' })
      await confirmation.waitFor()
      assert.match(await confirmation.innerText(), /メモの登録/)
      await confirmation.getByRole('button', { name: '戻る', exact: true }).click()
      assert.equal((await db.query("select count(*)::integer n from flexcon_memos where body='Undo this memo'")).rows[0].n, 1)
      await button.click()
      await confirmation.waitFor()
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `undo-confirm-${scenario.width}.png`) })
      await confirmation.getByRole('button', { name: '取り消す', exact: true }).click()
      await page.getByRole('status').filter({ hasText: '直前の操作を取り消しました。' }).waitFor()
      await page.locator('.memo-preview').filter({ hasText: 'Keep this memo' }).waitFor()
      assert.equal(await page.locator('.memo-preview').filter({ hasText: 'Undo this memo' }).count(), 0)
      assert.equal((await db.query("select count(*)::integer n from flexcon_memos where body='Other operator'")).rows[0].n, 1)
      await button.click()
      await page.getByRole('alert').filter({ hasText: '取り消せる操作はありません。' }).waitFor()
      await page.getByRole('button', { name: '通知を閉じる', exact: true }).click()

      const sawSavePromise = new Promise(resolve => { sawSave = resolve })
      waitSave = new Promise(resolve => { releaseSave = resolve })
      await page.locator('.memo-page').getByRole('button', { name: '追加', exact: true }).click()
      const edit = page.getByRole('dialog', { name: 'メモを追加' })
      await edit.getByLabel('メモ内容', { exact: true }).fill('Pending save')
      await edit.getByRole('button', { name: '保存', exact: true }).click()
      await sawSavePromise
      assert.equal(await button.isDisabled(), true)
      releaseSave()
      await page.locator('.memo-preview').filter({ hasText: 'Pending save' }).waitFor()
      await button.click()
      await confirmation.waitFor()
      await rpc('tester', 'flexcon_add_memo_visible', { p_worker_id: 'tester', p_body: 'Another device', p_is_public: false })
      await confirmation.getByRole('button', { name: '取り消す', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: '直前の操作が変わりました。' }).waitFor()
      assert.equal((await db.query("select count(*)::integer n from flexcon_memos where body in ('Pending save','Another device')")).rows[0].n, 2)
      await page.getByRole('button', { name: '通知を閉じる', exact: true }).click()
      await rpc('admin', 'flexcon_save_inspection_option', { p_worker_id: 'admin', p_option_id: null, p_option_type: 'brand_aomori', p_name: 'Undo UI Rice' })
      const producer = await rpc('tester', 'flexcon_add_authorization', { p_worker_id: 'tester', p_authorization_no: '901', p_full_name: 'Undo UI Producer', p_seed_purchase_slip: false, p_farming_plan: false, p_prefecture: '青森県', p_address: 'Test' })
      const warehouse = await rpc('admin', 'flexcon_save_inspection_option', { p_worker_id: 'admin', p_option_id: null, p_option_type: 'warehouse', p_name: 'Undo UI Warehouse' })
      await rpc('admin', 'flexcon_save_inspection_option', { p_worker_id: 'admin', p_option_id: null, p_option_type: 'location', p_name: 'Undo UI Warehouse' })
      await rpc('tester', 'flexcon_add_inspection_group_with_warehouse', { p_worker_id: 'tester', p_authorization_id: producer, p_fiscal_year: 8, p_purchase_date: '2026-10-16', p_inspection_date: '2026-10-16', p_inspection_location: 'Undo UI Warehouse', p_brand: 'Undo UI Rice', p_flexcon_count: 1, p_paper_bag_count: 0, p_flexcon_quantity_kg: 1020, p_bulk_quantity_kg: 0, p_warehouse_id: warehouse, p_settlement_no: 'UNDO-UI' })
      await navigation.getByRole('button', { name: '検査記録', exact: true }).click()
      await page.locator('.inspection-summary-table tbody tr').filter({ hasText: 'Undo UI Producer' }).click()
      const quantity = page.getByRole('textbox', { name: '数量（kg）', exact: true }).first()
      await quantity.fill('1030')
      await button.click()
      await confirmation.waitFor()
      assert.match(await confirmation.innerText(), /検査記録の変更/)
      assert.equal((await db.query('select quantity_kg from flexcon_inspection_flexcons where authorization_id=$1', [producer])).rows[0].quantity_kg, 1030)
      await confirmation.getByRole('button', { name: '取り消す', exact: true }).click()
      await page.getByRole('status').filter({ hasText: '直前の操作を取り消しました。' }).waitFor()
      await page.waitForFunction(() => document.querySelector('input[aria-label="数量（kg）"]')?.value === '1,020')
      assert.equal((await db.query('select quantity_kg from flexcon_inspection_flexcons where authorization_id=$1', [producer])).rows[0].quantity_kg, 1020)
      assert.deepEqual(errors, [])
      console.log(`PASS undo/cancel/one-level/operator-isolation/pending-writes/CAS ${scenario.width}px`)
    } finally { releaseSave?.(); await context.close(); await db.close() }
  }
} finally { await browser.close() }
