import { defineConfig, devices } from "@playwright/test";

// Walks the real brand admin and retailer portal against a running node-ts (see run.sh).
export default defineConfig({
  testDir: ".",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "report" }]] : "list",
  use: {
    baseURL: process.env.OBX_E2E_URL ?? "http://localhost:18090",
    locale: "en-GB",
    trace: "retain-on-failure",
    actionTimeout: 20_000,
    ...devices["Desktop Chrome"],
  },
});
