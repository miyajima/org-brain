# Question-answer memory

In a mapped local workspace with `memory_learning_mode=eager` and
`ORGBRAIN_LOCAL_HOOK_CAPTURE=true`, the PostToolUse hook projects actual
`request_user_input` / `request_user_input_async` answers from task commitments
into searchable decision memory. This closes the prior gap where eager answers
remained only in task commitments and never reached ordinary memory search.

The decision contains the question, submitted answer, evidence digest, task and
project scope, and reuse conditions. Unknown rationale remains null. Reuse is
limited to the original project and task; this path does not turn an answer
into a general preference or claim an execution succeeded.

- A successful tool result containing an answer is required. A shown question,
  failed tool, missing answer, undecided reply or sensitive content saves no
  decision. Memory-save confirmation questions are excluded.
- A stable key includes tenant, project, task and question identity. Replaying
  an answer does not add a version; a changed answer updates that decision.
- Pending asynchronous questions expire after 24 hours. Ask one at a time.
  A later exact option label or free-text reply beginning `回答:` is associated
  with that question only within its task and project. Unrelated or ambiguous
  replies are not inferred. Pending state is completed only after persistence
  succeeds, allowing retries after a write failure.
- Confirm/off mode and cloud memory retain their existing behavior. This
  automatic local path does not perform an interactive propose/confirm write,
  invoke another model, or read a conversation transcript.

Implementation: `src/lib/question-answer-memory.mjs` in the CLI package,
`src/local-memory.mjs` for PostToolUse, `src/codex-memory-context.mjs` for
UserPromptSubmit, and `src/lib/task-commitment-store.mjs` for pending questions.
Hook deployment requires rebuilding the standalone CLI used by the configured
hooks; editing source files alone does not change the installed runtime.

Verification:

```sh
node --no-warnings --test scripts/question-answer-memory.test.mjs
node --no-warnings --test scripts/local-memory-confirmation-flow.test.mjs scripts/codex-memory-context.test.mjs scripts/memory-contract-v2.test.mjs
pnpm run contract:check
```

These tests use an isolated local SQLite database and synthetic answers. They
verify durable rows and search readback, duplicate prevention, revisions,
sensitivity and confirmation boundaries, and asynchronous reply association.
They do not prove that a future human answer has already been saved.
