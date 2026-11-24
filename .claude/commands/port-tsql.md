---
description: Port a T-SQL statement to an ArcGIS REST FeatureServer query and prove they match
argument-hint: <T-SQL statement>
---
Port this T-SQL to an ArcGIS REST `query` request against the ServiceRequests layer:

```sql
$ARGUMENTS
```

1. Run it with `run_tsql` to get the reference result.
2. Write the REST params (`where`, `outFields`, `groupByFieldsForStatistics`, `outStatistics`, `having`, `orderByFields`, `resultRecordCount`).
   For window functions / joins / ratios, keep the REST part to the aggregation and name the client transform from `sql-library/runner.js` (`runningTotal`, `lag`, `movingAverage`, `rank`, `topPerGroup`, `groupCount`, `ratio`, `fullOuterJoin`).
3. Run it with `query_layer` and compare against step 1. Explain any difference (e.g. T-SQL integer AVG truncation vs REST double).
4. State the portability level (standard / sql-expression / native / extension) and why.
5. Output the final params as JSON and as a GET URL.
