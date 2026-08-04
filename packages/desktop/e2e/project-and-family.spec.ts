import { expect, test, type Page } from '@playwright/test'
import {
  DEMO_PROJECT_PATH,
  expectNoRuntimeErrors,
  openDemo,
  resetDemo,
  watchRuntimeErrors,
} from './helpers/demo'

test.beforeEach(async ({ page }) => resetDemo(page))

async function quickAddRelative(
  page: Page,
  input: { name: string; category?: 'parent' | 'partner'; direction?: 'relative-is-parent' | 'current-is-parent' },
) {
  await page.getByRole('button', { name: '添加人物' }).click()
  const dialog = page.getByRole('dialog', { name: '添加人物与关系' })
  await dialog.getByLabel('姓名').fill(input.name)
  if (input.category) await dialog.getByLabel('关系大类').selectOption(input.category)
  if (input.direction) await dialog.getByLabel('关系方向').selectOption(input.direction)
  await dialog.getByRole('button', { name: '添加并关联', exact: true }).click()
  await expect(dialog).toBeHidden()
}

test('new project builds a center family with parents, partner and child, then opens the tree', async ({ page }) => {
  const errors = watchRuntimeErrors(page)
  await page.getByLabel('切换项目').click()
  await page.getByRole('link', { name: '新建项目' }).click()
  await page.getByLabel('项目名称').fill('端到端家庭档案')
  await page.getByLabel('项目简介（可选）').fill('验证一期核心家庭闭环')
  await page.getByRole('button', { name: '建立家谱' }).click()
  await expect(page).toHaveURL(/\/project\/[^/]+\/tree$/)
  await expect(page.getByText('没有找到中心人物')).toBeVisible()

  await page.getByRole('link', { name: '人物', exact: true }).click()
  await page.getByRole('button', { name: '新建人物' }).click()
  const personDrawer = page.getByRole('dialog', { name: '新建人物' })
  await personDrawer.getByRole('textbox', { name: '主姓名', exact: true }).fill('测试中心人物')
  await personDrawer.getByLabel('生存状态').selectOption('living')
  await personDrawer.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('link', { name: '打开人物详情：测试中心人物' }).click()

  await quickAddRelative(page, { name: '测试父亲' })
  await quickAddRelative(page, { name: '测试母亲' })
  await quickAddRelative(page, { name: '测试伴侣', category: 'partner' })
  await quickAddRelative(page, { name: '测试子女', direction: 'current-is-parent' })
  await expect(page.locator('[data-person-relationships]')).toContainText('测试父亲')
  await expect(page.locator('[data-person-relationships]')).toContainText('测试伴侣')
  await expect(page.locator('[data-person-relationships]')).toContainText('测试子女')

  await page.getByRole('link', { name: '人物', exact: true }).click()
  await page.getByRole('button', { name: '设为中心人物：测试中心人物' }).click()
  await page.getByRole('link', { name: '家谱树', exact: true }).click()
  await expect(page.getByText('中心人物：测试中心人物')).toBeVisible()
  await expect(page.getByTestId('family-graph')).toBeVisible()
  expectNoRuntimeErrors(errors)
})

test('people search leads to detail editing, a timeline event and a source citation', async ({ page }) => {
  const errors = watchRuntimeErrors(page)
  await openDemo(page, '/people')
  await page.getByLabel('搜索人物').fill('林海')
  await page.getByRole('link', { name: '打开人物详情：林海' }).click()
  await page.getByRole('button', { name: '编辑人物' }).click()
  await page.getByRole('tab', { name: '生平轨迹' }).click()
  await page.getByLabel('内部整理笔记').fill('E2E 持久化核对标记')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('tab', { name: '生平轨迹' }).click()
  await expect(page.locator('[data-person-notes]')).toContainText('E2E 持久化核对标记')

  await page.getByRole('link', { name: '时间线' }).click()
  await page.getByRole('button', { name: '新建事件' }).click()
  const eventDrawer = page.getByRole('dialog', { name: '新建事件' })
  await eventDrawer.getByLabel('事件类型').selectOption('__custom__')
  await eventDrawer.getByLabel('自定义事件类型').fill('家庭叙事')
  await eventDrawer.getByLabel('标题或摘要').fill('E2E 家庭访谈')
  await eventDrawer.getByLabel('显示文字').fill('2026-07-22')
  await eventDrawer.getByLabel('开始边界').fill('2026-07-22')
  await eventDrawer.getByLabel('结束边界').fill('2026-07-22')
  await eventDrawer.getByLabel('林海').check()
  await eventDrawer.getByLabel('林海的事件角色').fill('讲述者')
  await eventDrawer.getByLabel('林氏族谱民国抄本').check()
  await eventDrawer.getByRole('button', { name: '保存事件' }).click()
  const savedEvent = page.locator('.timeline-event').filter({ hasText: 'E2E 家庭访谈' })
  await expect(savedEvent).toContainText('家庭叙事')
  await expect(savedEvent).toContainText('讲述者')

  await page.getByRole('link', { name: '资料来源' }).click()
  await page.getByRole('button', { name: '新建引用' }).click()
  const citationDrawer = page.getByRole('dialog', { name: '新建引用' })
  await citationDrawer.getByLabel('来源').selectOption({ label: '林氏族谱民国抄本' })
  await citationDrawer.getByLabel('资料类型').selectOption('person')
  await citationDrawer.getByLabel('支持的资料').selectOption({ label: '林海' })
  await citationDrawer.getByLabel('页码、章节或定位信息').fill('E2E 第 22 页')
  await citationDrawer.getByRole('button', { name: '保存引用' }).click()
  await expect(page.getByRole('button', { name: /E2E 第 22 页/ })).toBeVisible()
  expectNoRuntimeErrors(errors)
})

test('semantic names plus modern and ancient careers remain searchable after refresh', async ({ page }) => {
  const errors = watchRuntimeErrors(page)
  await openDemo(page, '/people/person-lin-hai')

  await page.getByRole('button', { name: '编辑人物' }).click()
  await expect(page.getByRole('heading', { name: '编辑林海' })).toBeVisible()
  const personEditor = page.locator('form.person-editor')
  await expect(page.getByRole('dialog', { name: '编辑人物档案' })).toHaveCount(0)
  await personEditor.getByRole('button', { name: '添加姓名' }).click()
  const addedName = personEditor.locator('input[name="personName"]').last()
  await addedName.fill('海川')
  await personEditor.locator('select[aria-label^="姓名类型"]').last().selectOption('courtesy')
  await personEditor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('button', { name: '编辑人物' })).toBeVisible()
  await page.getByRole('tab', { name: '生平轨迹' }).click()
  await expect(page.getByRole('heading', { name: '人物履历' })).toBeVisible()

  await page.getByRole('button', { name: '添加履历' }).click()
  const careerDrawer = page.getByRole('dialog', { name: '添加人物履历' })
  await careerDrawer.getByLabel('履历类型').selectOption('employment')
  await careerDrawer.getByLabel('或新建机构').fill('端到端设计公司')
  await careerDrawer.getByLabel('职位').fill('首席设计师')
  await careerDrawer.getByLabel('开始时间', { exact: true }).fill('2020')
  await careerDrawer.getByLabel('任职状态').selectOption('current')
  await careerDrawer.getByRole('button', { name: '保存履历' }).click()
  await expect(page.locator('[data-person-careers]')).toContainText('端到端设计公司')
  await expect(page.locator('[data-person-careers]')).toContainText('首席设计师')

  await page.getByRole('button', { name: '添加履历' }).click()
  const ancientCareerDrawer = page.getByRole('dialog', { name: '添加人物履历' })
  await ancientCareerDrawer.getByLabel('履历类型').selectOption('civil_office')
  await ancientCareerDrawer.getByLabel('或新建机构').fill('杭州州府')
  await ancientCareerDrawer.getByLabel('机构类型').selectOption('government')
  await ancientCareerDrawer.getByLabel('官职原文').fill('杭州通判')
  await ancientCareerDrawer.getByLabel('开始时间', { exact: true }).fill('熙宁四年')
  await ancientCareerDrawer.getByLabel('结束时间', { exact: true }).fill('熙宁七年')
  await ancientCareerDrawer.getByLabel('任职状态').selectOption('former')
  await ancientCareerDrawer.getByLabel('朝代／政权').fill('北宋')
  await ancientCareerDrawer.getByLabel('品秩／等级').fill('从六品')
  await ancientCareerDrawer.getByLabel('任命性质').fill('任职')
  await ancientCareerDrawer.getByRole('button', { name: '保存履历' }).click()
  await expect(page.locator('[data-person-careers]')).toContainText('杭州州府')
  await expect(page.locator('[data-person-careers]')).toContainText('杭州通判')
  await expect(page.locator('[data-person-careers]')).toContainText('北宋')

  await page.reload()
  await expect(page.locator('[data-person-careers]')).toContainText('端到端设计公司')
  await expect(page.locator('[data-person-careers]')).toContainText('杭州通判')
  await page.getByRole('link', { name: '人物', exact: true }).click()
  await page.getByLabel('搜索人物').fill('端到端设计公司')
  await expect(page.getByRole('link', { name: '打开人物详情：林海' })).toBeVisible()
  await page.getByLabel('搜索人物').fill('北宋')
  await expect(page.getByRole('link', { name: '打开人物详情：林海' })).toBeVisible()
  await page.getByLabel('搜索人物').fill('海川')
  await expect(page.getByRole('link', { name: '打开人物详情：林海' })).toBeVisible()
  expectNoRuntimeErrors(errors)
})

test('browser refresh preserves project edits', async ({ page }) => {
  const errors = watchRuntimeErrors(page)
  await openDemo(page, '/manage/settings')
  await page.getByLabel('项目名称').fill('刷新后仍存在的项目名')
  await page.getByRole('button', { name: '保存项目设置' }).click()
  await expect(page.getByTitle('刷新后仍存在的项目名')).toBeVisible()

  await page.reload()
  await expect(page.getByLabel('项目名称')).toHaveValue('刷新后仍存在的项目名')
  await expect(page.getByRole('button', { name: '重置演示数据' })).toHaveCount(0)
  expectNoRuntimeErrors(errors)
})
