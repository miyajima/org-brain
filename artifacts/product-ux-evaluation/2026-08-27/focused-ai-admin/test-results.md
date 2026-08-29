# Test results

## Passed

- `node scripts/ai-evidence-audit.mjs`: 11/11 applicable scenarios matched expectations in three repeated runs; `auth_failure` was N/A because Local has no authentication boundary.
- `pnpm score:domain-recall`: four domain packs scored 100; the generated answer-context contract scored 97 for each pack; critical failures 0. This does not render a native AI-client answer.
- `node --test scripts/ai-evidence-audit.test.mjs scripts/product-ux-scorecard.test.mjs scripts/domain-recall-scorecard.test.mjs`: 9 tests passed.
- In-app Browser inspection at 1440x900 and 390x844: users and memories had no page-level horizontal overflow.
- DOM inspection: visible controls on users and memory quality pages had accessible names; `html[lang=ja]`, the skip link, and `main#console-main` were present.
- Focused Playwright attempts: 390x844 reflow, 400% equivalent reflow, and forced-colors focus-indicator tests passed.

## Inconclusive or blocked

- Playwright accessibility, identity-administration, and memory-quality tests could not be treated as product results. The mock-proxy path repeatedly reported `Network connection lost`, after which a Vite error overlay appeared. The first attempt completed 26/64 tests; the single-worker focused retry completed 3/10. These runs do not establish whether the underlying product screens pass or fail.
- Manual VoiceOver was not performed.
- English and Chinese structural parity was not successfully verified in this run.
- Cloudflare live parity was not run.
- Native AI client rendering and live-model A/B were not run.

## Interpretation

The direct fresh-local browser session was healthy and supplied the visual and interactive evidence used for the UX findings. The mock-proxy E2E failure is recorded as indeterminate and is not converted into a false accessibility failure or pass.
