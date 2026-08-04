import { expect, type Page } from '@playwright/test'

export const DEMO_PROJECT_ID = 'project-demo-family'
export const DEMO_PROJECT_PATH = `/project/${DEMO_PROJECT_ID}`

/** Restores the deterministic fixture in the isolated E2E data directory. */
export async function resetDemo(page: Page): Promise<void> {
  await page.goto('/')
  const resetOk = await page.evaluate(async ({ fixturePath, snapshotsPath }) => {
    const fixture = await import(/* @vite-ignore */ fixturePath) as { createDemoState(): unknown }
    const snapshots = await import(/* @vite-ignore */ snapshotsPath) as { createCanonicalDemoSnapshotPayloads(): unknown }
    const revisionResponse = await fetch('/__branchloom/revision')
    if (!revisionResponse.ok) return false
    const expectedRevision = await revisionResponse.json() as number
    const resetResponse = await fetch('/__branchloom/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stateJson: JSON.stringify(fixture.createDemoState()),
        snapshotPayloadsJson: JSON.stringify(snapshots.createCanonicalDemoSnapshotPayloads()),
        expectedRevision,
      }),
    })
    return resetResponse.ok
  }, {
    fixturePath: '/src/shared/fixtures/demoState.ts',
    snapshotsPath: '/src/shared/repository/demoSnapshotPayloads.ts',
  })
  expect(resetOk).toBe(true)
  await page.goto(`${DEMO_PROJECT_PATH}/tree`)
  await expect(page).toHaveURL(`${DEMO_PROJECT_PATH}/tree`)
  await expect(page.getByRole('navigation', { name: '项目导航' })).toBeVisible()
  await expect(page.getByText('中心人物：林海')).toBeVisible()
}

export async function openDemo(page: Page, suffix = '/tree'): Promise<void> {
  await page.goto(`${DEMO_PROJECT_PATH}${suffix}`)
  await expect(page.getByRole('navigation', { name: '项目导航' })).toBeVisible()
}

export function watchRuntimeErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  return errors
}

export function expectNoRuntimeErrors(errors: string[]): void {
  expect(errors, errors.join('\n')).toEqual([])
}
