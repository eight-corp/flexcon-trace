import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { purchaseStatementDatabase, validHeader, validItems } from './fixtures/purchaseStatementDatabase.mjs'

const root = path.resolve('dist')

async function checkTouchImageZoom(page, popup) {
  const viewport = popup.getByRole('region', { name: '仕切書画像の表示範囲' })
  const image = popup.getByRole('img', { name: '保存した仕切書' })
  await image.evaluate((element) => element.decode())
  const bounds = await viewport.boundingBox()
  const heading = await popup.getByRole('heading').boundingBox()
  const fitWidth = (await image.boundingBox()).width
  const x = Math.round(bounds.x + bounds.width / 2)
  const y = Math.round(bounds.y + bounds.height / 2)
  const cdp = await page.context().newCDPSession(page)
  const touch = (type, offsets, offsetY = 0) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: offsets.map((offset, id) => ({ x: x + offset, y: y + offsetY, id })),
  })
  try {
    assert.equal(await popup.getByRole('button', { name: '画像を拡大', exact: true }).count(), 0)
    await touch('touchStart', [-22, 22])
    await touch('touchMove', [-38, 38])
    await touch('touchMove', [-62, 62])
    await touch('touchEnd', [])
    assert.ok((await image.boundingBox()).width > fitWidth * 2)
    assert.deepEqual(await popup.getByRole('heading').boundingBox(), heading)
    assert.equal(await page.evaluate(() => window.visualViewport.scale), 1)

    const getScroll = () => viewport.evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop }))
    const scrollBefore = await getScroll()
    await touch('touchStart', [0])
    await touch('touchMove', [-30], -18)
    await touch('touchMove', [-68], -48)
    await touch('touchEnd', [])
    const scrollAfter = await getScroll()
    assert.ok(scrollAfter.x > scrollBefore.x && scrollAfter.y > scrollBefore.y)

    await touch('touchStart', [-62, 62])
    await touch('touchMove', [-38, 38])
    await touch('touchMove', [-20, 20])
    await touch('touchEnd', [])
    assert.ok(Math.abs((await image.boundingBox()).width - fitWidth) < 2)
  } finally {
    await cdp.detach()
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of [1440, 390]) {
    const { db, rpc } = await purchaseStatementDatabase()
    await db.exec(fs.readFileSync('supabase/migrations/202611140001_purchase_statement_queue.sql', 'utf8'))
    await db.exec(fs.readFileSync('supabase/migrations/202611200003_purchase_statement_reader_name.sql', 'utf8'))
    const queueSecret = (await db.query('select secret from flexcon_queue_private.settings')).rows[0].secret
    const contexts = []
    const errors = []
    let reads = 0
    let failUpload = false
    let imageUrl = ''
    let imageRequests = 0
    const jobNumbers = new Map()
    const finishQueue = async () => {
      for (;;) {
        const job = await rpc('reader', 'flexcon_purchase_queue_claim', { p_secret: queueSecret })
        if (!job) break
        const number = jobNumbers.get(job.id)
        const date = { 100: '2024-10-07', 101: '2025-10-07', 102: '2027-10-07' }[number]
        await rpc('reader', 'flexcon_purchase_queue_complete', { p_job_id: job.id, p_lease_token: job.leaseToken,
          p_header: { ...validHeader(number), statement_date: date }, p_items: validItems(), p_warnings: ['元画像で数量を確認してください'] })
      }
    }
    const createPage = async actor => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390, isMobile: width === 390, serviceWorkers: 'block' })
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
          else if (['flexcon_list_purchase_statement_jobs', 'flexcon_retry_purchase_statement_job', 'flexcon_list_purchase_statement_master', 'flexcon_list_purchase_statements', 'flexcon_list_pending_purchase_statements', 'flexcon_submit_purchase_statement', 'flexcon_find_purchase_statement_by_number', 'flexcon_confirm_purchase_statement'].includes(name)) body = await rpc(actor, name, args)
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
        if (name === 'purchase-statement-queue' && args.action === 'enqueue') {
          if (!jobNumbers.has(args.jobId)) { reads++; jobNumbers.set(args.jobId, String(99 + reads)) }
          await rpc(actor, 'flexcon_purchase_queue_reserve', { p_worker_id: actor, p_job_id: args.jobId, p_fingerprint: 'a'.repeat(64) })
          if (failUpload) {
            failUpload = false
            return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'test upload failure' }) })
          }
          await rpc(actor, 'flexcon_purchase_queue_ready', { p_worker_id: actor, p_job_id: args.jobId })
          body = { jobId: args.jobId, status: 'queued' }
        } else if (name === 'purchase-statement-queue' && args.action === 'signed-url') {
          body = { signedUrl: imageUrl }
        } else if (name === 'purchase-statement-image' && args.action === 'upload') {
          if (failUpload) {
            failUpload = false
            return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'test upload failure' }) })
          }
          assert.equal(actor, 'reader')
          await db.query("update flexcon_purchase_statement_drafts set image_path=id::text||'/original.jpg' where id=$1", [args.statementId])
          body = { imagePath: `${args.statementId}/original.jpg` }
        } else if (name === 'purchase-statement-image' && args.action === 'signed-url') {
          imageRequests++
          body = { signedUrl: imageUrl }
        }
        else { errors.push(`Unexpected function: ${name}`); body = {} }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
      })
      const page = await context.newPage()
      await page.clock.setFixedTime(new Date('2026-11-20T12:00:00+09:00'))
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
      await reader.getByRole('status').filter({ hasText: '画像を保存し、解析待ちに追加しました。' }).waitFor()
      assert.equal(await reader.locator('.purchase-statement-editor').count(), 0)
      assert.equal((await db.query('select count(*)::int as n from flexcon_purchase_statements')).rows[0].n, 1)
      const nav = await reader.locator('nav button').allTextContents()
      assert.equal(nav.indexOf('確認待ち'), nav.indexOf('仕切書読込') + 1)
      if (process.env.QA_ARTIFACTS) {
        fs.mkdirSync(process.env.QA_ARTIFACTS, { recursive: true })
        await reader.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `statement-reader-${width}.png`) })
      }
      assert.equal(await reader.getByRole('button', { name: '次の仕切書を読み取る', exact: true }).isEnabled(), true)
      await reader.getByRole('button', { name: 'Readerの保存画像を表示', exact: true }).click()
      const queuePopup = reader.getByRole('dialog', { name: '保存した仕切書画像', exact: true })
      const queueImage = queuePopup.getByRole('img', { name: '保存した仕切書', exact: true })
      await queueImage.waitFor()
      if (width === 390) {
        await checkTouchImageZoom(reader, queuePopup)
      } else {
        const queueFitWidth = (await queueImage.boundingBox()).width
        await queuePopup.getByRole('button', { name: '画像を拡大', exact: true }).click()
        assert.ok((await queueImage.boundingBox()).width > queueFitWidth * 1.4)
      }
      await queuePopup.getByRole('button', { name: '画像を閉じる', exact: true }).click()
      await queuePopup.waitFor({ state: 'detached' })
      failUpload = true
      await reader.locator('input[type=file]').setInputFiles(photo)
      await reader.getByRole('button', { name: '画像保存を再試行', exact: true }).waitFor()
      assert.equal(await reader.getByRole('button', { name: '確認待ち', exact: true }).isEnabled(), false)
      assert.equal(await reader.getByRole('button', { name: '直前の操作を取り消す', exact: true }).isEnabled(), false)
      assert.equal(await reader.getByRole('status').filter({ hasText: '読み取り成功。' }).count(), 0)
      await reader.getByRole('button', { name: '画像保存を再試行', exact: true }).click()
      await reader.getByRole('status').filter({ hasText: '画像を保存し、解析待ちに追加しました。' }).waitFor()
      assert.equal(reads, 2)
      assert.equal((await rpc('reader', 'flexcon_list_pending_purchase_statements', { p_worker_id: 'reader' })).length, 0)
      assert.equal((await db.query("select count(*)::int n from flexcon_purchase_statement_jobs where status='queued'")).rows[0].n, 2)
      const anotherReader = await createPage('reviewer')
      await anotherReader.locator('input[type=file]').setInputFiles(photo)
      await anotherReader.getByRole('status').filter({ hasText: '画像を保存し、解析待ちに追加しました。' }).waitFor()
      await reader.reload()
      await reader.locator('.purchase-queue-table tbody tr').nth(2).waitFor()
      assert.match(await reader.locator('.purchase-queue-table').innerText(), /Reviewer/)
      assert.equal(await reader.getByRole('button', { name: '撮影・画像を選択', exact: true }).isEnabled(), true)
      if (process.env.QA_ARTIFACTS) await reader.screenshot({ path: path.join(process.env.QA_ARTIFACTS, `statement-shared-queue-${width}.png`) })
      await finishQueue()
      assert.equal((await db.query('select count(*)::int as n from flexcon_purchase_statement_drafts')).rows[0].n, 3)
      await reader.getByRole('button', { name: '確認待ち', exact: true }).click()
      await reader.getByRole('button', { name: '100', exact: true }).click()
      await reader.getByRole('status').filter({ hasText: '読取者本人は確認できません' }).waitFor()
      assert.equal(await reader.getByRole('button', { name: '確認して確定', exact: true }).count(), 0)
      assert.equal(imageRequests, 0)
      const detailImage = reader.locator('.purchase-statement-detail-heading').getByRole('button', { name: '画像を表示', exact: true })
      await detailImage.click()
      const readerPopup = reader.getByRole('dialog', { name: '保存した仕切書画像', exact: true })
      await readerPopup.getByRole('img', { name: '保存した仕切書', exact: true }).waitFor()
      await reader.keyboard.press('Escape')
      await readerPopup.waitFor({ state: 'detached' })
      assert.equal(await detailImage.evaluate((button) => document.activeElement === button), true)

      const reviewer = await createPage('reviewer')
      await reviewer.getByRole('button', { name: '確認待ち', exact: true }).click()
      const row = reviewer.locator('.purchase-statement-pending-rows').filter({ has: reviewer.getByRole('button', { name: '100', exact: true }) })
      await row.locator('.purchase-statement-date-warning').waitFor()
      assert.equal(await reviewer.locator('.purchase-statement-pending-rows .purchase-statement-date-warning').count(), 1)
      await row.locator('td').first().click()
      const dialog = reviewer.getByRole('dialog', { name: '仕切書を確認', exact: true })
      await dialog.waitFor()
      await dialog.locator('.purchase-statement-date-warning input[type=text]').waitFor()
      assert.equal(await dialog.getByLabel('担当者', { exact: true }).inputValue(), 'Reader')
      assert.equal(await dialog.locator('img').count(), 0)
      assert.equal(imageRequests, 1)
      assert.equal(await dialog.getByText('元画像で数量を確認してください', { exact: true }).count(), 1)
      const items = dialog.locator('.purchase-statement-details tbody tr').first()
      const quantity = items.locator('td[data-label="数量"] input')
      await quantity.fill('2')
      const editorImage = dialog.locator('.purchase-statement-editor-heading').getByRole('button', { name: '画像を表示', exact: true })
      await editorImage.click()
      const reviewPopup = reviewer.getByRole('dialog', { name: '保存した仕切書画像', exact: true })
      const popupImage = reviewPopup.getByRole('img', { name: '保存した仕切書', exact: true })
      await popupImage.waitFor()
      assert.equal(await popupImage.evaluate((image) => image.decode().then(() => image.naturalWidth > 0)), true)
      if (width === 390) {
        await checkTouchImageZoom(reviewer, reviewPopup)
      } else {
        const zoomIn = reviewPopup.getByRole('button', { name: '画像を拡大', exact: true })
        const zoomOut = reviewPopup.getByRole('button', { name: '画像を縮小', exact: true })
        await zoomIn.waitFor()
        assert.equal(await zoomOut.isEnabled(), false)
        const fitWidth = (await popupImage.boundingBox()).width
        await zoomIn.click()
        assert.ok((await popupImage.boundingBox()).width > fitWidth * 1.4)
        await reviewPopup.getByText('150%', { exact: true }).waitFor()
        const scrollPosition = await reviewPopup.getByRole('region', { name: '仕切書画像の表示範囲' }).evaluate((area) => {
          area.scrollLeft = area.scrollWidth
          return area.scrollLeft
        })
        assert.ok(scrollPosition > 0)
        await zoomOut.click()
        await reviewPopup.getByText('100%', { exact: true }).waitFor()
        assert.ok(Math.abs((await popupImage.boundingBox()).width - fitWidth) < 2)
        await zoomIn.click()
        await reviewPopup.getByRole('button', { name: '全体表示', exact: true }).click()
        await reviewPopup.getByText('100%', { exact: true }).waitFor()
      }
      await reviewPopup.getByRole('button', { name: '画像を閉じる', exact: true }).click()
      await reviewPopup.waitFor({ state: 'detached' })
      await dialog.waitFor()
      assert.equal(await quantity.inputValue(), '2')
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
