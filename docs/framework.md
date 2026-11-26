# Service Request Analytics: Query Design Framework

This framework organises the 30 queries in `sql-library/queryLibrary.js`. Each query is also generated
into `sql/03_vw_QueryLibrary.sql`.

## 1. Core question dimensions (5 W's + H)

| Dimension | Core questions | Primary techniques |
|---|---|---|
| **WHO** | Which channels do people use to report? | `GROUP BY Channel`, `COUNT`, window functions |
| **WHAT** | What types of request arrive? Which categories dominate? | `GROUP BY Category/CategorySub`, `DISTINCT`, `LIKE` |
| **WHEN** | When are requests logged and completed? What are the trends? | date functions, time grouping, time series |
| **WHERE** | Where do requests come from? Which have no suburb? | `GROUP BY Suburb`, `NULL` handling, spatial filters |
| **WHY** | Why do requests stay open? What is stuck? | `CASE`, ageing, status distribution |
| **HOW** | How long does resolution take? How well does each channel perform? | `AVG`, `PERCENTILE_CONT`, `DATEDIFF` |

## 2. Analytical layers

| Layer | Focus | Typical outputs |
|---|---|---|
| **L1 Descriptive** | What happened? | Counts, distributions |
| **L2 Temporal** | When did it happen? | Daily, weekly, monthly and hourly trends |
| **L3 Performance** | How well did we perform? | Turnaround times, service levels, percentiles |
| **L4 Filtered / Diagnostic** | What about X specifically? | Subsets, stuck items, data-quality exceptions |
| **L5 Advanced** | Why, and what's next? | Rankings, MoM/YoY, rolling averages, cross-dimension patterns |

## 3. Coverage checklist

Counts & aggregates · time series · performance (mean, median, P90) · distributions and bucketing ·
top-N · filtered subsets · cross-tabs and conditional pivots · data quality ·
rolling aggregates · ranking · cross-dimension dominance · text analysis · thematic roll-ups · change over time.

## 4. Enhancement roadmap

1. **Service-level matrix:** replace the flat 5-day threshold with a lookup table keyed by `Category`
   and `CategorySub`, and support business days as well as calendar days.
2. **Seasonal baselines:** compare against multi-year seasonal norms so predictable winter-storm or
   summer peaks aren't flagged as anomalies.
3. **Auto-triage:** classify free-text descriptions into categories and spot urgency words at intake.
4. **Executive KPIs:** open backlog ratio, % closed within target, channel mix, and top suburbs by open backlog.
5. **Anomaly alerts:** schedule a check for daily volume above 2.5σ of the 30-day moving average.
6. **Spatial enrichment:** back-fill a missing `Suburb` by point-in-polygon join, and serve aggregates to web maps.
