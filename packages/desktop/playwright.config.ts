import { defineConfig } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep local web server probes out of system or corporate proxies.
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1'].filter(Boolean).join(',')
process.env.no_proxy = [process.env.no_proxy, '127.0.0.1'].filter(Boolean).join(',')
const testDataDirectory = mkdtempSync(join(tmpdir(), 'branchloom-web-e2e-'))
const testPort = process.env.BRANCHLOOM_E2E_PORT ?? '4174'
const testBaseUrl = `http://127.0.0.1:${testPort}`

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 45_000,
  workers: 1,
  expect: { timeout: 8_000 },
  use: {
    baseURL: testBaseUrl,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${testPort}`,
    url: testBaseUrl,
    reuseExistingServer: false,
    env: { BRANCHLOOM_DATA_DIR: testDataDirectory },
  },
})
