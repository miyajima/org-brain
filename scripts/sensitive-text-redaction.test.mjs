import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { redactHookMemoryText } from "../packages/orgbrain-cli/src/hook-memory-bridge.mjs";
import { containsRedactedSensitiveToken, redactLocalPaths, redactSensitiveText } from "../packages/orgbrain-cli/src/lib/sensitive-text-redaction.mjs";

const SECRET_SAMPLES = {
  "api_key assignment": ["api_key=supersecretvalue123", "supersecretvalue123"],
  "short token assignment (shared chain)": ["token=abc", "abc"],
  "short quoted colon token": ['token: "abc"', "abc"],
  "long token colon": ["token: abcdefgh1234", "abcdefgh1234"],
  "quoted JSON-style password": ['"password": "hunter2hunter2"', "hunter2hunter2"],
  "client secret": ["client_secret = s3cr3t-value-xyz", "s3cr3t-value-xyz"],
  "assignment with embedded single quote": ["password=pa'ss12345", "ss12345"],
  "assignment with embedded double quote": ['password=abc"def', 'def'],
  "assignment with escaped quotes": ['password=\\"hunter22\\"', "hunter22"],
  "JSON-encoded escaped-quote value": ['{\\"password\\": \\"hunter22\\"}', "hunter22"],
  "passwd": ["passwd:longpassword99", "longpassword99"],
  "Bearer token": ["Authorization: Bearer abc.def-123_xyz==", "abc.def-123_xyz"],
  "sk key": ["use sk-abcdefghijklmnopqrstuv now", "sk-abcdefghijklmnopqrstuv"],
  "sk-proj key": ["sk-proj-abcdefghijklmnopqrstuv", "abcdefghijklmnopqrstuv"],
  "github PAT": ["ghp_abcdefghijklmnopqrstuvwx", "ghp_abcdefghijklmnopqrstuvwx"],
  "github_pat": ["github_pat_abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstuvwx"],
  "slack token": ["xoxb-abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstuvwx"],
  "private key block": ["-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----", "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu"]
};

for (const [name, [input, leaked]] of Object.entries(SECRET_SAMPLES)) {
  test(`every redaction entry point masks ${name}`, () => {
    for (const out of [
      redactSensitiveText(input),
      redactSensitiveText(input, { phoneNumbers: "filtered" }),
      redactSensitiveText(input, { phoneNumbers: false }),
      redactHookMemoryText(input)
    ]) {
      assert.ok(!out.includes(leaked), `${name} leaked: ${out}`);
      assert.match(out, /\[REDACTED_SECRET\]/u);
    }
  });
}

test("emails are masked everywhere", () => {
  assert.equal(redactSensitiveText("a user@example.com b"), "a [REDACTED_EMAIL] b");
  assert.equal(redactHookMemoryText("a user@example.com b"), "a [REDACTED_EMAIL] b");
});

test("local paths keep repo context but drop the user name", () => {
  const home = os.homedir();
  assert.equal(redactLocalPaths("see /Users/alice/projects/x/file.mjs:3"), "see ~/projects/x/file.mjs:3");
  assert.equal(redactLocalPaths("see /home/bob/work/a"), "see ~/work/a");
  assert.equal(redactLocalPaths("C:\\Users\\Carol\\code\\a"), "~\\code\\a");
  assert.equal(redactLocalPaths(`open ${home}/projects/x`), "open ~/projects/x");
  assert.equal(redactLocalPaths("/Users/alice"), "~");
  assert.equal(redactLocalPaths("/private/var/folders/ab/cd1234/T/run-1/out.txt"), "<tmp>/run-1/out.txt");
  assert.equal(redactLocalPaths("/var/folders/ab/cd1234/T/run-1"), "<tmp>/run-1");
  assert.equal(redactLocalPaths("/tmp/run/out"), "/tmp/run/out");
  assert.equal(redactLocalPaths("packages/orgbrain-cli/src/a.mjs"), "packages/orgbrain-cli/src/a.mjs");
  assert.equal(redactLocalPaths("/Users/alice/projects/x", { homeDir: "/nowhere" }), "~/projects/x");
});

test("every text redaction entry point masks local paths", () => {
  const home = os.homedir();
  for (const redact of [redactSensitiveText, redactHookMemoryText]) {
    assert.equal(redact("edit /Users/alice/projects/x now"), "edit ~/projects/x now");
    assert.equal(redact(`edit ${home}/projects/x now`), "edit ~/projects/x now");
    assert.equal(redact("tmp /private/var/folders/ab/cd/T/z"), "tmp <tmp>/z");
  }
});

test("phone filter is explicit: only the filtered mode keeps dates and short numbers", () => {
  const date = "released 2026-11-12 build 20261112 x";
  assert.equal(redactSensitiveText("call +81 90 1234 5678", { phoneNumbers: "filtered" }), "call [REDACTED_PHONE]");
  assert.equal(redactSensitiveText("call +81 90 1234 5678"), "call [REDACTED_PHONE]");
  assert.equal(redactSensitiveText("n 1234567890123456789", { phoneNumbers: "filtered" }), "n 1234567890123456789");
  assert.equal(redactSensitiveText("n 1234567890123456789"), "n [REDACTED_PHONE]");
  assert.equal(redactSensitiveText(date, { phoneNumbers: "filtered" }), date);
  assert.equal(redactSensitiveText("n 12345678", { phoneNumbers: false }), "n 12345678");
  assert.equal(redactHookMemoryText(date), date);
});

test("home directory replacement respects boundaries and URLs are untouched", () => {
  assert.equal(redactLocalPaths("example.com/root/x", { homeDir: "/root" }), "example.com/root/x");
  assert.equal(redactLocalPaths("open /root/x and /root", { homeDir: "/root" }), "open ~/x and ~");
  assert.equal(redactLocalPaths("see /rootfs/x", { homeDir: "/root" }), "see /rootfs/x");
  assert.equal(redactLocalPaths("GET /home/index", { homeDir: "/nowhere" }), "GET /home/index");
  assert.equal(redactLocalPaths("/home/bob/work", { homeDir: "/nowhere" }), "~/work");
  assert.equal(redactLocalPaths("cd /home/bob", { homeDir: "/home/bob" }), "cd ~");
  for (const url of ["https://example.com/Users/alice/x", "https://example.com/home/alice/x"]) {
    assert.equal(redactLocalPaths(url, { homeDir: "/nowhere" }), url);
    assert.equal(redactSensitiveText(url, { homeDir: "/nowhere" }), url);
  }
});

test("key/value rule: assignment and quoted redact any value, bare colon needs 8+ chars", () => {
  for (const kept of ["token: string", "password: abc", "token: bool"]) {
    assert.equal(redactSensitiveText(kept), kept);
  }
  assert.equal(redactSensitiveText("token: abcdefgh1234"), "[REDACTED_SECRET]");
  assert.equal(redactSensitiveText("token=a"), "[REDACTED_SECRET]");
  assert.match(redactSensitiveText('{"password": "x"}'), /\[REDACTED_SECRET\]/u);
  assert.ok(!redactSensitiveText('{"password": "x"}').includes('"x"'));
});

test("nothing the legacy hook or shared patterns masked is now left unmasked", () => {
  const legacy = [
    ["PEM", "-----BEGIN PRIVATE KEY-----\nabcdef\n-----END PRIVATE KEY-----", "abcdef"],
    ["sk", "sk-abcdefghijklmnopqrstuv", "abcdefghijklmnop"],
    ["sk-proj", "sk-proj-abcdefghijklmnopqrst", "abcdefghijklmnop"],
    ["ghp", "ghp_abcdefghijklmnopqrstuv", "abcdefghijklmnop"],
    ["github_pat", "github_pat_abcdefghijklmnopqrst", "abcdefghijklmnop"],
    ["xoxb", "xoxb-abcdefghijklmnopqrstuv", "abcdefghijklmnop"],
    ["Bearer", "Bearer abc.def_123-xyz", "abc.def_123"],
    ["api_key =", "api_key = abcdefgh12", "abcdefgh12"],
    ["api-key :", "api-key: abcdefgh12", "abcdefgh12"],
    ["apikey short =", "apikey=abc", "abc"],
    ["client_secret", "client_secret: s3cr3tvalue", "s3cr3tvalue"],
    ["client-secret =", "client-secret=zz", "zz"],
    ["password quoted", "password: 'hunter2hunter2'", "hunter2hunter2"],
    ["password short quoted", 'password: "hi"', "hi"],
    ["passwd", "passwd=pw", "pw"],
    ["token", "TOKEN : abcdefghij", "abcdefghij"],
    ["token short =", "token=abc", "abc"]
  ];
  for (const [name, input, leaked] of legacy) {
    for (const out of [redactSensitiveText(input), redactHookMemoryText(input)]) {
      assert.ok(!out.includes(leaked), `${name} leaked: ${out}`);
    }
    assert.match(redactSensitiveText(input), /\[REDACTED_SECRET\]/u, name);
  }
});

test("containsRedactedSensitiveToken detects only redaction tokens", () => {
  assert.equal(containsRedactedSensitiveToken("a [REDACTED_SECRET] b"), true);
  assert.equal(containsRedactedSensitiveToken("[REDACTED_EMAIL]"), true);
  assert.equal(containsRedactedSensitiveToken("[REDACTED_PHONE]"), true);
  assert.equal(containsRedactedSensitiveToken("~/.config/x"), false);
  assert.equal(containsRedactedSensitiveToken(undefined), false);
});
