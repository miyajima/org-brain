// JSON for an inline <script> or data attribute. Escaping "<" keeps "</script>" in data from closing the tag.
export function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}
