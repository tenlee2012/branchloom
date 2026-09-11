import { expect, test, type Page } from '@playwright/test'
import { DEMO_PROJECT_PATH, expectNoRuntimeErrors, openProjectMenu, resetDemo, watchRuntimeErrors } from './helpers/demo'

test.use({ hasTouch: true })
test.beforeEach(async ({ page }) => resetDemo(page))

async function swipe(page: Page, from: [number, number], to: [number, number]) {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] })
    for (let step = 1; step <= 6; step += 1) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: from[0] + (to[0] - from[0]) * step / 6, y: from[1] + (to[1] - from[1]) * step / 6 }],
      })
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await session.detach()
  }
}

for (const width of [320, 390]) {
  test(`left menu keeps full navigation, focus and browser Back at ${width}px`, async ({ page }, testInfo) => {
    const errors = watchRuntimeErrors(page)
    await page.setViewportSize({ width, height: 844 })
    await expect(page).toHaveURL(`${DEMO_PROJECT_PATH}/tree?personId=person-lin-hai`)
    const treeUrl = page.url()
    const trigger = page.getByRole('button', { name: '打开菜单', exact: true, includeHidden: true })
    await expect(trigger).toBeVisible()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.mobile-project-navigation')).toHaveCount(0)
    const workspace = await page.locator('.project-layout__workspace').boundingBox()
    expect(workspace!.y + workspace!.height).toBe(844)

    const menu = await openProjectMenu(page)
    await expect(menu).toHaveCSS('transform', 'none')
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(menu).toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('#app')).toHaveAttribute('inert', '')
    const bounds = await menu.boundingBox()
    expect(bounds!.x).toBe(0)
    expect(bounds!.width).toBeLessThanOrEqual(width - 44)
    expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    for (const name of ['家谱树', '人物', '查称呼', '时间线', '资料来源', '项目管理', '协作同步', '数据检查', '设置']) {
      const link = menu.getByRole('link', { name, exact: true })
      await expect(link).toBeVisible()
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    await expect(menu.getByRole('link', { name: '家谱树', exact: true })).toHaveAttribute('aria-current', 'page')
    const close = menu.getByRole('button', { name: '关闭菜单' })
    await expect(close).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(menu.getByRole('link', { name: '返回当前项目家谱树' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(menu.locator('summary[aria-label="切换项目"]')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(menu.getByRole('link', { name: '家谱树', exact: true })).toBeFocused()
    await close.focus()
    await page.keyboard.press('Shift+Tab')
    await expect(menu.getByRole('link', { name: '设置', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(close).toBeFocused()
    await expect(close).toHaveCSS('outline-style', 'solid')
    await page.screenshot({ path: testInfo.outputPath('left-navigation.png') })
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.locator('#app')).not.toHaveAttribute('inert')

    await openProjectMenu(page)
    await page.goBack()
    await expect(menu).toHaveCount(0)
    await expect(page).toHaveURL(treeUrl)
    await openProjectMenu(page)
    await menu.getByRole('link', { name: '人物', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect(page).toHaveURL(`${DEMO_PROJECT_PATH}/people`)
    await expect(page.getByRole('heading', { name: '人物档案' })).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(treeUrl)
    await expect(menu).toHaveCount(0)
    expectNoRuntimeErrors(errors)
  })
}

test('edge swipe opens the menu, vertical scrolling keeps it open and left swipe closes it', async ({ page }) => {
  const errors = watchRuntimeErrors(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page).toHaveURL(`${DEMO_PROJECT_PATH}/tree?personId=person-lin-hai`)
  const treeUrl = page.url()
  const menu = page.getByRole('dialog', { name: '项目菜单' })
  await swipe(page, [8, 250], [170, 255])
  await expect(menu).toBeVisible()
  await expect(menu).toHaveCSS('transform', 'none')
  await swipe(page, [210, 550], [215, 350])
  await expect(menu).toBeVisible()
  await swipe(page, [230, 420], [30, 425])
  await expect(menu).toHaveCount(0)
  await expect(page).toHaveURL(treeUrl)
  await expect(page.locator('#app')).not.toHaveAttribute('inert')
  expectNoRuntimeErrors(errors)
})

test('backdrop and desktop resize dismiss the menu without leaving hidden focus traps', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const menu = await openProjectMenu(page)
  await page.locator('.mobile-navigation__backdrop').click({ position: { x: 380, y: 400 } })
  await expect(menu).toHaveCount(0)
  await openProjectMenu(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(menu).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '项目导航', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '打开菜单' })).toHaveCount(0)
  await expect(page.locator('#app')).not.toHaveAttribute('inert')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: '打开菜单' })).toHaveAttribute('aria-expanded', 'false')
  await expect(menu).toHaveCount(0)
})

test('native mobile capabilities keep the drawer and full labels in landscape', async ({ page }, testInfo) => {
  await page.route('**/src/shared/runtimeCapabilities.ts*', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: 'export async function loadRuntimeCapabilities() { return { mobile: true, aiTools: false, scheduledSync: false }; }',
  }))
  await page.setViewportSize({ width: 900, height: 500 })
  await page.reload()
  const menu = await openProjectMenu(page)
  await expect(menu.getByRole('link', { name: 'AI 工具', exact: true })).toHaveCount(0)
  await expect(menu.locator('.app-sidebar__link-label').first()).toBeVisible()
  await expect(menu.getByRole('link', { name: '人物', exact: true })).toBeVisible()
  const settings = menu.getByRole('link', { name: '设置', exact: true })
  await settings.focus()
  await expect(settings).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('android-landscape-menu.png') })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开菜单', exact: true })).toBeVisible()
  expect(await page.locator('html').evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(900)
})

test('closing the menu preserves the original return location from person details', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page).toHaveURL(`${DEMO_PROJECT_PATH}/tree?personId=person-lin-hai`)
  const origin = page.url()
  await page.getByRole('link', { name: '查看档案', exact: true }).click()
  const back = page.locator('.app-topbar').getByRole('button', { name: '返回上一页', exact: true })
  await expect(back).toBeVisible()
  const menu = await openProjectMenu(page)
  await menu.getByRole('button', { name: '关闭菜单' }).click()
  await expect(menu).toHaveCount(0)
  await expect(back).toBeVisible()
  await back.click()
  await expect(page).toHaveURL(origin)
})
