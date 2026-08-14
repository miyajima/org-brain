-- Deterministic projection of the reviewed aggregate observations used by the
-- portable report. Primary evidence and digests are listed in source-notes.md.

SELECT 3 AS successes, 3 AS total, 1.0 AS point_estimate,
       0.4385029682449545 AS wilson_lower, 0 AS reask_count,
       0.5614970317550455 AS reask_wilson_upper;

SELECT 0 AS required_categories_met, 9 AS required_categories,
       0.0 AS minimum_coverage, 39 AS pending_annotations,
       3 AS split_violations;

SELECT 'Verified Knowledge Correctness' AS metric,
       'verified active 0/46' AS observed,
       'FAIL / insufficient' AS status
UNION ALL SELECT 'Durable Knowledge Coverage', 'v2 labeled corpus 0件', 'FAIL / insufficient'
UNION ALL SELECT 'Decision Continuity', '3/3、Wilson下限43.85%、再質問上限56.15%', 'FAIL (fixtureはPASS)'
UNION ALL SELECT 'Decision Utility', 'next-task 0/300', 'FAIL / insufficient'
UNION ALL SELECT 'Evidence & Rationale', 'evidence 19.57%、rationale 2.17%、reuse 0%', 'FAIL'
UNION ALL SELECT 'Retrieval Reproducibility', 'v2 locked retrieval 0/300', 'FAIL / insufficient'
UNION ALL SELECT 'Freshness & Validity', '期限内100%、verified 0%', 'FAIL'
UNION ALL SELECT 'Duplicate & Conflict Control', 'canonical duplicate 0 group', 'PARTIAL / insufficient'
UNION ALL SELECT 'Coverage Utility', 'v2 labeled opportunity 0件', 'FAIL / insufficient'
UNION ALL SELECT 'Structure & Metadata', 'category/work type 97.83%、hash 100%、verified 0%', 'FAIL';

SELECT 'success' AS category, 0 AS actual, 75 AS minimum, 'FAIL' AS status
UNION ALL SELECT 'decision', 0, 75, 'FAIL'
UNION ALL SELECT 'failure', 0, 75, 'FAIL'
UNION ALL SELECT 'non-durable turn', 0, 200, 'FAIL'
UNION ALL SELECT 'next-task retrieval', 0, 300, 'FAIL'
UNION ALL SELECT 'continuity: same key', 0, 75, 'FAIL'
UNION ALL SELECT 'continuity: paraphrase', 0, 75, 'FAIL'
UNION ALL SELECT 'continuity: compaction/resume', 0, 75, 'FAIL'
UNION ALL SELECT 'continuity: change/conflict/scope', 0, 75, 'FAIL';

SELECT 'unsupported active record' AS guardrail,
       '46 activeがunverified' AS observed,
       'NOT EVALUATED / BLOCK' AS status
UNION ALL SELECT 'credential / PII leak', 'active候補0件、rotation-required 2件', 'ACTIVE PASS / remediation required'
UNION ALL SELECT 'cross-tenant / cross-scope injection', 'fixtureでscope分離PASS', 'CORPUS INSUFFICIENT'
UNION ALL SELECT 'stale / superseded application', 'supersede fixture PASS', 'CORPUS INSUFFICIENT'
UNION ALL SELECT 'final answer self-attestation', '母集団測定なし', 'NOT EVALUATED'
UNION ALL SELECT 'canonical duplicate', 'active duplicate group 0', 'PASS'
UNION ALL SELECT 'contract hash mismatch', 'contract tests 6/6 PASS', 'PASS'
UNION ALL SELECT 'same decision key reask', 'fixture 0/3、Wilson上限56.15%', 'FUNCTIONAL PASS / STATISTICAL FAIL';
