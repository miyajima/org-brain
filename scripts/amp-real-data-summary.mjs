// Rescore immutable receipts; never performs retrieval or modifies the live Wiki.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scoreResult } from './amp-real-data-evaluation.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const auditPath = 'docs/agent-memory-protocol/evaluation-20261109-audit.json';
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export async function auditedCases(definition) {
  const cases = structuredClone(definition.cases);
  const audit = JSON.parse(await readFile(auditPath));
  for (const change of audit.changes) {
    const atom = cases.find(c => c.id === change.case_id)?.atoms.find(a => a.id === change.atom_id);
    if (!atom) throw Error('unknown_audit_atom');
    atom.patterns.push(...change.add_patterns);
  }
  return cases;
}

export function aggregate(rows, qualifierTotal) {
  const valid = rows.filter(r => !r.error), withClaim = valid.filter(r => r.score.any_claim);
  const sum = (items, key) => items.reduce((n, r) => n + r.score[key], 0);
  return { questions: rows.length, errors: rows.length - valid.length,
    with_claim: withClaim.length, complete: valid.filter(r => r.score.complete).length,
    qualifiers_found: sum(valid, 'qualifier_found'), qualifiers_total: qualifierTotal,
    qualifiers_missing: qualifierTotal - sum(valid, 'qualifier_found'),
    conditional_qualifiers_found: sum(withClaim, 'qualifier_found'), conditional_qualifiers_total: sum(withClaim, 'qualifier_total'),
    returned_units: sum(valid, 'returned_units'), relevant_units: sum(valid, 'relevant_units'),
    mean_input_tokens: mean(rows.map(r => r.input_tokens)),
    mean_valid_output_tokens: mean(valid.map(r => r.output_tokens)),
    mean_all_attempt_output_tokens: mean(rows.map(r => r.output_tokens)),
  };
}

export async function summarize(root, destination) {
  const receiptBytes = await readFile(join(root, 'results.json'));
  const receipt = JSON.parse(receiptBytes);
  const caseBytes = await readFile(join(root, 'frozen-cases.json'));
  if (sha(caseBytes) !== receipt.cases_sha256) throw Error('frozen_cases_changed');
  const cases = await auditedCases(JSON.parse(caseBytes)), rows = [], responseHashes = {};
  for (const original of receipt.rows) {
    const name = `${original.case_id}-${original.form}-${original.budget}-${original.method}.json`;
    const bytes = await readFile(join(root, 'responses', name));
    responseHashes[name] = sha(bytes);
    const response = JSON.parse(bytes);
    if (JSON.stringify(response.row) !== JSON.stringify(original)) throw Error('receipt_row_mismatch');
    rows.push({ ...original, original_score: original.score,
      score: original.error ? null : scoreResult(response.result, cases.find(c => c.id === original.case_id)) });
  }
  const qualifierTotal = cases.flatMap(c => c.atoms).filter(a => a.type === 'qualifier').length;
  const aggregates = [], groups = [];
  for (const form of ['keywords', 'natural']) for (const budget of [1200, 4000]) for (const method of ['legacy', 'legacy_augmented', 'amp']) {
    const selected = rows.filter(r => r.form === form && r.budget === budget && r.method === method);
    aggregates.push({ form, budget, method, ...aggregate(selected, qualifierTotal) });
    if (form === 'keywords' && budget === 4000) for (const group of ['represented', 'exception', 'unrepresented']) {
      const total = cases.filter(c => c.group === group).flatMap(c => c.atoms).filter(a => a.type === 'qualifier').length;
      groups.push({ method, group, ...aggregate(selected.filter(r => r.group === group), total) });
    }
  }
  const matched = cases.map(c => c.id).filter(id => rows.filter(r => r.form === 'keywords' && r.budget === 4000 && r.case_id === id).every(r => r.score?.complete));
  const matchedTokens = Object.fromEntries(['legacy', 'legacy_augmented', 'amp'].map(method => [method,
    mean(rows.filter(r => r.form === 'keywords' && r.budget === 4000 && r.method === method && matched.includes(r.case_id)).map(r => r.output_tokens))]));
  const changed = rows.filter(r => JSON.stringify(r.original_score) !== JSON.stringify(r.score)).map(r => ({
    case_id: r.case_id, form: r.form, budget: r.budget, method: r.method, before: r.original_score, after: r.score }));
  const output = { schema: 'amp-real-data-summary/v1', date: '2026-11-09', receipt_sha256: sha(receiptBytes),
    cases_sha256: receipt.cases_sha256, audit_sha256: sha(await readFile(auditPath)),
    snapshot: receipt.snapshot, tokenizer: receipt.tokenizer, inference_model_calls: receipt.inference_model_calls,
    generation_quality_measured: false, aggregates, groups, quality_matched_cases: matched, quality_matched_mean_output_tokens: matchedTokens,
    score_corrections: changed, rows, response_sha256: responseHashes };
  await writeFile(destination, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ aggregates, groups, matched, matchedTokens, corrected_rows: changed.length }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await summarize(process.argv[2], process.argv[3]);
