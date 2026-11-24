---
description: Answer a question about the service-request data by querying the mock FeatureServer
argument-hint: <question in plain English>
---
Answer this question about the Cape Town service-request data: $ARGUMENTS

1. Call `describe_layer` if you have not already, so where clauses use real field names and values.
2. Answer with `query_layer` using ArcGIS REST parameters (prefer `outStatistics` + `groupByFieldsForStatistics` over pulling rows).
   Use the most portable SQL that works (standard > sql-expression > native).
3. Reply with the answer first, then a small table if useful, then the REST request URL you used so it can be replayed against a real service.
4. If an existing library query already answers it, say which one (`list_library`).
