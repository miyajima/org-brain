// Without a tokenizer, only ASCII is cheap enough to assume four characters per token. Han, kana and
// Hangul cost about 0.7-1 token per character in current BPE vocabularies (o200k measured 0.7-0.85 on
// Japanese and Korean prose), and emoji and other scripts cost one or more, so every non-ASCII code
// point counts as one token. That over-counts accented Latin, which only makes a budget stricter.
const ASCII_CHARS_PER_TOKEN = 4;

/** Estimates prompt tokens for text without a tokenizer; plain JS so Workers, Node and the CLI share one algorithm. */
export function estimateTextTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) ascii += 1;
    else other += 1;
  }
  return Math.ceil(other + ascii / ASCII_CHARS_PER_TOKEN);
}

/** Estimates tokens for a JSON-serializable value by its compact JSON text. */
export function estimateJsonTokens(value) {
  const json = JSON.stringify(value);
  return typeof json === "string" ? estimateTextTokens(json) : 0;
}

/** Longest prefix of text whose estimateTextTokens does not exceed maxTokens (never splits a code point). */
export function truncateTextToTokens(text, maxTokens) {
  if (typeof text !== "string" || text.length === 0 || !(maxTokens > 0)) return "";
  // Quarter-token units: ASCII costs 1, any other code point costs 4, so ceil(units / 4) is estimateTextTokens.
  const limit = Math.floor(maxTokens) * ASCII_CHARS_PER_TOKEN;
  let units = 0;
  let end = 0;
  for (const char of text) {
    units += char.charCodeAt(0) < 0x80 ? 1 : ASCII_CHARS_PER_TOKEN;
    if (units > limit) break;
    end += char.length;
  }
  return text.slice(0, end);
}
