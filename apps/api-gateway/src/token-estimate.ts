// Without a tokenizer, only ASCII is cheap enough to assume four characters per token. Han, kana and
// Hangul cost about 0.7-1 token per character in current BPE vocabularies (o200k measured 0.7-0.85 on
// Japanese and Korean prose), and emoji and other scripts cost one or more, so every non-ASCII code
// point counts as one token. That over-counts accented Latin, which only makes a budget stricter.
const ASCII_CHARS_PER_TOKEN = 4;

/** Estimates prompt tokens for text without a tokenizer; safe to run in a Worker. */
export function estimateTextTokens(text: string) {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) ascii += 1;
    else other += 1;
  }
  return Math.ceil(other + ascii / ASCII_CHARS_PER_TOKEN);
}
