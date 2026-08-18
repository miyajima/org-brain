import { expect, test } from "@playwright/test";
import { auditUrl, routeAuditCases } from "./route-audit-cases";

test("visible administration text never renders below 12px", async ({ page }) => {
  const failures: Array<{ path: string; tag: string; className: string; text: string; size: number }> = [];
  for (const route of routeAuditCases) {
    await page.goto(auditUrl(route.path));
    await page.locator("main").waitFor({ state: "visible" });
    const undersized = await page.locator("main *:not(svg):not(svg *)").evaluateAll((elements) => elements.flatMap((element) => {
      if (!(element instanceof HTMLElement) || element.closest('[aria-hidden="true"]')) return [];
      const directText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim() ?? "")
        .join(" ")
        .trim();
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (!directText || style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return [];
      const size = Number.parseFloat(style.fontSize);
      return size < 12 ? [{ tag: element.tagName.toLowerCase(), className: element.className, text: directText.slice(0, 60), size }] : [];
    }));
    failures.push(...undersized.map((item) => ({ path: route.path, ...item })));
  }
  expect(failures).toEqual([]);
});
