import { defineConfig, devices } from "@playwright/test";

const consolePort = Number(process.env.CONSOLE_E2E_PORT ?? 4321);
const mockApiPort = Number(process.env.CONSOLE_E2E_API_PORT ?? 19087);
const browserExecutablePath = process.env.CONSOLE_E2E_BROWSER_EXECUTABLE;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: process.env.CONSOLE_E2E_DECISION_MODE ? [] : ["**/decision-console-v2.spec.ts"],
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${consolePort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: [
    {
      command: `node ./e2e/mock-api.mjs --port ${mockApiPort}`,
      url: `http://127.0.0.1:${mockApiPort}/health`,
      reuseExistingServer: false,
      timeout: 15_000
    },
    {
      command: `./node_modules/.bin/astro dev --host 127.0.0.1 --port ${consolePort}`,
      url: `http://127.0.0.1:${consolePort}/profile`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        API_BASE_URL: `http://127.0.0.1:${mockApiPort}`,
        INTERNAL_API_KEY: "dev-org-brain-api-key",
        ACCESS_JWT_REQUIRED: "false",
        CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
        INSIGHTS_UI_MODE: "on",
        MEMORY_QUALITY_UI_MODE: "on",
        DECISION_CONSOLE_MODE: process.env.CONSOLE_E2E_DECISION_MODE ?? "off"
      }
    }
  ],
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(browserExecutablePath ? { launchOptions: { executablePath: browserExecutablePath } } : {})
      }
    }
  ]
});
