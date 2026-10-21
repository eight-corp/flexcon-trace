import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const root = path.resolve('dist')
const uuid = number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' })
    const requests = []
    const updates = []
    const errors = []
    try {
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'mock-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://shipment.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.join(root, pathname === '/' ? 'index.html' : pathname)
        const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType }) : route.fulfill({ status: 404, body: '' })
      })
      await context.route('**/rest/v1/**', route => {
        const resource = new URL(route.request().url()).pathname.split('/rest/v1/')[1]
        let body = []
        if (resource === 'rpc/business_session') {
          body = { ok: true, workerId: 'tester', workerName: 'Tester', permissions: { rice_shipping: 'operator' } }
        } else if (resource === 'rpc/flexcon_register_inventory_record') {
          requests.push(route.request().postDataJSON())
          body = uuid(requests.length)
        } else if (resource === 'rpc/flexcon_update_inventory_record') {
          const values = route.request().postDataJSON()
          updates.push(values)
          const index = requests.findIndex((_, i) => uuid(i + 1) === values.p_shipment_id)
          assert.ok(index >= 0)
          requests[index] = { ...requests[index], ...values }
          body = null
        } else if (resource === 'flexcon_shipments') {
          body = requests.map((values, index) => ({
            id: uuid(index + 1), destination_id: values.p_destination_id,
            transport_profile_id: values.p_transport_profile_id, shipped_at: values.p_shipped_at,
            carrier_name: values.p_transport_profile_id ? '運送会社A' : null,
            driver_name: values.p_driver_name, vehicle_no: values.p_vehicle_no,
            note: null, shipment_kind: 'manual_record', origin_prefecture: '青森県',
            product_name: '米', quantity_count: 1, purchase_price_per_bale: null,
            flexcon_destinations: values.p_destination_id ? { name: '納品先A' } : null,
            flexcon_shipment_items: [], workers: { worker_name: 'Tester' },
            flexcon_manual_shipment_items: values.p_items.map((item, itemIndex) => ({ id: uuid(index * 10 + itemIndex + 11), crop_year: item.crop_year, origin_prefecture: item.origin_prefecture, product_name: item.product_name, quantity_count: item.quantity_count, unit: item.unit, grade: item.grade, moisture: null, reason: null, sort_order: itemIndex })),
          }))
        } else if (resource === 'flexcon_destinations') {
          body = [{ id: '00000000-0000-0000-0000-000000000001', name: '納品先A', active: true }]
        } else if (resource === 'flexcon_transport_profiles') {
          body = [{ id: '00000000-0000-0000-0000-000000000003', company_name: '運送会社A', active: true }]
        } else if (resource === 'flexcon_inspection_options') {
          body = [
            { id: '00000000-0000-0000-0000-000000000005', option_type: 'warehouse', name: '倉庫A', active: true },
            { id: '00000000-0000-0000-0000-000000000006', option_type: 'shipment_product', name: '米', active: true },
          ]
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.clock.setFixedTime('2026-10-21T12:00:00+09:00')
      await page.goto('https://shipment.test/')
      await page.getByRole('button', { name: '出荷記録', exact: true }).click()
      const form = page.locator('.shipment-registration-form')
      assert.equal(await form.evaluate(element => {
        const editor = element.querySelector('[aria-label="出荷明細"]')
        const summary = element.querySelector('.shipment-registration-summary')
        const actions = element.querySelector('.other-rice-actions')
        const fields = [...element.querySelectorAll('.shipment-form-row')]
        return editor && summary && actions && fields.length > 0 && fields.every(field =>
          Boolean(field.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING)
          && field.getBoundingClientRect().bottom <= summary.getBoundingClientRect().top)
          && Boolean(summary.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING)
          && summary.getBoundingClientRect().bottom <= editor.getBoundingClientRect().top
          && Boolean(editor.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING)
          && editor.getBoundingClientRect().bottom <= actions.getBoundingClientRect().top
          && element.lastElementChild === actions
      }), true, 'All input fields precede the detail summary/editor, with clear and register actions at the bottom')
      await form.getByLabel('出庫元倉庫').selectOption('00000000-0000-0000-0000-000000000005')
      const addItem = async () => {
        const editor = form.getByRole('region', { name: '出荷明細' })
        await editor.getByLabel('産年').first().fill('8')
        await editor.getByLabel('産地').first().selectOption('青森県')
        await editor.getByLabel('種類').first().selectOption('米')
        await editor.getByRole('button', { name: '追加' }).click()
      }
      const editor = form.getByRole('region', { name: '出荷明細' })
      assert.equal(await editor.getByLabel('産年').first().inputValue(), '8', 'New detail defaults to this year')
      await editor.getByLabel('産年').first().fill('')
      await editor.getByRole('button', { name: '追加' }).click()
      await editor.getByRole('alert').getByText('産年を入力してください。').waitFor()
      await addItem()
      assert.notEqual(await form.getByLabel('納品先', { exact: true }).getAttribute('required'), null)
      await form.getByRole('button', { name: '出荷を登録' }).click()
      await page.getByRole('alert').getByText('納品先を選択してください。').waitFor()
      assert.equal(requests.length, 0, 'Missing destination must never reach the server')
      await form.getByLabel('納品先', { exact: true }).selectOption(uuid(1))
      await form.getByRole('button', { name: '出荷を登録' }).click()
      await page.getByRole('status').getByText('1件の出荷明細を登録しました。').waitFor()
      assert.equal(requests.length, 1)
      assert.equal(requests[0].p_items[0].crop_year, 2026)
      assert.equal(requests[0].p_destination_id, uuid(1))
      for (const key of ['p_transport_profile_id', 'p_driver_name', 'p_vehicle_no']) {
        assert.equal(requests[0][key], null)
      }

      await addItem()
      await editor.getByLabel('産年').first().fill('7')
      await editor.getByLabel('種類').first().selectOption('米')
      await editor.getByRole('button', { name: '追加' }).click()
      assert.equal(await editor.locator('.record-item-row').count(), 2)
      assert.equal(await editor.getByLabel('産年').first().inputValue(), '8', 'Next detail defaults to this year without changing added items')
      await form.getByLabel('納品先', { exact: true }).selectOption('00000000-0000-0000-0000-000000000001')
      await form.getByLabel('運送会社（任意）').selectOption('00000000-0000-0000-0000-000000000003')
      await form.getByLabel('ドライバー名（任意）').fill('山田')
      await form.getByLabel('車体番号（任意）').fill('青森 100')
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `shipment-details-below-fields-${width}.png`), fullPage: true })
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      for (const name of ['入力をクリア', '出荷を登録']) {
        assert.equal(await form.getByRole('button', { name, exact: true }).evaluate(element => {
          const rect = element.getBoundingClientRect()
          return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === element
        }), true, `${name} remains reachable below the details and above navigation`)
      }
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `shipment-bottom-actions-${width}.png`) })
      await form.getByRole('button', { name: '出荷を登録' }).click()
      await page.waitForFunction(() => document.querySelector('.shipment-registration-summary strong')?.textContent === '0件')
      assert.equal(requests.length, 2)
      assert.deepEqual(requests[1].p_items.map(item => item.crop_year), [2026, 2025])
      assert.deepEqual(Object.fromEntries(['p_destination_id', 'p_transport_profile_id', 'p_driver_name', 'p_vehicle_no'].map(key => [key, requests[1][key]])), {
        p_destination_id: '00000000-0000-0000-0000-000000000001',
        p_transport_profile_id: '00000000-0000-0000-0000-000000000003',
        p_driver_name: '山田',
        p_vehicle_no: '青森 100',
      })
      assert.deepEqual(errors, [])
      await editor.getByLabel('産年').first().fill('7')
      await form.getByRole('button', { name: '入力をクリア', exact: true }).click()
      assert.equal(await editor.getByLabel('産年').first().inputValue(), '8')
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `shipment-optional-fields-${width}.png`), fullPage: true })
      // Preserve access to historical records that predate required destinations.
      requests[0].p_destination_id = null
      await page.getByRole('tab', { name: '履歴', exact: true }).click()
      const table = page.locator('.shipment-table')
      await table.locator('thead th').first().getByText('操作').waitFor()
      await table.locator('tbody tr').first().getByRole('button', { name: /出荷履歴を編集/ }).waitFor()
      assert.equal(await table.getByRole('button', { name: /出荷履歴を削除/ }).count(), 0)
      const editCell = table.locator('tbody tr').first().locator('td').first()
      const beforeScroll = await editCell.boundingBox()
      await page.locator('.shipment-table-wrap').evaluate(element => { element.scrollLeft = 500 })
      const afterScroll = await editCell.boundingBox()
      assert.ok(beforeScroll && afterScroll)
      assert.ok(Math.abs(beforeScroll.x - afterScroll.x) < 2)
      if (process.env.QA_ARTIFACTS) await page.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `shipment-history-operator-${width}.png`), fullPage: true })
      await page.getByRole('button', { name: 'パネル表示' }).click()
      const history = page.locator('.shipment-list')
      await history.locator('.shipment-item').first().waitFor()
      assert.equal(await history.locator('.shipment-item').count(), 2)
      await history.locator('.shipment-item').first().getByText('未設定', { exact: true }).waitFor()
      await history.locator('.shipment-item').first().getByRole('button', { name: '出荷履歴を編集' }).click()
      const dialog = page.getByRole('dialog', { name: '出荷履歴を編集' })
      assert.equal(await dialog.getByLabel('産年').last().inputValue(), '8')
      assert.notEqual(await dialog.getByLabel('納品先', { exact: true }).getAttribute('required'), null)
      assert.equal(await dialog.getByLabel('運送会社（任意）').getAttribute('required'), null)
      await dialog.getByLabel('ドライバー名（任意）').fill('田中')
      await dialog.getByLabel('車体番号（任意）').fill('青森 101')
      await dialog.getByLabel('産年').last().fill('7')
      await dialog.getByRole('button', { name: '変更を保存' }).click()
      await page.getByRole('alert').getByText('納品先を選択してください。').waitFor()
      assert.equal(updates.length, 0)
      await dialog.getByLabel('納品先', { exact: true }).selectOption(uuid(1))
      await dialog.getByRole('button', { name: '変更を保存' }).click()
      assert.equal(updates.length, 1)
      assert.equal(updates[0].p_destination_id, uuid(1))
      assert.equal(updates[0].p_transport_profile_id, null)
      assert.equal(updates[0].p_driver_name, '田中')
      assert.equal(updates[0].p_vehicle_no, '青森 101')
      assert.equal(updates[0].p_items[0].crop_year, 2025)
      await history.locator('.shipment-item').first().getByText('ドライバー：田中').waitFor()
      await page.clock.setFixedTime('2027-01-01T00:01:00+09:00')
      await page.getByRole('button', { name: '在庫', exact: true }).click()
      await page.getByRole('button', { name: '出荷記録', exact: true }).click()
      assert.equal(await editor.getByLabel('産年').first().inputValue(), '9')
      await page.getByRole('switch', { name: '西暦表示', exact: true }).click()
      assert.equal(await editor.getByLabel('産年').first().inputValue(), '2027')
      assert.deepEqual(errors, [])
      console.log(`PASS ${width}px: details below shipment fields, required destination, optional transport, current-year defaults, rollover, registration and legacy editing`)
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}
