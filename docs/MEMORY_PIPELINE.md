# Source review and use assessment

This local pipeline connects retained session-extraction candidates and the personal native Wiki to source-bound review and admission. It is independent of the global autonomy mode. It never changes an original candidate's `automatic_promotion:false`.

## Source intake

Enable one tenant/project explicitly with `orgbrain pipeline configure --json '{"tenant_id":"default","project_id":"PROJECT","enabled":true}'`.

Successful native Wiki MCP `put`, `patch`, `approve`, and `restore_revision` calls read back the exact returned page/hash and enqueue using its stored project scope, even when the caller omits `project_id`. Missing scope, conflicting supplied scope, or a changed hash holds intake with a safe reason. A newly queued row immediately wakes a detached bounded worker; duplicate or disabled intake does not wake it. The MCP response separates `memory_intake.queued` from `memory_intake.worker.started`, and worker unavailability preserves the queue receipt. Authorized environment fallbacks are loaded lazily when the worker key is absent. Starting a worker is not proof of admission; inspect pipeline status for the final result. Each completed session extraction job enqueues its immutable packet ID, including when its earlier candidate draft was empty or held. The separate packet entry point re-extracts from all original spans and events, and never treats a rejected old candidate body as evidence. A technical candidate must cite a tool-result span. Stop and session workers also wake the bounded review worker. `pipeline run` processes up to three pending rows and continues only while work remains; transport or budget failures stop progress and retain a held receipt. Held or uncertain calls are not automatically retried.

Session intake reloads the completed extraction job, packet hash, candidate and support spans. Retained packet authorship remains unverified. Decision candidates cannot be turned into human permission, policy or preference by this path. Sensitive sessions excluded by the extraction policy remain excluded.

Wiki intake requires the exact current page hash, revision and immutable `source:UUID@VERSION` references. Selected source bytes are bounded and digest checked. Source provenance is not proof of historical execution.

## Admission

The extractor proposes at most one bounded technical fact/procedure or pitfall, or abstains. Before any model request, the existing sensitive-text screen checks the selected source and candidate. A changed/redacted source is held rather than silently reviewed as different evidence. Unverified constraints and session decisions are not admitted as policy.

Three actual review calls check evidence entailment, atomicity/durability, and future reuse/overgeneralization. All three verdicts must pass, with at least two actual model families. Confidence must be a finite number from zero to one; it is retained as diagnostic metadata, not treated as a calibrated probability or an admission threshold. This replaces the former 0.98 gate, which rejected actual unanimously approved candidates without measured evidence that the score predicted future usefulness. Models are pinned to Google Vertex global, with no fallback, zero data retention and denied data collection. Per-call output is capped at 1,200 tokens. All calls share the session-extraction monthly 500,000-token ledger. Missing usage retains the full reservation; reported zero remains zero.

The exact model map, prompts, schemas, route/privacy controls, thresholds and limits form a versioned policy descriptor/hash, bound to run identity and review receipt. Old rejected runs remain unchanged when the policy changes. The service verifies canonical input/response hashes, rechecks the source immediately before admission, and writes the active memory and admission receipt in the same SQLite transaction. The existing store creates retrieval projections. Source-reviewed records retain `verification_scope=source_grounding_and_review` and `historical_execution_verified=false`; compact and candidate views expose this distinction. A response hash detects mutation; it is not independent authentication by the provider.

Inspect `orgbrain pipeline status --json '{"tenant_id":"default","project_id":"PROJECT"}'`. Runs distinguish extracting, reviewing, active, abstained, rejected and held; they retain exact source/candidate/review receipts.

## Retrieval and repeated sources

After a new admission, the CLI indexes only that memory through the database's configured local dense provider. A positive indexed count, provider and dimensions are required for `dense_projection.state=indexed`. A missing provider, failed request or zero units leaves the memory active with an explicit pending reason; it is still available to lexical retrieval. No model download or remote embedding fallback is introduced. Existing records can be indexed with `orgbrain index rebuild-dense --tenant-id default --project-id PROJECT` after a WAL-aware backup. Query embedding alone does not prove that any matching memory vectors exist.

An unchanged source and admission policy reuse the prior result without constructing an extraction/review client, reserving additional tokens, or rebuilding embeddings. This path also works without a model API key. Intake identity includes the policy, so an explicit intake after a meaningful policy change does not overwrite an old held receipt. Repeated processing time is a component metric; it does not by itself establish net savings across extraction, implementation, failed runs and later agent tasks.

## Use assessment

Search delivery, actual use, content quality and causal benefit are separate measurements. A real use observation names the exact usage event/item/version and a native current-turn action call ID. The transcript collector verifies delivery and ordering. It accepts native `text` and `input_text` output blocks, including pretty-printed JSON inside the actual output envelope; quoted calls or nested diagnostic data are not receipts.

`orgbrain usage collect --json JSON` (or JSON on standard input) collects a specified native transcript/turn before Stop when needed. After verifying a real action context, it automatically appends an exact-scope `used` assessment through the same live-source/version checks as `usage assess`. Repeated collection is idempotent. An existing explicit `not_used` is preserved as a conflict requiring review. Assessment failures stay separate from recorded contexts and appear in `assessment_gaps`; they never create a positive effect. `usage assess` accepts the exact usage scope plus `state` and `reason_code`. `used` requires a live verified action context. Explicit `not_used` requires confirmed delivery, a concrete non-use reason, and no conflicting verified use. `unknown` preserves its reason. Corrections append a `supersedes_id`; they do not overwrite history. Revoked or stale use evidence is removed from the live report.

`usage assessments` reads the current per-item assessments. `usage report` separates stored inventory, delivered references, action observations, reported adoption, unassessed reasons and verified positive effects. An action observation alone never creates a usefulness rating or proves time/cost savings.
