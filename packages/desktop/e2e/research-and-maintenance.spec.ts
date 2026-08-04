import { expect, test } from '@playwright/test'
import {
  expectNoRuntimeErrors,
  openDemo,
  resetDemo,
  watchRuntimeErrors,
} from './helpers/demo'

test.beforeEach(async ({ page }) => resetDemo(page))

test('duplicate review shows an explicit merge preview, creates a snapshot and removes the duplicate', async ({ page }) => {
  const errors = watchRuntimeErrors(page)
  await openDemo(page, '/manage/checks')
  await expect(page.getByRole('heading', { name: '重复人物候选' })).toBeVisible()
  const candidate = page.locator('.duplicate-candidates article').filter({ hasText: '林晨' }).first()
  await candidate.getByRole('button', { name: /进入合并/ }).click()

  const wizard = page.getByRole('dialog', { name: '合并人物' })
  await expect(wizard).toContainText('逐项核对')
  const fieldChoices = wizard.locator('select[name^="choice-"]')
  for (let index = 0; index < await fieldChoices.count(); index += 1) {
    await fieldChoices.nth(index).selectOption('keep')
  }
  const relationshipChoices = wizard.locator('select[name^="relationship-choice-"]')
  for (let index = 0; index < await relationshipChoices.count(); index += 1) {
    await relationshipChoices.nth(index).selectOption({ index: 1 })
  }
  await expect(wizard).toContainText('预览：删除')
  await wizard.getByRole('button', { name: '确认合并' }).click()
  const result = page.getByRole('dialog', { name: '合并完成' })
  await expect(result).toContainText('已创建合并前快照')
  await result.getByRole('button', { name: '完成' }).click()

  await page.getByRole('link', { name: '人物', exact: true }).click()
  await page.getByLabel('搜索人物').fill('林晨')
  await expect(page.getByRole('link', { name: '打开人物详情：林晨' })).toHaveCount(1)
  expectNoRuntimeErrors(errors)
})

test('data checks navigate to the target and cleanup requires a snapshot-backed confirmation flow', async ({ page }) => {
  const errors = watchRuntimeErrors(page)
  await openDemo(page, '/manage/checks')
  await page.getByRole('button', { name: '开始检查' }).click()
  await page.getByRole('button', { name: '继续检查' }).click()
  await page.getByRole('button', { name: '继续检查' }).click()
  const target = page.getByRole('link', { name: /查看资料：附件“林国强旧信\.pdf”缺失/ })
  await expect(target).toBeVisible()
  await target.click()
  await expect(page).toHaveURL(/\/sources\?attachment=attachment-missing-letter/)
  await expect(page.getByText('已定位附件')).toBeVisible()

  await page.goBack()
  await page.getByRole('button', { name: '清理项目' }).click()
  const cleanup = page.getByRole('dialog', { name: '清理项目' })
  await expect(cleanup).toContainText('确认后会先自动创建快照')
  await cleanup.getByRole('button', { name: '开始清理' }).click()
  await cleanup.getByRole('button', { name: '继续' }).click()
  await cleanup.getByRole('button', { name: '继续' }).click()
  await expect(page.getByText(/清理完成：移除附件/)).toBeVisible()
  expectNoRuntimeErrors(errors)
})

test('manual history snapshot offers a restore preview and protects the current state before restore', async ({ page }) => {
  const errors = watchRuntimeErrors(page)
  await openDemo(page, '/manage/history')
  await page.getByRole('button', { name: '创建手动快照' }).click()
  const snapshotDialog = page.getByRole('dialog', { name: '创建手动快照' })
  await snapshotDialog.getByLabel('名称或备注').fill('E2E 恢复节点')
  await snapshotDialog.getByRole('button', { name: '创建手动快照' }).click()
  await expect(page.getByRole('heading', { name: 'E2E 恢复节点' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'E2E 恢复节点' })).toBeVisible()
  await page.getByRole('button', { name: '恢复版本：E2E 恢复节点' }).click()

  const restore = page.getByRole('dialog', { name: '恢复历史版本' })
  await expect(restore).toContainText('恢复失败时当前项目与快照资料都不会被替换')
  await restore.getByRole('button', { name: '确认恢复' }).click()
  await restore.getByRole('button', { name: '继续' }).click()
  await restore.getByRole('button', { name: '继续' }).click()
  await expect(page.getByText(/恢复完成并重新检查；恢复前状态已保存/)).toBeVisible()
  expectNoRuntimeErrors(errors)
})
