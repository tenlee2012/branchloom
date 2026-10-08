import { expect, test } from '@playwright/test'
import { expectNoRuntimeErrors, openDemo, resetDemo, watchRuntimeErrors } from './helpers/demo'

test.beforeEach(async ({ page }) => resetDemo(page))

for (const [entry, path, width] of [
  ['timeline', '/timeline', 1280],
  ['person editor', '/people/person-lin-hai/edit', 1280],
  ['mobile timeline', '/timeline', 390],
  ['mobile person editor', '/people/person-lin-hai/edit', 390],
] as const) {
  test(`${entry} creates and edits a child place without replacing existing names`, async ({ page }) => {
    const errors = watchRuntimeErrors(page)
    await openDemo(page, path)
    await page.setViewportSize({ width, height: 900 })
    await page.getByRole('button', { name: '管理地点', exact: true }).click()
    const manager = page.getByRole('dialog', { name: '管理地点', exact: true })
    const records = manager.getByLabel('已有地点')
    const name = manager.getByLabel('地点名称')
    const actions = manager.locator('.place-manager__actions')
    const namesBefore = await records.locator('option').allTextContents()

    await expect(records).toHaveValue('')
    await expect(name).toHaveValue('')
    await expect(actions.getByRole('button')).toHaveCount(1)
    await expect(actions.getByRole('button', { name: '新建地点', exact: true })).toBeDisabled()
    await records.selectOption({ label: '中国' })
    await expect(name).toHaveValue('中国')
    await records.selectOption('')
    await expect(name).toHaveValue('')
    await expect(manager.getByLabel('别名')).toHaveValue('')
    await expect(manager.getByLabel('上级地点')).toHaveValue('')
    await expect(manager.getByLabel('备注')).toHaveValue('')
    await expect(manager.getByLabel('经度', { exact: true })).toHaveValue('')
    await expect(manager.getByLabel('纬度', { exact: true })).toHaveValue('')

    await name.fill('福州市')
    await manager.getByLabel('别名').fill('榕城')
    await manager.getByLabel('上级地点').selectOption({ label: '福建省' })
    await manager.getByLabel('备注').fill('地点管理回归测试')
    await manager.getByLabel('经度', { exact: true }).fill('119.2965')
    await actions.getByRole('button', { name: '新建地点', exact: true }).click()
    await expect(manager.getByRole('alert')).toContainText('同时填写')
    await manager.getByLabel('纬度', { exact: true }).fill('26.0745')
    await actions.getByRole('button', { name: '新建地点', exact: true }).click()
    await expect(manager).toBeHidden()

    await page.getByRole('button', { name: '管理地点', exact: true }).click()
    await expect(records.locator('option').filter({ hasText: /^福州市$/ })).toHaveCount(1)
    const namesAfter = await records.locator('option').allTextContents()
    expect(namesAfter).toHaveLength(namesBefore.length + 1)
    expect(namesAfter).toEqual(expect.arrayContaining([...namesBefore, '福州市']))
    await records.selectOption({ label: '福州市' })
    const createdId = await records.inputValue()
    await expect(manager.getByLabel('上级地点')).toHaveValue('place-fujian')
    await expect(manager.getByLabel('别名')).toHaveValue('榕城')
    await expect(manager.getByLabel('经度', { exact: true })).toHaveValue('119.2965')
    await expect(manager.getByLabel('纬度', { exact: true })).toHaveValue('26.0745')
    await page.getByRole('button', { name: '关闭地点管理', exact: true }).click()

    await page.reload()
    await page.getByRole('button', { name: '管理地点', exact: true }).click()
    await expect(records).toHaveValue('')
    await expect(name).toHaveValue('')
    await records.selectOption(createdId)
    await expect(name).toHaveValue('福州市')
    await expect(manager.getByLabel('上级地点')).toHaveValue('place-fujian')
    await expect(manager.getByLabel('备注')).toHaveValue('地点管理回归测试')
    await expect(manager.getByLabel('经度', { exact: true })).toHaveValue('119.2965')
    await expect(manager.getByLabel('纬度', { exact: true })).toHaveValue('26.0745')

    await name.fill('福州市（修订）')
    await name.press('Enter')
    await expect(manager).toBeHidden()
    await page.getByRole('button', { name: '管理地点', exact: true }).click()
    await records.selectOption(createdId)
    await expect(name).toHaveValue('福州市（修订）')
    await expect(manager.getByLabel('经度', { exact: true })).toHaveValue('119.2965')
    await expect(manager.getByLabel('纬度', { exact: true })).toHaveValue('26.0745')
    await expect(manager.getByLabel('上级地点')).toHaveValue('place-fujian')
    await expect(records.locator('option').filter({ hasText: /^福建省$/ })).toHaveCount(1)
    await expect(records.locator('option').filter({ hasText: /^中国$/ })).toHaveCount(1)
    await expect(records.locator('option')).toHaveCount(namesBefore.length + 1)
    await manager.getByLabel('经度', { exact: true }).fill('')
    await manager.getByLabel('纬度', { exact: true }).fill('')
    await manager.getByRole('button', { name: '保存地点', exact: true }).click()
    await expect(manager).toBeHidden()
    await page.reload()
    await page.getByRole('button', { name: '管理地点', exact: true }).click()
    await records.selectOption(createdId)
    await expect(manager.getByLabel('经度', { exact: true })).toHaveValue('')
    await expect(manager.getByLabel('纬度', { exact: true })).toHaveValue('')
    await page.getByRole('button', { name: '关闭地点管理', exact: true }).click()

    if (path.includes('/people/')) {
      await expect(page.getByLabel('出生地')).toContainText('福州市（修订）')
      await expect(page.getByRole('textbox', { name: '主姓名', exact: true })).toHaveValue('林海')
    }
    expectNoRuntimeErrors(errors)
  })
}
