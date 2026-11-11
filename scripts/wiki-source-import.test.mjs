import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { extractWikiHtml, importWikiSource } from "../packages/orgbrain-cli/src/lib/wiki-source-import.mjs";

test("Wiki HTML import drops executable and navigation text", () => {
  assert.equal(extractWikiHtml("<title>資料</title><nav>メニュー</nav><main><h1>資料</h1><p>公開情報</p><script>secret</script></main>"), "資料\n公開情報");
});

test("Wiki PDF import retains the original bytes and stores the extracted page", {
  skip: spawnSync("pdftotext", ["-v"]).status !== 0,
}, async () => {
  const stream = "BT /F1 12 Tf 10 60 Td (Page citation example) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const base64 = Buffer.from(pdf).toString("base64");
  const service = { request: async (input, epoch) => ({ input, epoch }) };
  const { input, epoch } = await importWikiSource(service, { kind:"pdf", name:"example.pdf", base64 }, 42);
  assert.equal(epoch, 42);
  assert.equal(input.base64, base64);
  assert.equal(input.page_count, 1);
  assert.equal(input.extracted_text, "# Page 1\n\nPage citation example");
});

test("Wiki source imports never write on invalid PDF or unsafe URL", async () => {
  const calls = [];
  const service = { config: "unused", request: async input => { calls.push(input); } };
  await assert.rejects(importWikiSource(service, { kind:"pdf", name:"bad.pdf", base64:Buffer.from("not pdf").toString("base64") }, 1), /invalid_pdf/);
  for (const url of ["http://example.com", "https://127.0.0.1", "https://169.254.169.254", "https://user:pass@example.com"]) {
    await assert.rejects(importWikiSource(service, { kind:"url", url }, 1), /public_https_required/);
  }
  assert.deepEqual(calls, []);
});
