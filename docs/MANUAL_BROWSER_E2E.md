# Manual browser E2E

`Browser E2E (manual)` (`.github/workflows/browser-e2e.yml`) runs only through
`workflow_dispatch`. Pushes, pull requests and schedules do not launch it.
The former `console-e2e` job has been removed from `ci.yml`; unit/type/build,
API integration and benchmark jobs retain their existing triggers.

After this workflow is merged to the default branch, open **Actions → Browser
E2E (manual) → Run workflow**, select the branch and scope:

- `smoke` (default): `login-and-memory.spec.ts`
- `default`: the existing default console suite (excludes decision-console-v2)
- `decision`: the existing decision-console-v2 suite with beta decision mode

Or run `gh workflow run browser-e2e.yml --ref <branch> -f suite=smoke`.
Running the ordinary CI workflow manually no longer runs browser tests.
If branch protection requires the old `console-e2e` check, a repository admin
must remove that obsolete required check before merging; this change does not
edit repository settings.

This is Chromium-only against Astro and the existing local mock API. It does
not validate production authentication, Cloudflare, or the real database API.
No deployment or production secrets are needed. One worker, no retries, a
three-failure stop, a 10-minute test-step timeout and 15-minute job timeout limit
usage. A newer manual run on the same ref cancels the previous run, even if its
scope differs. Different refs can run independently. Failures upload the HTML
report, retained traces/screenshots/video for three days; successful runs do
not upload artifacts. The full default scope may exceed the cap; use a narrower
scope to investigate rather than increasing recurring CI cost.

Local equivalents (after `pnpm install --frozen-lockfile` and
`pnpm --filter @org-brain/console exec playwright install --with-deps chromium`):

```sh
pnpm --filter @org-brain/console test:e2e e2e/login-and-memory.spec.ts --workers=1 --retries=0 --trace=retain-on-failure
pnpm --filter @org-brain/console test:e2e:decision --workers=1 --retries=0 --trace=retain-on-failure
```

Configuration follows [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
and [Playwright CI setup](https://playwright.dev/docs/ci).
