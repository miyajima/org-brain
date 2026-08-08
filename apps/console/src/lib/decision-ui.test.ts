import { describe, expect, it } from "vitest";
import {
  buildDecisionVersionDiffs,
  compactOwnerRefs,
  compactSourceRefs,
  confirmationLabel,
  freshnessLabel,
  isExpired,
  isHumanConfirmed,
  isUnconfirmedInference,
  normalizeLocale,
  statusLabel
} from "./decision-ui";

describe("decision UI helpers", () => {
  it("maps internal decision states by locale", () => {
    expect(confirmationLabel("inferred_unconfirmed", "en")).toBe("Unconfirmed inference");
    expect(confirmationLabel("reviewed", "ja")).toBe("レビュー済み");
    expect(statusLabel("superseded", "zh")).toBe("已替代");
    expect(freshnessLabel("stale", "en")).toBe("Possibly stale");
  });

  it("normalizes unsupported locales to English", () => {
    expect(normalizeLocale("ja")).toBe("ja");
    expect(normalizeLocale("zh")).toBe("zh");
    expect(normalizeLocale("fr")).toBe("en");
  });

  it("detects trust warning states", () => {
    expect(isHumanConfirmed("user_confirmed")).toBe(true);
    expect(isHumanConfirmed("draft")).toBe(false);
    expect(isUnconfirmedInference("inferred_unconfirmed")).toBe(true);
    expect(isExpired(100, 200)).toBe(true);
  });

  it("serializes structured owner rows into the existing ownerRefs payload", () => {
    expect(
      compactOwnerRefs([
        { type: "user", id: " architect ", name: " Lead architect " },
        { type: "user", id: "", name: "" }
      ])
    ).toEqual([{ type: "user", id: "architect", name: "Lead architect" }]);
  });

  it("serializes structured source rows into the existing sourceRefs payload", () => {
    expect(
      compactSourceRefs([
        { type: "adr", id: " ADR-014 ", title: " API boundary ", url: " https://example.test/adr ", updatedAt: "2026-06-09" },
        { type: "", id: "", title: "", url: "", updatedAt: "2026-06-09" }
      ])
    ).toEqual([{ type: "adr", id: "ADR-014", title: "API boundary", url: "https://example.test/adr", updatedAt: "2026-06-09" }]);
  });

  it("compares adjacent decision snapshots in chronological order", () => {
    const diffs = buildDecisionVersionDiffs([
      { id: "v2", createdAt: 200, snapshot: { status: "active", confirmationState: "user_confirmed", validUntil: 500 } },
      { id: "v1", createdAt: 100, snapshot: { status: "uncertain", confirmationState: "inferred_unconfirmed", validUntil: null } }
    ]);
    expect(diffs.map((item) => item.version.id)).toEqual(["v2", "v1"]);
    expect(diffs[0]).toMatchObject({
      comparable: true,
      previousVersion: { id: "v1" },
      changes: [
        { field: "confirmationState", before: "inferred_unconfirmed", after: "user_confirmed" },
        { field: "status", before: "uncertain", after: "active" },
        { field: "validUntil", before: null, after: 500 }
      ]
    });
    expect(diffs[1]).toMatchObject({ comparable: false, previousVersion: null, changes: [] });
  });

  it("does not infer a diff when either adjacent snapshot is absent", () => {
    const diffs = buildDecisionVersionDiffs([
      { id: "v1", createdAt: 100 },
      { id: "v2", createdAt: 200, snapshot: { status: "active" } }
    ]);
    expect(diffs[0]).toMatchObject({ comparable: false, changes: [] });
  });
});
