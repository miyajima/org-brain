import os from "node:os";

// The single local redaction policy for CLI and hook text. Callers normalize
// and truncate first; this only applies the masks.
//
// Secrets/emails/phones -> [REDACTED_SECRET] / Bearer [REDACTED_SECRET] /
// [REDACTED_EMAIL] / [REDACTED_PHONE].
// Local paths keep their repo-relative context but lose the user-identifying
// part: /Users/<name>/x, /home/<name>/x, C:\Users\<name>\x and the real home
// directory -> ~/x ; macOS temp roots -> <tmp>/x ; /tmp and relative paths stay.
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu,
  /\b(?:sk|sk-proj|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/gu
];
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
// key=value and quoted values redact any non-empty value; a bare `key: value`
// (YAML/prose, e.g. "token: string") needs 8+ non-space chars to count as a secret.
// Unquoted assignments consume everything up to whitespace/comma/semicolon (quotes included), and JSON-encoded
// text may wrap keys and values in escaped quotes (\").
const KEY_VALUE_PATTERN = /\b(?:api[_-]?key|client[_-]?secret|password|passwd|token)(?:\\?["']?\s*=\s*\\?["']?[^\s,;]+|\\?["']?\s*:\s*(?:\\?["'][^\s"',;]+|[^\s,;]{8,}))/giu;
const REDACTED_TOKEN_PATTERN = /\[REDACTED_(?:SECRET|EMAIL|PHONE)\]/u;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE_PATTERN = /(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/gu;

const TEMP_ROOT_PATTERN = /(?<![\w.~-])(?:\/private)?\/var\/folders\/[^/\s]+\/[^/\s]+\/[A-Za-z0-9]+(?=[/\s`'"),:]|$)/gu;
// /home/<name> counts only as /home/<name>/... (or the configured homeDir), so
// routes like "GET /home/index" survive.
const POSIX_HOME_PATTERN = /(?<![\w.~-])\/(?:Users\/[^/\s`'"),:]+(?=[/\s`'"),:]|$)|home\/[^/\s`'"),:]+(?=\/))/gu;
const WINDOWS_HOME_PATTERN = /(?<![\w])[A-Za-z]:\\Users\\[^\\\s`'"),:]+/gu;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function redactLocalPaths(value, { homeDir = os.homedir() } = {}) {
  let text = String(value ?? "");
  if (typeof homeDir === "string" && homeDir.length > 1) {
    text = text.replace(new RegExp(`(?<![\\w.~-])${escapeRegExp(homeDir.replace(/[\\/]+$/u, ""))}(?=[\\\\/\\s\`'"),:]|$)`, "gu"), "~");
  }
  return text
    .replace(TEMP_ROOT_PATTERN, "<tmp>")
    .replace(POSIX_HOME_PATTERN, "~")
    .replace(WINDOWS_HOME_PATTERN, "~");
}

export function containsRedactedSensitiveToken(value) {
  return REDACTED_TOKEN_PATTERN.test(String(value ?? ""));
}

function redactPhoneNumbers(text, mode) {
  if (!mode) return text;
  if (mode !== "filtered") return text.replace(PHONE_PATTERN, "[REDACTED_PHONE]");
  return text.replace(PHONE_PATTERN, (candidate) => {
    const digits = candidate.replace(/\D/gu, "");
    if (digits.length < 10 || digits.length > 15 || !/[+() -]/u.test(candidate)) return candidate;
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/u.test(candidate)) return candidate;
    return "[REDACTED_PHONE]";
  });
}

/**
 * options.phoneNumbers: "all" (default) masks every 9+ digit run; "filtered"
 * only masks 10-15 digit numbers with separators and spares ISO dates; false
 * disables phone masking. options.homeDir overrides os.homedir().
 */
export function redactSensitiveText(value, options = {}) {
  const { phoneNumbers = "all", homeDir } = options;
  let text = redactLocalPaths(value, homeDir === undefined ? undefined : { homeDir });
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED_SECRET]");
  text = text
    .replace(BEARER_PATTERN, "Bearer [REDACTED_SECRET]")
    .replace(KEY_VALUE_PATTERN, "[REDACTED_SECRET]")
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
  return redactPhoneNumbers(text, phoneNumbers);
}
