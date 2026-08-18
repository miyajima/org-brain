import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { auditUrl, primaryFlowPaths, routeAuditCases } from "./route-audit-cases";

test.describe("console accessibility", () => {
  for (const route of routeAuditCases) {
    for (const locale of route.locales) {
      test(`has no WCAG A/AA violations on ${route.path} in ${locale}`, async ({ page }) => {
        await page.goto(auditUrl(route.path, locale));
        await page.locator("main").waitFor({ state: "visible" });
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page.locator("main h1"), `${route.path} must expose one visible page heading`).toHaveCount(1);
        await expect(page.locator("main h1")).toBeVisible();

        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();

        expect(results.violations).toEqual([]);
      });
    }
  }

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 }
  ]) {
    test(`all routes avoid page-level horizontal scrolling at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      for (const route of routeAuditCases) {
        await page.goto(auditUrl(route.path));
        await page.locator("main").waitFor({ state: "visible" });
        const overflow = await page.evaluate(() => ({
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          body: document.body.scrollWidth - document.body.clientWidth
        }));
        expect(overflow, route.path).toEqual({ document: 0, body: 0 });
      }
    });
  }

  test("primary flows reflow at 400% equivalent width", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    for (const path of primaryFlowPaths) {
      await page.goto(auditUrl(path));
      await page.locator("main").waitFor({ state: "visible" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), path).toBe(0);
    }
  });

  test("all routes reflow at a 200% zoom equivalent viewport", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 720 });
    for (const route of routeAuditCases) {
      await page.goto(auditUrl(route.path));
      await page.locator("main").waitFor({ state: "visible" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), route.path).toBe(0);
    }
  });

  test("focus indicators and targets remain usable in forced colors", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await page.goto(auditUrl("/overview"));
    await page.keyboard.press("Tab");
    await expect(page.locator(".console-skip-link")).toBeFocused();
    await expect(page.locator(".console-skip-link")).toBeVisible();
  });
});
