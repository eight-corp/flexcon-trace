import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { chromium } from 'playwright'

const root = path.resolve('dist')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const db = new PGlite()
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    const errors = []
    const requests = []
    try {
      await db.exec(fs.readFileSync('tests/fixtures/inspectionDatabase.sql', 'utf8'))
      await db.exec(`create table flexcon_flexcons(id uuid primary key default gen_random_uuid(), lot_number text unique);
        create table flexcon_shipment_items(lot_number text);
        update flexcon_inspection_flexcons set registration_id='00000000-0000-0000-0000-000000000021',inspection_date=case flexcon_no when 1 then date '2026-10-14' else date '2026-10-15' end;
        update flexcon_inspection_paper_bags set registration_id='00000000-0000-0000-0000-000000000021',inspection_date='2026-10-15';
        update flexcon_authorizations set full_name='Producer';
        insert into flexcon_inspection_registrations(id,authorization_id,warehouse_id,created_by_worker_id)
          values ('00000000-0000-0000-0000-000000000023','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000011','tester');
        insert into flexcon_inspection_flexcons(registration_id,authorization_id,fiscal_year,purchase_date,inspection_date,record_kind,flexcon_no,lot_number,brand,quantity_kg,created_by_worker_id)
          values ('00000000-0000-0000-0000-000000000023','00000000-0000-0000-0000-000000000002',8,'2026-10-15','2026-10-15','standard',1,'20260002001','Rice',1020,'tester');`)
      await db.exec(fs.readFileSync('supabase/migrations/202610150001_inspection_date_deletion.sql', 'utf8'))
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://inspection-deletion.test/**', route => {
        const file = path.join(root, new URL(route.request().url()).pathname === '/' ? 'index.html' : new URL(route.request().url()).pathname)
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' }) : route.fulfill({ status: 404, body: '' })
      })
      await context.route('**/rest/v1/**', async route => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        try {
          let body = []
          if (resource === 'rpc/business_session') body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'operator' } }
          else if (resource === 'rpc/flexcon_delete_inspection_registration_date') {
            const args = route.request().postDataJSON()
            requests.push(args)
            body = (await db.query('select flexcon_delete_inspection_registration_date($1,$2::uuid,$3::date,$4::uuid[],$5::uuid[]) result', [args.p_worker_id,args.p_registration_id,args.p_inspection_date,args.p_flexcon_ids,args.p_paper_bag_ids])).rows[0].result
          } else if (/^flexcon_inspection_(registrations|flexcons|paper_bags|options|weights)$|^flexcon_authorizations$/.test(resource)) {
            body = (await db.query(`select coalesce(jsonb_agg(t),'[]'::jsonb) result from ${resource} t`)).rows[0].result
          } else if (resource.startsWith('rpc/')) throw new Error(`Unexpected RPC: ${resource}`)
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
        } catch (error) {
          errors.push(error.message)
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: error.message }) })
        }
      })
      const page = await context.newPage()
      page.on('pageerror', e => errors.push(e.message))
      await page.goto('https://inspection-deletion.test/')
      await page.getByRole('button', { name: '検査記録', exact: true }).click()
      const rows = page.locator('.inspection-summary-table tbody tr')
      await page.waitForFunction(() => document.querySelectorAll('.inspection-summary-table tbody tr').length === 3)
      const selected = rows.filter({ has: page.locator('td:nth-child(2)', { hasText: /^1$/ }) }).filter({ hasText: '令和8年10月15日' })
      const saved = (await db.query("select to_jsonb(t) result from flexcon_inspection_flexcons t where inspection_date='2026-10-14' or authorization_id='00000000-0000-0000-0000-000000000002' order by id")).rows
      const expected = (await db.query("select id from flexcon_inspection_flexcons where inspection_date='2026-10-15' and authorization_id='00000000-0000-0000-0000-000000000001'")).rows.map(r => r.id)
      let message = ''
      page.once('dialog', async dialog => { message = dialog.message(); await dialog.dismiss() })
      await selected.getByRole('button', { name: /の行を削除$/ }).click()
      assert.match(message, /令和8年10月15日/)
      assert.match(message, /推フレ 1本、紙袋 10袋、バラ 0kg/)
      assert.match(message, /他の検査日の記録は削除しません/)
      assert.equal(requests.length, 0)
      page.once('dialog', dialog => dialog.accept())
      await selected.getByRole('button', { name: /の行を削除$/ }).click()
      await page.getByText('Producerの令和8年10月15日の行を削除しました。', { exact: true }).waitFor({ state: 'attached' })
      await page.waitForFunction(() => document.querySelectorAll('.inspection-summary-table tbody tr').length === 2)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].p_inspection_date, '2026-10-15')
      assert.deepEqual(requests[0].p_flexcon_ids, expected)
      assert.equal(requests[0].p_paper_bag_ids.length, 1)
      assert.equal(await selected.count(), 0)
      assert.deepEqual((await db.query('select to_jsonb(t) result from flexcon_inspection_flexcons t order by id')).rows, saved)
      assert.equal((await db.query('select count(*)::int n from flexcon_inspection_deletion_archives')).rows[0].n, 1)
      assert.equal(await page.locator('.producer-inspection-page').count(), 0)
      assert.deepEqual(errors, [])
      if (process.env.QA_ARTIFACTS) {
        fs.mkdirSync(process.env.QA_ARTIFACTS, { recursive: true })
        await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `inspection-date-deletion-${width}.png`) })
      }
      console.log(`PASS ${width}px: date-scoped deletion, cancellation, namesake isolation and original record preservation`)
    } finally { await context.close(); await db.close() }
  }
} finally { await browser.close() }
