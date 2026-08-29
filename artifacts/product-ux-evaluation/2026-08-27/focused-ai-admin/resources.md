# Evaluation resources

- Started the local API and Console against the repository's local persisted D1 state.
- Created a synthetic default-tenant UX fixture: 8 users, 3 groups, 8 role assignments, and 6 memories.
- The archive command completed successfully, and its manifest records: 6 memories moved to trash, 8 role assignments deleted, 3 groups archived, and 8 users deprovisioned. No independent database readback was performed.
- Stopped the local API and Console processes. A final listener readback found ports 4321 and 8787 closed.
- The fixture manifest is retained as an audit trail. It contains no production credentials or production data.
