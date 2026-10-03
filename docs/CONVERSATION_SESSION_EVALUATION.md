# Private conversation-session evaluation

`scripts/conversation-session-evaluate.mjs` is a bounded, offline two-phase
harness for a parent runtime that already has an explicit query, scoped memory
IDs, and later an actual action/result report. It does not discover sessions,
read transcript directories, import conversations, ask for confirmation, execute
actions, or contact a provider. Use Node 24+ and the repository dependencies.

Import/review/save happens separately through the conversation importer and the
existing `orgbrain_memories_propose` / `orgbrain_memories_confirm` flow. A staged
candidate or pending confirmation is not an active memory. Only pass memory IDs
returned by an actual save receipt when evaluating saved knowledge.

## Meaning of the stages

| Stage | Evidence and interpretation |
| --- | --- |
| Capture | Optional caller-reported candidate IDs and source hashes; absence is unknown, not zero |
| Saved | The supplied IDs are independently found in the explicit tenant/project with the requested principal's read permission; this establishes store presence, not capture in this session or human approval |
| Retrieved | Real `LocalMemoryStore` plus `handleLocalMcpRequest` invokes `orgbrain_context_enrich` with the exact supplied query, default score threshold, default top-k and token budget |
| Delivered | The selected context and usage item/version IDs were written to the explicitly requested private output file; parent consumption is still unknown |
| Adopted | The caller explicitly reports use/non-use/unknown of an exact delivered usage item and source version; positive adoption requires an action reference/summary and result reference/summary |
| Execution / effect | Supplied action and result remain reported; verified outcome, causal benefit, avoided calls, saved time/tokens, and money savings remain unknown |

This script deliberately never calls `storeLocalUseProof`, the trusted transcript
collector, contribution evaluation, or ranking updates. A `verified` JSON flag
cannot turn a supplied report into observed execution. Existing source-memory
verification metadata describes that source only, not this use or its outcome.

## 1. Retrieve the exact scoped query

Create a private input JSON file. The values below are placeholders, not actual
ExampleApp contact information or a completed evaluation. Replace the scope,
query, and memory ID with the runtime's actual authorized values. Do not append
search hints to the user's query merely to make the test pass.

```json
{
  "schema_version": 1,
  "session_kind": "actual",
  "scope": {
    "tenant_id": "my-tenant",
    "project_id": "ExampleApp",
    "task_id": "explicit-current-task",
    "principal_id": "local"
  },
  "query": "The exact query from the current task",
  "work_type": "implementation",
  "source_memory_ids": ["memory-id-from-the-save-receipt"]
}
```

All four scope IDs are mandatory opaque IDs, not email addresses or paths.
`source_memory_ids` identifies expected saved sources for coverage measurement;
it never becomes a search hint or filters/forces the returned results. The normal
context tool can return other relevant accessible memories. An irrelevant query
must be allowed to abstain.

```sh
node scripts/conversation-session-evaluate.mjs retrieve \
  --db /explicit/private/memory.sqlite \
  --input /explicit/private/retrieve-input.json \
  --output /explicit/private/retrieval-001.json
```

The database must already exist. The output file must not exist; it is created
with mode `0600`. Its parent directory must already exist and should be private.
The command prints a small completion JSON containing the receipt hash and usage
ID, not the retrieved text. The parent must explicitly read the output artifact
to consume its context. Merely generating the artifact does not show that any
parent action used it.

Optional `source_refs` takes at most eight objects with `ref` and a lowercase
64-character `content_sha256`. Optional `capture_report` takes `candidate_ids`
(at most 32) and `source_refs`; nonempty candidate IDs require source references.
These hashes/references are caller reports, not authentication. For example,
reference the separately produced importer plan or human save receipt by its
opaque event ID and file-content hash. The script does not read these references
or infer human acceptance from them.

## 2. Report use after the actual activity

Once the parent has consumed the result and completed an action, create another
private input. Copy `receipt_sha256` from the retrieval report and the exact
`usage_item_id`, `source_id`, and `source_version` from its delivered items. Use
actual, bounded action/result descriptions and stable source references. Never
insert credentials, real telephone numbers, medical information, or unneeded
personal data. A test contact's approved opaque configuration ID is preferable
to its personal contact details.

```json
{
  "schema_version": 1,
  "session_kind": "actual",
  "scope": {
    "tenant_id": "my-tenant",
    "project_id": "ExampleApp",
    "task_id": "explicit-current-task",
    "principal_id": "local"
  },
  "receipt_sha256": "COPY_THE_RETRIEVAL_RECEIPT_SHA256",
  "items": [{
    "usage_item_id": "COPY_THE_DELIVERED_USAGE_ITEM_ID",
    "source_id": "COPY_THE_DELIVERED_SOURCE_ID",
    "source_version": 1,
    "adopted": true,
    "action": {
      "ref": "runtime:actual-action-id",
      "summary": "Describe the action actually performed using this memory"
    },
    "result": {
      "ref": "runtime:actual-result-id",
      "summary": "Describe the actual result, including failure or uncertainty"
    }
  }]
}
```

```sh
node scripts/conversation-session-evaluate.mjs record-use \
  --db /explicit/private/memory.sqlite \
  --receipt /explicit/private/retrieval-001.json \
  --input /explicit/private/use-input.json \
  --output /explicit/private/use-001.json
```

Set `adopted` to `false` for explicit non-use or `null` when unassessed. Those
states do not require action/result evidence. Omitted delivered items remain
unassessed. Reported use records `used_state_source=reported` through the existing
usage-state API. Unknown does not become a negative outcome; a failed action does
not mean the memory was harmful. New reports can update the reported usage state,
while previous report artifacts and their database hashes remain unchanged.

The harness requires the original artifact hash to match an issued receipt in
the same database, plus exact tenant/project/task/principal, usage event, item,
source ID, version, and successful artifact-delivery records. Altering a receipt,
recomputing its hash, copying it to another database, or claiming a nondelivered
source cannot authorize use reporting. It is a local integrity check, not a
security boundary against a database owner or authentication of a parent runtime.

## Privacy, bounds, and failure behavior

- Only explicit database/input/receipt/output paths are used. No session tree or
  home-directory discovery is performed. Temporary empty workspace and feature
  configurations prevent ambient global configuration reads during this run
- Retrieval preserves the tool's default thresholds. Dense embeddings, optional
  judgment, follow-up query generation, Wiki inclusion, cloud telemetry, and
  network transport are disabled for this evaluation process
- Retrieval can write normal usage/attempt bookkeeping. It does not save, edit,
  confirm, or delete memory contents. `LocalMemoryStore.init()` retains its normal
  schema/permission initialization behavior for the explicitly supplied database
- Script-owned `conversation_session_receipts` contains only hashes, opaque scope
  and usage IDs, phase, and timestamps. Update/delete triggers make those receipt
  rows append-only. `local_use_deliveries` is written only after artifact export
  succeeds. These are export receipts; they are not trusted action/outcome proofs
- Input files are bounded to 128 KiB, query text to 4,000 characters, expected
  source IDs to 32, and report/receipt files to 256 KiB. Symlink input and database
  files and overwriting outputs are rejected. Output directories are not created
- Reports redact recognized credentials, emails, phone numbers, home usernames,
  SSNs, and credential-like fields. Hashes refer to original supplied evidence;
  sanitized text is separate. Pattern-based redaction cannot guarantee arbitrary
  prose contains no personal information. Minimize the supplied evidence first
- Filesystem/database completion is not a distributed transaction. If an I/O or
  database error occurs, do not treat an output file alone as a successful receipt.
  An unanchored retrieval artifact cannot authorize adoption. A usage-state update
  can already have succeeded if its later output fails; inspect scoped usage state
  before retrying with a fresh output filename. No actual task action is replayed

## Synthetic validation

```sh
node --test scripts/conversation-session-evaluate.test.mjs
```

The tests use isolated fixture databases and `session_kind: "synthetic"`. They
exercise normal retrieval, irrelevant-query abstention, exact scope and ACL,
redaction, size bounds, immutable issued receipts, reported adoption, forged
verification rejection, and the standalone CLI. They do not place calls or
establish actual-session adoption, verified effects, token savings, or ROI.
