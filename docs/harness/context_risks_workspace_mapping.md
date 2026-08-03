# Risk Context: Workspace Mapping

- Existing uncommitted memory-quality changes belong to the prior approved task and must be preserved.
- A guessed tenant in organization mode can route writes into the wrong sharing boundary; organization mode must require an explicit mapped or environment tenant.
- Invalid JSON must fail closed rather than be overwritten as an empty configuration.
- Configuration writes must use a private `0700` directory, `0600` file, and same-directory atomic rename.
- Legacy `project-names.json` must remain intact during migration and be used only as a compatibility input.
- No production D1 mutation or Cloudflare deployment is authorized by this implementation request.
