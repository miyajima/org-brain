import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { auditUrl, routeAuditCases } from "./route-audit-cases";

test.skip(!process.env.UPDATE_UX_SCREENSHOTS, "Set UPDATE_UX_SCREENSHOTS=1 to refresh the post-implementation UX evidence.");

const outputDirectory = resolve(process.cwd(), "../../artifacts/ux-audit/2026-08-18/target-96");
const scope = "tenant_id=default&project_id=org-brain&lang=ja";

test("captures the full desktop and mobile administration route matrix", async ({ page }) => {
  await mkdir(outputDirectory, { recursive: true });
  await page.emulateMedia({ reducedMotion: "reduce" });

  const captures = routeAuditCases.flatMap((route) => {
    const slug = route.path.replace(/^\//u, "").replaceAll("/", "-") || "home";
    return [
      { name: `desktop-${slug}`, viewport: { width: 1280, height: 720 }, url: auditUrl(route.path), ready: "main h1" },
      { name: `mobile-${slug}`, viewport: { width: 390, height: 844 }, url: auditUrl(route.path), ready: "main h1" }
    ];
  });

  for (const capture of captures) {
    await page.setViewportSize(capture.viewport);
    await page.goto(capture.url);
    await expect(page.locator(capture.ready)).toBeVisible();
    await page.screenshot({ path: resolve(outputDirectory, `${capture.name}.png`), fullPage: false });
  }

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`/memories/constellation?${scope}`);
  await expect(page.locator(".memory-map-accessible-picker")).toBeVisible();
  expect(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
  })).toBe(true);
  await expect(page.locator("[data-map-stage] canvas")).toBeVisible({ timeout: 20_000 });
  await page.locator("[data-map-stage-shell]").screenshot({ path: resolve(outputDirectory, "desktop-memory-map-webgl.png") });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/memories/constellation?${scope}`);
  await expect(page.locator("[data-map-fallback]")).toBeVisible();
  await page.screenshot({ path: resolve(outputDirectory, "desktop-memory-map-fallback.png"), fullPage: false });

  const stateCaptures = [
    { name: "desktop-activity-empty", url: "/overview?tenant_id=default&project_id=e2e-empty&lang=ja" },
    { name: "desktop-activity-error", url: "/overview?tenant_id=default&project_id=e2e-error&lang=ja" },
    { name: "desktop-history-empty", url: "/decisions/history?tenant_id=default&project_id=e2e-empty&lang=ja" },
    { name: "desktop-history-partial", url: "/decisions/history?tenant_id=default&project_id=e2e-truncated&lang=ja" },
    { name: "desktop-history-error", url: "/decisions/history?tenant_id=default&project_id=e2e-partial-error&lang=ja" },
    { name: "desktop-task-not-found", url: "/tasks/task-missing?tenant_id=default&project_id=org-brain&lang=ja" },
    { name: "desktop-task-events-error", url: "/tasks/task-e2e?tenant_id=default&project_id=e2e-task-events-error&lang=ja" },
    { name: "desktop-map-trace-error", url: "/memories/constellation?tenant_id=default&project_id=e2e-trace-error&lang=ja&selected=decision:rationale-e2e" }
  ];
  for (const capture of stateCaptures) {
    await page.goto(capture.url);
    await expect(page.locator("main")).toBeVisible();
    await page.screenshot({ path: resolve(outputDirectory, `${capture.name}.png`), fullPage: false });
  }

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/overview?${scope}`);
  await page.locator(".console-nav-menu summary").click();
  await page.screenshot({ path: resolve(outputDirectory, "desktop-management-menu.png"), fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/overview?${scope}`);
  await page.locator(".console-mobile-nav summary").click();
  await page.screenshot({ path: resolve(outputDirectory, "mobile-management-menu.png"), fullPage: false });
});
