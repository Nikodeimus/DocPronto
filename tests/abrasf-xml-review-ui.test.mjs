import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/docpronto/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");

test("oferece uma ferramenta exclusiva para conferir XML ABRASF", () => {
  assert.match(app, /id:\s*"xml-abrasf-review"[\s\S]+number:\s*"21"[\s\S]+accept:\s*"\.xml"/);
  assert.match(app, /action:\s*reviewAbrasfXmlForDominio/);
  assert.match(html, /<dialog id="abrasfXmlReviewDialog"[^>]+aria-modal="true"/);
  assert.match(html, /id="abrasfXmlReviewConfirm"/);
});

test("a conferência preserva o XML e bloqueia uma nota já salva", () => {
  assert.match(app, /function readAbrasfReviewHistory\(/);
  assert.match(app, /function rememberAbrasfInvoice\(/);
  assert.match(app, /function reviewAbrasfXmlForDominio\(/);
  assert.match(app, /Esta NFS-e já foi salva/);
  assert.match(app, /const invoices = parseAbrasfXmlDocuments\(text\)/);
  assert.match(app, /for \(const \[index, invoice\] of invoices\.entries\(\)\)/);
  assert.doesNotMatch(app, /entries\.slice\(0, 500\)/);
  assert.match(html, /id="abrasfXmlReviewDialog"[^>]+aria-describedby="abrasfXmlReviewIssues"/);
});
