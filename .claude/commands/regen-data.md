---
description: Regenerate the synthetic GeoJSON and re-validate everything
argument-hint: [--count 500-1000] [--seed N] [--asof "YYYY-MM-DD HH:MM"]
---
1. Run `npm run generate -- $ARGUMENTS`.
2. Run `npm test`; investigate any failure (most likely a parity check or a query that now returns no rows).
3. Run `npm run build:http`.
4. Summarise: feature count, date range, open vs completed, and the count for each data-quality defect (library queries 57–60 via `run_library_query`).
