# The catalog pattern

*Why you would build a system this way at all — the argument without a platform in it, and then an
honest scoring of this repository against it.*

Every other page here describes *this* implementation: a mock ArcGIS FeatureServer, a GeoJSON of
service requests, a library of 70 questions published as table 1. This page is the one that does
not. The design predates the platform and survives a change of platform, so it is worth stating on
its own terms before arguing about whether any particular technology can carry it.

The pattern in one sentence:

> **The set of answerable questions is data in the store, not code in the server.**

One generic executor. One generic renderer. Each question is a row, written and tested by someone
qualified, then published. A client names a question; it never composes one.

## 1. The bet it makes

The conventional design is one endpoint per question: a route, a repository method, a response type,
a client call, a chart component. Question 71 touches six artifacts across three layers and needs a
deployment. The cost per question is roughly constant and never small.

The catalog design has a large fixed cost — a generic executor and a generic renderer are both
harder than any single endpoint — and then a marginal cost of one row.

So this is an amortisation bet, and it is falsifiable. At eight questions that never change, eight
endpoints are simpler, typed, and easier to debug. At seventy that grow every month, it is not
close. **The first question to ask of this architecture is not technical: does the question set keep
growing?** If it does, the per-question tax is permanent, and buying it out is what this pattern is
for.

## 2. Dropping result types is the precondition, not an omission

A per-question response type is a compile-time commitment to the shape of an answer. Keep one per
question and that shape lives in three places — the statement, the server-side type, the client
model — which must then be versioned and deployed together. That coupling, more than the line count,
is the real cost of the conventional design.

Remove it and the result shape becomes runtime data: a row set with column names. That is exactly
what permits a catalog, because you can add a question whose result has columns nobody has seen
before and nothing downstream recompiles.

But a shape still has to be described somewhere, and noticing where is the whole insight. The
question is not *where does the statement live*. It is **where does the type live**.

| Where the type lives | When it binds | Cost to change | Failure mode |
|---|---|---|---|
| In code, as a response type | compile time | a deployment | coupling; surface grows with N |
| **In the data**, as catalog columns | runtime | one row | nothing checks it unless you check it |
| Nowhere — inferred from the result's shape | never | not applicable | silently wrong, confidently |

Dropping the types does not delete the type. It relocates it into the catalog row. Columns such as
`ChartType`, `ChartLabelColumn` and `ChartValueColumns` **are** the type system, expressed as data.
A catalog without them has quietly chosen the third row of that table, where the shape is an
inference rather than a contract — and an inference cannot be wrong loudly.

## 3. Trust moves to authoring time

This is the deepest consequence, and it is the same shift as prepared statements over input
sanitisation.

A general query interface must defend itself on every request, forever, against requests it has
never seen. That defence is code — validation, parsers, limits, allow-lists — and it is permanently
incomplete, because the adversary is "all possible queries".

A catalog is defended once, at write time, by a person with the authority and the knowledge to
judge. The executor needs no opinion about whether a statement is sensible, because someone already
had that opinion and recorded it. The surface is not merely smaller; it is **finite and enumerated**.
You can print it out.

Two things follow that are easy to miss:

- **The query set becomes a tractable optimisation target.** A DBA can read all seventy, inspect all
  seventy plans, and index for exactly them. Nobody can do that for arbitrary client-composed
  predicates, which is why self-service reporting has a structural performance problem rather than a
  tuning failure.
- **"Which report is right?" is eliminated by construction**, not mitigated. One definition of
  resolution time exists, it has a primary key, and every surface showing that number ran the same
  row.

A column carrying the expected answer in plain language is not help text, then. It is the
**ratification record travelling with the definition**: here is what this number means, asserted by
the person who stood behind it. People trust numbers they can interrogate.

## 4. The invariant everything rests on

> **The client sends a reference, never a definition.**

An identifier in, rows out. The moment a client can send a definition — or a fragment of one, a
filter expression, a sort clause — there is no catalog any more. There is a query API with a
suggestions list, and governance, auditability and the meaning of the test suite all evaporate
together.

It is worth being explicit about how much hangs on that one rule, because each payoff looks
unrelated until you notice they share a cause:

| Because the client sends only a reference | You get |
|---|---|
| definitions never leave the trusted side | governance: they can be ratified, versioned, audited |
| the executable set is finite and known | a query set a DBA can index and plan for |
| the key is small, stable and already in the request | caching is trivial, with no statement normalisation |
| every execution is attributable to one identifier | per-question telemetry for free |

That last one is an under-appreciated gift. Hit counts, latency and error rate **per analytical
question** tell you which questions matter, which have not run in a year and should be retired, and
which deserve an index. The system becomes self-observing, and that feedback loop is what keeps a
library curated instead of merely accumulating.

## 5. The definition cache is a read model, not an optimisation

Because the keyspace is small, bounded and read-mostly, a server holding the library in memory stops
consulting the store for definitions at all. It consults it only for data.

Two caches live here and they must not be conflated:

| | Definition cache | Result cache |
|---|---|---|
| Size | kilobytes | unbounded |
| Invalidated by | authoring — rare, discrete | data change — continuous, diffuse |
| Varies by user | never | often: tenant, permissions |
| Writers | one, through one path | many |
| Risk when wrong | the wrong *definition* executes | a stale number is shown |

The definition cache is the high-value, low-risk one, and the hard part of caching is easy for a
structural reason: there is exactly one writer, through one authoring path. One writer plus a known
keyspace makes invalidation a solved problem.

At this scale, **loading the whole library eagerly beats caching questions lazily** — and not mainly
for latency. Eager loading converts the cache into a **load-time contract check**. If every
definition is loaded at start-up, every definition can be validated at start-up: parsed, resolved
against the live schema, checked that the result columns it declares actually exist. The process can
then refuse to start on a broken catalog.

That matters because it answers the worst liability of the pattern, named in section 7: a renamed
column breaks seventy strings in a table, and the breakage is found at runtime, by a user, on the
question nobody runs. Validation at load turns that into a deployment-time failure. It is the
closest thing this architecture has to a compiler, and the cache is where it naturally lives.

Lazy caching also leaves a permanently cold long tail — and the rarely-run questions are exactly the
least-exercised ones, so the first person to run question 63 in a year is the one who discovers it
broke in March.

## 6. Maintenance is the coherence protocol you owe

Deployed code gets cache coherence free: the deployment *is* the invalidation. Move definitions out
of the artifact and into a mutable shared store — the entire premise here — and that mechanism is
forfeited. It has to be rebuilt by hand.

So a refresh loop that re-reads definitions and notices changed statements is not an extra bolted
onto the cache. It is **the price of making definitions data**. Every architecture that moves
behaviour into data pays this somewhere; the ones that do not pay it have an undiagnosed staleness
bug.

Polling is the right default, and the reason is general rather than local:

| | Push: invalidate on publish | Poll: check for change |
|---|---|---|
| Latency | immediate | bounded by the interval |
| Requires every writer to cooperate | yes | no |
| An out-of-band edit | never propagates, silently, forever | converges on the next tick |
| Recovery from a missed signal | never | automatic |
| Cost | none | a steady trickle |

This is the distinction between edge-triggered and level-triggered control. Push reacts to an event
and misses it permanently if the event is lost; polling observes state and converges regardless of
what happened. It matters here specifically because the catalog is a table, so the set of possible
writers is "anyone with write access to a table" — never just the application. The mature form is
both: push for latency, polling as the backstop that catches what push missed. Never push alone.

Three rules the refresh must follow:

1. **Swap the whole library atomically.** Refresh row by row and a user can assemble one dashboard
   from a mixture of old and new definitions. Uniformly stale is coherent — everything on screen
   agrees with everything else. Half-refreshed is not, and in a system whose entire selling point is
   one definition of truth, incoherent is worse than stale.
2. **Fail static.** If the store cannot be reached, keep serving the last known good catalog. A
   failed refresh degrades to "slightly stale", never to "no questions available". This also buys
   real resilience: the definition store can be down while the system still answers questions.
3. **Validate before swapping.** Hold the last good definition and raise an alarm instead of
   publishing a broken one, because the refresh loop is also an automatic distribution channel and
   does not distinguish a correction from a mistake.

Rule 3 has a bonus. Validation at load (section 5) becomes **continuous** at no extra cost: every
refresh is an opportunity to re-resolve every definition against the current schema. A migration
that breaks question 63 is then caught on the next tick and can page someone, rather than waiting
for an unlucky user. A staleness check is already most of a catalog health monitor; the rest is
validating and reporting instead of silently swapping.

One column makes all of this cheaper. A **monotonic catalog version** reduces each poll to a single
scalar comparison, but the reason to want it is that it solves three problems at once: coherence
("has anything changed?"), audit ("question 5 at catalog version 1183 is what actually ran") and
reproducibility ("re-run that report exactly as it stood in March"). Without it, a cached definition
plus a mid-flight edit means the audit log names a statement that is not the one that executed.

## 7. What it costs

Stated plainly, because none of the above is free:

- **Every stack trace points at the executor.** The thing that failed is a row. Unless the error
  path echoes the question number and its definition, all failures look identical — the diagnostic
  value of typed code is lost by default and has to be paid back deliberately.
- **Schema refactoring loses its safety net.** A compiler finds every response type; nothing finds
  seventy strings in a table. This is the single biggest liability, and sections 5 and 6 exist to
  buy it back.
- **Authority has a shelf life.** A definition ratified against a business process that has since
  changed returns a confident, well-formed, wrong number — carrying the full weight of "the system
  says so", which is worse than an obviously broken report. Tested once silently becomes trusted
  forever unless definitions carry provenance and get re-ratified.
- **Automatic refresh distributes mistakes as efficiently as corrections.** See rule 3 above.
- **No question can ever be special.** Everything renders the same way. The first question needing
  bespoke interaction forces an escape hatch, and escape hatches multiply until the system has two
  architectures and the benefits of neither. Policing that is a permanent discipline.

## 8. What it means for delivery

**Two release trains with different natural cadences.** The code — executor and renderer — changes
rarely. The content — questions — changes often. The whole payoff is letting the content train run
without the code train. A pipeline that couples them has paid the fixed cost and kept only the
reduction in code surface.

But a question is code that happens to live in a table. It executes, it can be wrong, it can be
slow, it can leak. So the central delivery decision is where the catalog sits relative to source
control, and there are three honest postures:

| Posture | Agility | Review gate | Risk |
|---|---|---|---|
| Catalog as source, deployed into the table | a deployment per question | full | gives back the marginal-cost win |
| Catalog as live production data | immediate | none | a bad question reaches production unreviewed |
| Catalog as data with its own promotion path | fast | full | the most expensive to build |

Choosing the second while believing you have the third is how this architecture fails in year two —
and polling (section 6) makes that worse, because propagation is then automatic and unreviewed.

**What the test suite can assert changes shape.** It cannot test behaviour per feature, because
there are no features. It must assert *properties over the catalog*: every row parses and executes
against a reference dataset; every row returns inside a time and row budget; every column a row
declares actually appears in its result; where two definitions of one metric exist, they agree.

That has a lovely property — **coverage grows automatically with content**, since adding a question
adds its own tests — and it is the mechanism that buys back the compiler given up in section 2.

It also narrows what the pipeline is for. Correctness was established at authoring time by a person,
better than a test could. The pipeline's job is the narrower, more achievable one: **proving the
ratified answer is still the ratified answer** as data grows and schemas move underneath it.

One last reframing, because it is usually set as an ops default rather than decided:

> The poll interval is the deployment latency for content. The content train's release cadence *is*
> the refresh interval.

That makes it a product decision — how quickly must a corrected metric reach people? — not a number
someone rounded to five minutes.

## 9. Where the pattern does not fit

- **Low, stable N.** Fewer than a dozen questions that rarely change: build the endpoints.
- **Questions needing bespoke interaction**, multi-step flows, or a result that is not a row set.
- **Write paths.** This is a read pattern. The moment a catalogued operation mutates, a generic
  executor is an arbitrary-command executor.
- **Per-tenant or per-row security**, unless the predicate is injected by the executor rather than
  stored in the definition. A security rule living in a row is a security rule an author can edit.

## 10. How this repository measures up

This repo implements the pattern on an ArcGIS REST FeatureServer, to test whether that platform can
replace a hand-written API tier. Measured against the sections above:

**Holds.** The catalog is data, served over the same generic `query` operation as the features
themselves, so discovery and execution are both standard requests and no question is compiled into
the client (section 4, partially). More importantly, the test suite already asserts *properties over
the catalog* rather than behaviour per feature — 70 REST runs, 69 T-SQL runs, a catalog round-trip
and parity between the two — which is section 8 done properly, and the most architecturally mature
thing here.

**Inverted.** The client receives the decomposed parameters and replays them against the data layer,
because a FeatureServer has no execute-by-identifier endpoint. That is section 4's invariant running
backwards, and it is a platform limit rather than an oversight — see limit 3 in
[the query catalog page](query-catalog.md), which notes that the layer still accepts an arbitrary
`where` from anyone who can reach it. The consequence is worth stating in the language of this page:
the platform replaces the storage, the executor and the serialisation. **It does not replace the
trust boundary.** A tier that refuses to forward a client-supplied predicate is still required if
the whitelist property matters.

**Added since.** The `Chart*` columns of section 2 are now in the catalog: 44 of the 70 questions
declare how their answer is drawn, 26 declare `HasChart = 0`, and the result drawer obeys the
contract where there is one, falling back to inferring from the shape of the rows only where there
is not. The gap that mattered was not the column but that nothing could check the shape of an
answer: `test/catalog.test.js` now runs every charted question and fails if a declared column is
missing from its result or is not numeric. That is section 5's load-time contract check standing in
a test rather than in a process boot — the most this repo can do while the library is source rather
than stored state.

**Still missing.** Two things the pattern calls for, each named against its section:

1. **Bounded parameterisation** (section 4). There is no way to vary a question within limits its
   author ratified, so the only choices on offer are the exact question or a free-form query.
2. **A validated definition cache** (sections 5 and 6). The library is loaded from source at
   start-up rather than from a mutable store, so neither the coherence protocol nor the load-time
   contract check has anywhere to live — and the liability in section 7 is correspondingly unguarded.

Those are gaps in the demonstration, not arguments against the pattern. What to do about them is a
separate decision.

**Not evidence.** The mock's `/0/sql` route and the MCP `run_tsql` tool both accept a statement from
the caller. They are deliberate conveniences for comparing this engine against SQL Server, and they
sit outside the claim this page makes — nothing about them should be read as the pattern working.
