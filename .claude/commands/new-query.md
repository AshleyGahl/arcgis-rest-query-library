---
description: Add a new entry to the REST query library (sql-library/queryLibrary.js)
argument-hint: <analytical question>
---
Add a library entry for: $ARGUMENTS

1. Read `sql-library/queryLibrary.js` and the framework in `sql-library/framework.md` to pick the right `category`, `dimension` (WHO/WHAT/WHEN/WHERE/WHY/HOW) and `layer` (L1–L5).
2. Write the reference `tsql` and check it with `run_tsql`.
3. Write `rest` (plus `transform` only if REST can't express it). Verify with `query_layer` / `run_library_query` with `compare: true`.
4. Use the next free `id`. Set an honest `portability`. Add `notes` for any caveat.
5. Run `npm test` and `npm run build:http`. If the REST and T-SQL results are exact equivalents, add a parity assertion in `test/library.test.js`.
6. Update the library count in README.md if it changed.
