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

  test("primary administration controls provide at least 44px touch targets", async ({ page }) => {
    for (const path of ["/users", "/groups/group-e2e", "/memories", "/operations"]) {
      await page.goto(auditUrl(path));
      await page.locator("main").waitFor({ state: "visible" });
      const undersized = await page.locator("main a[href], main button, main input:not([type=hidden]):not([type=checkbox]), main select, main summary, nav a[href], nav summary").evaluateAll((elements) =>
        elements.filter((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0 && (box.height < 44 || box.width < 44);
        }).map((element) => ({ tag: element.tagName, text: element.textContent?.trim().slice(0, 60), box: element.getBoundingClientRect().toJSON() }))
      );
      expect(undersized, path).toEqual([]);
    }
  });

  test("expanded memory technical controls keep 44px targets", async ({ page }) => {
    await page.goto(auditUrl("/memories?selected=mem_auth_group_acl", "en"));
    const panel = page.locator(".memory-detail-panel");
    for (const summary of await panel.locator("details:not([open]) > summary").all()) {
      if (await summary.isVisible()) await summary.click();
    }
    const undersized = await panel.locator("a[href], button, input:not([type=hidden]):not([type=checkbox]), select, summary").evaluateAll((elements) =>
      elements.filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0 && (box.height < 44 || box.width < 44);
      }).map((element) => ({ tag: element.tagName, text: element.textContent?.trim().slice(0, 60), box: element.getBoundingClientRect().toJSON() }))
    );
    expect(undersized).toEqual([]);
  });
});
