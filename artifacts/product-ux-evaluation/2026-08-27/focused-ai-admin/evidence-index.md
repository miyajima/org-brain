# Evidence index

| ID | Evidence | Mode | What it supports | Limitation |
| --- | --- | --- | --- | --- |
| E-AI-SCENARIOS | `ai-local.json` | automated | Relevant retrieval, evidence status, abstention, bounded candidates, repeat consistency in fresh synthetic Local | It does not contain a rendered native-client answer |
| E-DOMAIN-CONTRACT | `domain-recall-current.json` and `scripts/domain-recall-scorecard.mjs` | automated | Generated answer-context contract: decision/reason, scope, evidence, trace, correction, safety and 6 KiB budget | It is generated context, not a live LLM answer or native-client rendering |
| E-BROWSER-DESKTOP | `screenshots/02` through `09` | interactive-local/rendered | Current Japanese admin pages at 1440x900 and their visible hierarchy, copy, density and risk states | Screenshots do not prove keyboard or screen-reader behavior |
| E-BROWSER-MOBILE | `screenshots/10-users-mobile.png`, `11-memories-mobile.png`, `metrics.json` | interactive-local | Current 390x844 reflow and no page-level horizontal overflow | Only two representative routes were directly measured |
| E-DOM-ACCESSIBILITY | `metrics.json` | interactive-local | `lang=ja`, visible control names, heading snapshot, skip-link target and measured target sizes | No VoiceOver; contrast was not independently measured |
| E-UNIT-SCORECARD | `command-results.json` | automated | Nine focused Node tests passed | Unit tests do not replace rendered interaction |
| E-E2E-MOCK-PROXY | `test-results.md`, `command-results.json` | automated/inconclusive | Reflow and focus checks that completed; records mock-proxy failure boundary | Axe, identity mutation and memory-quality results are indeterminate because a Vite error overlay appeared |
| E-FIXTURE-MANIFEST | `fixture-manifest-local.json` | recorded local operation | Fixture inventory and archive outcomes | No independent post-cleanup database readback; the manifest records the operations' outcomes |

The focused diagnostic score is not the repository's official 14-axis scorecard. Per-item raw score, evidence cap, finding cap, final score and evidence IDs are in `measurement-input-focused.json` so the diagnostic can be audited without implying full-run coverage.
