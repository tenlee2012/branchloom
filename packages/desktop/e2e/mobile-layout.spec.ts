import { expect, test, type Locator } from '@playwright/test'
import { DEMO_PROJECT_PATH, resetDemo } from './helpers/demo'

test.beforeEach(async ({ page }) => resetDemo(page))

async function expectSingleLine(locator: Locator) {
  await expect(locator).toBeVisible()
  const lineTops = await locator.evaluate((element) => {
    const range = element.ownerDocument.createRange()
    range.selectNodeContents(element)
    return [...range.getClientRects()]
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => Math.round(rect.top))
  })
  expect(new Set(lineTops).size).toBe(1)
}

async function expectInlineCount(count: Locator) {
  const number = await count.locator('strong').boundingBox()
  const unit = await count.locator('span').boundingBox()
  expect(number).not.toBeNull()
  expect(unit).not.toBeNull()
  expect(unit!.x).toBeGreaterThanOrEqual(number!.x + number!.width - 1)
  const overlap = Math.min(number!.y + number!.height, unit!.y + unit!.height)
    - Math.max(number!.y, unit!.y)
  expect(overlap).toBeGreaterThan(0)
}

async function expectNoOverflow(container: Locator) {
  const fits = await container.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  expect(fits).toBe(true)
}

for (const width of [320, 390]) {
  test(`tree topbar keeps compact accessible actions at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 })
    const topbar = page.locator('.app-topbar')
    const refresh = topbar.getByRole('button', { name: '刷新资料', exact: true })
    const addPerson = topbar.getByRole('button', { name: '添加人物', exact: true })

    for (const button of [refresh, addPerson]) {
      await expect(button).toBeVisible()
      const bounds = await button.boundingBox()
      expect(bounds!.width).toBeGreaterThanOrEqual(44)
      expect(bounds!.width).toBeLessThanOrEqual(48)
      expect(bounds!.height).toBeGreaterThanOrEqual(44)
    }
    await expect(topbar.getByRole('button', { name: '适应画布' })).toBeHidden()
    const actions = await topbar.locator('.app-topbar__actions').boundingBox()
    expect(actions!.width).toBeLessThanOrEqual(100)
    const projectName = topbar.locator('.app-topbar__mobile-project')
    await expect(projectName).toBeVisible()
    const titleArea = await topbar.locator('.app-topbar__drag-surface').boundingBox()
    expect(titleArea!.width).toBeGreaterThan(width * 0.45)
    await expectNoOverflow(topbar)

    await refresh.click()
    await expect(refresh).toBeEnabled()
    await expect(refresh).toHaveAttribute('aria-busy', 'false')
    await page.screenshot({ path: testInfo.outputPath('mobile-tree.png') })
    await addPerson.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(addPerson).toBeFocused()
    await expect(addPerson).toHaveCSS('outline-style', 'solid')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(`${DEMO_PROJECT_PATH}/people/new`)
    await expect(page.getByRole('heading', { name: '新建人物', exact: true })).toBeVisible()
  })

  test(`people and timeline headers keep their labels intact at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`${DEMO_PROJECT_PATH}/people`)
    const peopleHeader = page.locator('.people-view__heading')
    await expectSingleLine(peopleHeader.getByRole('heading', { name: '人物档案' }))
    await expect(peopleHeader.locator('.people-view__count')).toHaveText(/12\s*位人物/)
    await expectInlineCount(peopleHeader.locator('.people-view__count'))
    const newPerson = peopleHeader.getByRole('button', { name: '新建人物' })
    await expectSingleLine(newPerson.locator('.base-button__content'))
    await expectNoOverflow(peopleHeader)
    await page.screenshot({ path: testInfo.outputPath('mobile-people.png') })
    await newPerson.click()
    await expect(page).toHaveURL(`${DEMO_PROJECT_PATH}/people/new`)

    await page.getByRole('navigation', { name: '移动端项目导航' })
      .getByRole('link', { name: '时间', exact: true }).click()
    await expect(page).toHaveURL(`${DEMO_PROJECT_PATH}/timeline`)
    const timelineHeader = page.locator('.timeline-view__heading')
    await expect(timelineHeader.locator('.timeline-view__count')).toHaveText(/8\s*件事件/)
    await expectInlineCount(timelineHeader.locator('.timeline-view__count'))
    for (const name of ['管理地点', '新建事件']) {
      await expectSingleLine(timelineHeader.getByRole('button', { name }).locator('.base-button__content'))
    }
    await expectNoOverflow(timelineHeader)
    await page.screenshot({ path: testInfo.outputPath('mobile-timeline.png') })

    await timelineHeader.getByRole('button', { name: '管理地点' }).click()
    await expect(page.getByRole('dialog', { name: '管理地点', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭地点管理' }).click()
    await timelineHeader.getByRole('button', { name: '新建事件' }).click()
    await expect(page.getByRole('dialog', { name: '新建事件', exact: true })).toBeVisible()
  })
}

test('desktop keeps text labels on tree actions and readable page headings', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const topbar = page.locator('.app-topbar')
  await expect(topbar.locator('.data-refresh__label')).toBeVisible()
  await expect(topbar.locator('.app-topbar__add-person-label')).toBeVisible()
  await expect(topbar.getByRole('button', { name: '适应画布' })).toBeVisible()

  for (const [path, headingClass, title] of [
    ['people', '.people-view__heading', '人物档案'],
    ['timeline', '.timeline-view__heading', '时间线'],
  ] as const) {
    await page.goto(`${DEMO_PROJECT_PATH}/${path}`)
    const heading = page.locator(headingClass)
    await expectSingleLine(heading.getByRole('heading', { name: title }))
    await expectNoOverflow(heading)
  }
})
