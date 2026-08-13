import { expect, test } from '@playwright/test'
import { resetDemo } from './helpers/demo'

test.beforeEach(async ({ page }) => resetDemo(page))

test('opens the latest project tree as the application home', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveURL('/project/project-demo-family/tree')
  await expect(page.getByRole('navigation', { name: '项目导航' })).toBeVisible()
  await expect(page.getByText('中心人物：林海')).toBeVisible()

  await page.getByRole('link', { name: '项目管理', exact: true }).click()
  const projectOverview = page.locator('.project-overview')
  await expect(projectOverview.getByRole('link', { name: '新建项目', exact: true })).toBeVisible()
  await projectOverview.getByRole('link', { name: '新建项目', exact: true }).click()
  await expect(page).toHaveURL('/project/project-demo-family/manage/new')
  await expect(page.getByRole('link', { name: '项目管理', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '数据检查', exact: true })).toBeVisible()

  await page.getByRole('link', { name: '返回当前项目家谱树' }).click()
  await expect(page).toHaveURL('/project/project-demo-family/tree')
})

test('opens the GitHub import entry from the home project flow', async ({ page }) => {
  await page.goto('/new')

  await page.getByRole('link', { name: '已有 GitHub 项目？直接导入' }).click()

  await expect(page).toHaveURL('/github-import')
  await expect(page.getByRole('heading', { name: '从 GitHub 导入' })).toBeVisible()
  await expect(page.getByText('GitHub 项目导入仅在桌面端可用')).toBeVisible()
  await expect(page.getByRole('link', { name: '返回首页' })).toBeVisible()
})
