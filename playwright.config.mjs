// E2E for the WebRTC -> direct-channel fallback (test/e2e/). See test/e2e/harness.mjs.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: /.*\.spec\.mjs$/,
  workers: 1, // one shared harness (edge mock) and real-time measurements
  timeout: 90000,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    ignoreHTTPSErrors: true,
    launchOptions: {
      // E2E_CHROMIUM: use an already-installed Chromium instead of 'playwright install'
      executablePath: process.env.E2E_CHROMIUM || undefined,
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
    },
  },
});
