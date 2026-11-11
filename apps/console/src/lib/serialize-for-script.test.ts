import { describe, expect, it } from "vitest";
import { serializeForScript } from "./serialize-for-script";

describe("serializeForScript", () => {
  it("escapes less-than signs so script end tags cannot appear in data", () => {
    const serialized = serializeForScript({ text: "</script><b>" });
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized)).toEqual({ text: "</script><b>" });
  });

  it("serializes ordinary values as JSON", () => {
    expect(serializeForScript({ nodes: [1], edges: [] })).toBe('{"nodes":[1],"edges":[]}');
  });
});
