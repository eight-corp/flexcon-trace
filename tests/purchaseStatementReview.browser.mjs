import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { purchaseStatementDatabase, validHeader, validItems } from './fixtures/purchaseStatementDatabase.mjs'

const root = path.resolve('dist')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const { db, rpc } = await purchaseStatementDatabase()
    const contexts = []
    const errors = []
    let reads = 0
    let failUpload = false
    let imageUrl = ''
    const createPage = async actor => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
      contexts.push(context)
      await context.addInitScript(() => localStorage.setItem('business.session.v1', 'test-session'))
      await context.route('**/*', route => route.abort())
      await context.route('https://purchase-review.test/**', route => {
        const pathname = new URL(route.request().url()).pathname
        const file = path.join(root, pathname === '/' ? 'index.html' : pathname)
        return fs.existsSync(file) ? route.fulfill({ path: file, contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' }) : route.fulfill({ status: 404, body: '' })
      })
      await context.route('**/rest/v1/rpc/*', async route => {
        const name = new URL(route.request().url()).pathname.split('/').at(-1)
        const args = route.request().postDataJSON()
        try {
          let body
          if (name === 'business_session') body = { ok: true, workerId: actor, workerName: actor, permissions: { purchase_statements: actor === 'viewer' ? 'viewer' : 'operator' } }
          else if (name === 'flexcon_list_purchase_inventory_master') body = []
          else if (['flexcon_list_purchase_statement_master', 'flexcon_list_purchase_statements', 'flexcon_list_pending_purchase_statements', 'flexcon_submit_purchase_statement', 'flexcon_find_purchase_statement_by_number', 'flexcon_confirm_purchase_statement'].includes(name)) body = await rpc(actor, name, args)
          else throw new Error(`Unexpected RPC: ${name}`)
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
        } catch (error) {
          errors.push(error.message)
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: error.message }) })
        }
      })
      await context.route('**/functions/v1/*', async route => {
        const name = new URL(route.request().url()).pathname.split('/').at(-1)
        const args = route.request().postDataJSON()
        let body
        if (name === 'analyze-purchase-statement') {
          reads++
          body = { statement: { ...validHeader(String(99 + reads)), lines: validItems(), warnings: ['元画像で数量を確認してください'] } }
        } else if (name === 'purchase-statement-image' && args.action === 'upload') {
          if (failUpload) {
            failUpload = false
            return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'test upload failure' }) })
          }
          assert.equal(actor, 'reader')
          await db.query("update flexcon_purchase_statement_drafts set image_path=id::text||'/original.jpg' where id=$1", [args.statementId])
          body = { imagePath: `${args.statementId}/original.jpg` }
        } else if (name === 'purchase-statement-image' && args.action === 'signed-url') body = { signedUrl: imageUrl }
        else { errors.push(`Unexpected function: ${name}`); body = {} }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.goto('https://purchase-review.test/?app=statements')
      return page
    }
    try {
      const reader = await createPage('reader')
      await reader.getByRole('button', { name: '撮影・画像を選択', exact: true }).waitFor()
      imageUrl = await reader.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 720; canvas.height = 300
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 720, 300)
        ctx.fillStyle = '#222'; ctx.font = '28px sans-serif'
        ctx.fillText('TEST STATEMENT 100', 40, 70)
        ctx.fillText('2026-10-07    1 x 1,000    TOTAL 1,100', 40, 160)
        return canvas.toDataURL('image/jpeg')
      })
      const photo = { name: 'test.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imageUrl.split(',')[1], 'base64') }
      await reader.locator('input[type=file]').setInputFiles(photo)
      await reader.getByRole('status').filter({ hasText: '読み取り成功。確認を依頼してください。' }).waitFor()
      assert.equal(await reader.locator('.purchase-statement-editor').count(), 0)
      assert.equal((await db.query('select count(*)::int as n from flexcon_purchase_statements')).rows[0].n, 1)
      const nav = await reader.locator('nav button').allTextContents()
      assert.equal(nav.indexOf('確認待ち'), nav.indexOf('仕切書読込') + 1)
      if (process.env.QA_ARTIFACTS) {
        fs.mkdirSync(process.env.QA_ARTIFACTS, { recursive: true })
        await reader.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `statement-reader-${width}.png`) })
      }
      assert.equal(await reader.getByRole('button', { name: '次の仕切書を読み取る', exact: true }).isEnabled(), true)
      failUpload = true
      await reader.locator('input[type=file]').setInputFiles(photo)
      await reader.getByRole('button', { name: '保存を再試行', exact: true }).waitFor()
      assert.equal(await reader.getByRole('status').filter({ hasText: '読み取り成功。' }).count(), 0)
      await reader.getByRole('button', { name: '保存を再試行', exact: true }).click()
      await reader.getByRole('status').filter({ hasText: '読み取り成功。' }).waitFor()
      assert.equal(reads, 2)
      assert.equal((await db.query('select count(*)::int as n from flexcon_purchase_statement_drafts')).rows[0].n, 2)
      await reader.getByRole('button', { name: '確認待ち', exact: true }).click()
      await reader.getByRole('button', { name: '100', exact: true }).click()
      await reader.getByRole('status').filter({ hasText: '読取者本人は確認できません' }).waitFor()
      assert.equal(await reader.getByRole('button', { name: '確認して確定', exact: true }).count(), 0)

      const reviewer = await createPage('reviewer')
      await reviewer.getByRole('button', { name: '確認待ち', exact: true }).click()
      const row = reviewer.locator('.purchase-statement-pending-rows').filter({ has: reviewer.getByRole('button', { name: '100', exact: true }) })
      await row.locator('td').first().click()
      const dialog = reviewer.getByRole('dialog', { name: '仕切書を確認', exact: true })
      await dialog.waitFor()
      await reviewer.waitForFunction(() => {
        const img = document.querySelector('.purchase-statement-preview')
        return img?.complete && img.naturalWidth > 0
      })
      assert.equal(await dialog.getByText('元画像で数量を確認してください', { exact: true }).count(), 1)
      const items = dialog.locator('.purchase-statement-details tbody tr').first()
      await items.locator('td[data-label="数量"] input').fill('2')
      const amount = items.locator('td[data-label="金額"] input')
      await amount.click(); await amount.fill('2000')
      const tax = dialog.getByLabel('消費税額', { exact: true })
      await tax.click(); await tax.fill('200')
      const total = dialog.locator('.purchase-statement-common label').filter({ hasText: '税込合計金額' }).locator('input')
      await total.click(); await total.fill('2200')
      if (process.env.QA_ARTIFACTS) await reviewer.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `statement-review-${width}.png`) })
      await dialog.getByRole('button', { name: '確認して確定', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await reviewer.getByRole('status').filter({ hasText: '仕切書を確認し、確定しました' }).waitFor()
      await reviewer.getByRole('button', { name: '101', exact: true }).waitFor()
      assert.equal(await reviewer.getByRole('button', { name: '100', exact: true }).count(), 0)
      const result = (await db.query("select s.*, d.confirmed_by_worker_id from flexcon_purchase_statements s join flexcon_purchase_statement_drafts d on d.confirmed_statement_id=s.id where s.document_number='100'")).rows[0]
      assert.equal(result.created_by_worker_id, 'reader')
      assert.equal(result.confirmed_by_worker_id, 'reviewer')
      assert.equal(Number(result.total_amount), 2200)
      await reviewer.getByRole('button', { name: '仕切書一覧', exact: true }).click()
      await reviewer.getByRole('button', { name: '100', exact: true }).waitFor()
      assert.equal(await reviewer.getByRole('button', { name: '101', exact: true }).count(), 0)
      assert.equal((await db.query('select count(*)::int as n from flexcon_purchase_statements')).rows[0].n, 2)
      const viewer = await createPage('viewer')
      await viewer.getByRole('button', { name: '確認待ち', exact: true }).click()
      await viewer.getByRole('button', { name: '101', exact: true }).click()
      assert.equal(await viewer.getByRole('button', { name: '確認・修正', exact: true }).count(), 0)
      assert.deepEqual(errors, [])
      console.log(`Purchase review workflow passed at ${width}px`)
    } finally {
      for (const context of contexts) await context.close()
      await db.close()
    }
  }
} finally { await browser.close() }
