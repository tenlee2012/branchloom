import { expect, test } from '@playwright/test'
import {
  expectNoRuntimeErrors,
  openDemo,
  resetDemo,
  watchRuntimeErrors,
} from './helpers/demo'

test.beforeEach(async ({ page }) => resetDemo(page))

test('web view exposes only the real desktop project-package workflow', async ({ page }) => {
  const errors = watchRuntimeErrors(page)
  await openDemo(page, '/manage/exchange')

  await expect(page.getByRole('heading', { name: '导入 .blp 项目' })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择项目包' })).toBeDisabled()
  await expect(page.getByRole('note')).toContainText('需要在 Mac 桌面版中使用')
  await expect(page.getByText('演示样本')).toHaveCount(0)

  await page.getByRole('tab', { name: /导出项目包/ }).click()
  await expect(page.getByRole('heading', { name: '导出 .blp 项目' })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择保存位置' })).toBeDisabled()
  await expect(page.getByText('配置输出预览')).toHaveCount(0)
  expectNoRuntimeErrors(errors)
})
