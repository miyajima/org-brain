# Cloud memory test inventory

The initial Node result of 698 passes counted component invocations separately.
The deduplicated run counted each test file once. No old suite disappeared:

| Repeated file | Cases counted an extra time |
| --- | ---: |
| scripts/autonomy-policy.test.mjs | 8 |
| scripts/memory-extraction-router-calibrate.test.mjs | 3 |
| scripts/memory-extraction-runtime-evaluate.test.mjs | 5 |
| scripts/turn-evidence-v1.test.mjs | 34 |
| Total | 50 |

`698 - 50 = 648` old unique passes. The additional public review-lifecycle file
contributes six cases and the typed local-queue guard one: `648 + 6 + 1 = 655`.
The old 100 file-invocations represent 96 unique files. The final inventory is
97 unique files: all 96 default root Node files plus the review-lifecycle file.
The four repeated files were re-run individually and their counts verified.

## Coverage and skips

| Group | Executed scope |
| --- | --- |
| Default root Node tests | All files named by Node component scripts in root `pnpm test`, deduplicated; component commands, not a one-shot `pnpm test` run |
| Additional Node selection | Public memory-review-lifecycle file, six cases |
| Combined Node result | 655 pass, 2 skip; concurrency 1 |
| Packaged CLI selection | 35 conversation/remote/confirmation cases using the exact standalone commit |
| Packaged hook follow-up | 11 pass, 1 skip in hook-failure-context; ten overlap the source run and one previously skipped packaged subprocess is enabled |
| Workspace Vitest | Existing package test scripts; API performance tests and console E2E are excluded by their existing scripts |
| Root script Vitest | Selected 13-file script suite, 141 cases |
| Console Playwright | Selected six login/memory/review cases, not the full browser suite |
| Native Worker | Explicit synthetic lifecycle/scope/context REST smoke on isolated local D1; authenticated MCP still unavailable |

The two skips in the full Node run are:

- Packaged hook subprocess: `ORGBRAIN_TEST_BUNDLE` was absent. Follow-up supplied
  the actual built standalone file and this test passed.
- Configured Astra context wrapper: the actual configured `context_hook.py` and
  `ORGBRAIN_TEST_CONTEXT_WRAPPER` are unavailable. It remains skipped. No substitute
  wrapper was created and live host delivery is not claimed.

Optional suites outside the default root test contract were not run: Wiki engine
(Rust and eight Node files), Wiki UI, domain packs, local Qwen/provider integration,
API performance suites and the full browser suite. Local provider and paid model
calls were not introduced. Selecting component tests does not establish universal
repository coverage, unseen-corpus recall or real task token savings.

The publication follow-up adds one original-request history-resume regression and
16 read-template/unsafe-command cases to the API suite. Final results are retained
in the code-only handoff's validation metadata. Protocol load tests retain their
recorded failures; successful serial runs do not erase the overloaded probe deadline.
