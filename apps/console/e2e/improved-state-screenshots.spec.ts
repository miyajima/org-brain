import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test.skip(!process.env.UPDATE_IMPROVED_UX_SCREENSHOTS, "Set UPDATE_IMPROVED_UX_SCREENSHOTS=1 to capture current implementation evidence.");

const outputDirectory = resolve(
  process.cwd(),
  process.env.ORGBRAIN_IMPROVED_SCREENSHOT_DIR ?? "artifacts/ux-audit/2026-08-22/improved-state/screenshots"
);

test("captures personal and team console evidence at required view sizes", async ({ page }) => {
  await mkdir(outputDirectory, { recursive: true });
  await page.emulateMedia({ reducedMotion: "reduce" });

  const captures = [
    {
      name: "01-personal-desktop-1440x900",
      viewport: { width: 1440, height: 900 },
      url: "/overview?tenant_id=personal-e2e&project_id=org-brain&lang=ja"
    },
    {
      name: "02-team-users-desktop-1440x900",
      viewport: { width: 1440, height: 900 },
      url: "/users?tenant_id=default&project_id=org-brain&lang=ja"
    },
    {
      name: "03-personal-mobile-390x844",
      viewport: { width: 390, height: 844 },
      url: "/overview?tenant_id=personal-e2e&project_id=org-brain&lang=ja"
    },
    {
      name: "04-team-groups-mobile-390x844",
      viewport: { width: 390, height: 844 },
      url: "/groups?tenant_id=default&project_id=org-brain&lang=ja"
    }
  ];

  for (const capture of captures) {
    await page.setViewportSize(capture.viewport);
    await page.goto(capture.url);
    await expect(page.locator("main")).toBeVisible();
    await page.screenshot({ path: resolve(outputDirectory, `${capture.name}.png`), fullPage: false });
  }

  await page.setViewportSize({ width: 720, height: 450 });
  await page.goto("/client-installations?tenant_id=default&project_id=org-brain&lang=ja");
  await expect(page.locator("main h1")).toBeVisible();
  await page.screenshot({ path: resolve(outputDirectory, "05-client-installations-200-percent-equivalent.png"), fullPage: false });
});
