import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDemo, resetDemo, watchRuntimeErrors, expectNoRuntimeErrors } from './helpers/demo'

test.beforeEach(async ({ page }) => resetDemo(page))

test('saves reusable plans and exports each real PDF format through the shared core', async ({ page }) => {
  test.setTimeout(150_000)
  const errors = watchRuntimeErrors(page)
  // macOS 14's WKWebView lacks URL.parse; preview must use PDF.js's compatibility build.
  await page.addInitScript(() => { Reflect.deleteProperty(URL, 'parse') })
  await openDemo(page, '/manage/overview')
  await page.getByRole('link', { name: '打开编印族谱', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/manage\/publication$/)
  await expect(page.getByRole('navigation', { name: '项目管理二级导航' }).getByRole('link', { name: '编印族谱', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: '编印族谱', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '刷新资料' })).toBeVisible()
  await page.getByLabel('方案名称', { exact: true }).fill('印刷校对测试')
  await page.getByRole('button', { name: /^保存方案/ }).click()
  await expect(page.getByLabel('切换编印方案')).toContainText('印刷校对测试')
  for (const format of ['现代横排谱册', '传统中文谱册', '世系挂图']) {
    await page.getByRole('radio', { name: format }).check()
    await page.getByRole('button', { name: /^(生成 PDF|重新生成)$/ }).click()
    await expect(page.getByRole('button', { name: '保存 PDF', exact: true })).toBeEnabled({ timeout: 60_000 })
    await expect(page.getByRole('img', { name: 'PDF 第 1 页', exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.pdf-page')).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })
    if (process.env.BRANCHLOOM_PUBLICATION_SAMPLES_DIR) {
      mkdirSync(process.env.BRANCHLOOM_PUBLICATION_SAMPLES_DIR, { recursive: true })
      await page.screenshot({ path: join(process.env.BRANCHLOOM_PUBLICATION_SAMPLES_DIR, `ui-${format}.png`), fullPage: true })
    }
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(page.getByRole('img', { name: 'PDF 第 2 页', exact: true })).toBeVisible()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: '保存 PDF', exact: true }).click()
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/)
    await page.getByLabel('族谱标题', { exact: true }).fill(`印刷校对-${format}`)
    await expect(page.getByRole('button', { name: '保存 PDF', exact: true })).toBeDisabled()
    await expect(page.getByText('方案或资料已变化，请重新生成后再校对和保存。')).toBeVisible()
  }
  expectNoRuntimeErrors(errors)
})

test('narrow publication workspace keeps navigation, editable settings and guarded deletion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/project/project-demo-family/tree')
  await expect(page.getByRole('button', { name: '打开菜单', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '打开菜单', exact: true }).click()
  const menu = page.getByRole('dialog', { name: '项目菜单', exact: true })
  await expect(menu.getByRole('link', { name: '编印族谱', exact: true })).toHaveCount(0)
  await menu.getByRole('link', { name: '项目管理', exact: true }).click()
  await page.getByRole('link', { name: '打开编印族谱', exact: true }).click()
  await expect(page).toHaveURL(/\/manage\/publication$/)
  await expect(page.getByRole('button', { name: '刷新资料' })).toBeVisible()
  await expect(page.getByRole('link', { name: '返回项目管理', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '校对与预览', exact: true }).click()
  await expect(page.getByRole('heading', { name: '纸上族谱，从这里开始' })).toBeVisible()
  await page.getByRole('button', { name: '编印设置', exact: true }).click()
  await page.getByLabel('方案名称', { exact: true }).fill('手机编印方案')
  await page.getByRole('button', { name: /^保存方案/ }).click()
  await expect(page.getByLabel('切换编印方案')).toContainText('手机编印方案')
  await page.getByRole('button', { name: '删除方案', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '删除这套编印方案？' })
  await expect(dialog).toContainText('人物、附件和已经导出的 PDF 均保留')
  await dialog.getByRole('button', { name: '返回继续编辑' }).click()
  await expect(dialog).not.toBeVisible()
  const overflow = await page.evaluate<boolean>('document.documentElement.scrollWidth > window.innerWidth')
  expect(overflow).toBe(false)
})

test('refresh preserves edits and prevents overwriting a concurrently changed plan', async ({ page, context }) => {
  await openDemo(page, '/manage/publication')
  await page.getByLabel('方案名称', { exact: true }).fill('并发保护方案')
  await page.getByRole('button', { name: /^保存方案/ }).click()
  await expect(page.getByLabel('切换编印方案')).toContainText('并发保护方案')
  const other = await context.newPage()
  await openDemo(other, '/manage/publication')
  await page.getByLabel('族谱标题', { exact: true }).fill('本窗口未保存标题')
  await other.getByLabel('族谱标题', { exact: true }).fill('另一窗口已保存标题')
  await other.getByRole('button', { name: /^保存方案/ }).click()
  await expect(other.getByRole('button', { name: '保存方案', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '刷新资料' }).click()
  await expect(page.getByRole('button', { name: '重新载入已保存方案' })).toBeVisible()
  await page.getByRole('button', { name: /^保存方案/ }).click()
  await expect(page.getByRole('alert')).toContainText(/revision|版本|冲突|更新/i)
  await expect(page.getByLabel('族谱标题', { exact: true })).toHaveValue('本窗口未保存标题')
  await page.getByRole('button', { name: '重新载入已保存方案' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '放弃修改' }).click()
  await expect(page.getByLabel('族谱标题', { exact: true })).toHaveValue('另一窗口已保存标题')
  await other.close()
})

test('a failed status request releases its job and allows generating again', async ({ page }) => {
  await openDemo(page, '/manage/publication')
  let failed = false
  await page.route('**/__branchloom/publication', async (route) => {
    const body = route.request().postDataJSON() as { operation?: string }
    if (body.operation === 'status' && !failed) {
      failed = true
      await route.fulfill({ status: 503, body: '测试暂时不可用' })
    } else await route.continue()
  })
  await page.getByRole('button', { name: '生成 PDF', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: '生成 PDF', exact: true })).toBeEnabled()
  await page.unroute('**/__branchloom/publication')
  await page.getByRole('button', { name: '生成 PDF', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存 PDF', exact: true })).toBeEnabled({ timeout: 60_000 })
})
