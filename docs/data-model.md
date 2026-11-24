# Data model: generic public service request

The layer is a **generic council "report a problem" record**. It holds only what a member of the public
submits plus the council's lifecycle dates. It contains no internal system names, staff or contractor
details, or complainant contact data. Coordinates are synthetic points in and around Cape Town.

## Fields

| Field | Type | Example | Notes |
|---|---|---|---|
| `ObjectID` | OID | 412 | Layer object id, in logged order (`ObjectID DESC` = newest first) |
| `RequestID` | text(20) | `SR-2026-00460` | Public reference number given to the reporter |
| **`Category`** | text(50) | `Water Supply` | **Core fact.** Top-level issue group the reporter picks |
| `RequestType` | text(60) | `Water leak` | Sub-type within the category |
| `Status` | text(20) | `Open` · `In Progress` · `Closed` | Lifecycle status |
| `Channel` | text(20) | `App` · `Online form` · `Phone` · `Email` · `In person` | How the request reached the council |
| `Suburb` | text(60) | `Khayelitsha` | Address match. NULL when only a map pin was supplied |
| `Description` | text(600) | `Pothole on Main Road…` | Free text, capped like typical online forms |
| **`DateLogged`** | date | epoch ms | **Core fact.** When the request was received |
| **`DateCompleted`** | date | epoch ms / null | **Core fact.** When it was closed off |
| *geometry* | point | WGS84 | Location of the issue (Cape Town) |

## Categories and request types

| Category | Request types |
|---|---|
| Roads & Footpaths | Pothole · Damaged footpath · Road sign or marking |
| Streetlights | Streetlight not working · Damaged streetlight pole |
| Water Supply | Water leak · No water or low pressure · Water meter issue |
| Wastewater & Stormwater | Blocked drain · Wastewater overflow · Manhole or catchpit cover |
| Flooding | Surface flooding · Blocked culvert |
| Rubbish & Recycling | Missed collection · Bin repair or replacement · New bin request |
| Illegal Dumping | Dumped rubbish · Loose litter |
| Graffiti | Graffiti on public property |
| Parks & Reserves | Broken play equipment · Grass mowing · Public toilet issue |
| Trees | Fallen tree or branch · Overhanging vegetation |
| Noise | Party or people noise · Construction noise |
| Animals | Roaming dog · Barking dog |
| Abandoned Vehicles | Abandoned vehicle |

Query 54 rolls these up into themes: **Three Waters** (drinking water, wastewater and stormwater),
**Transport**, **Waste**, **Parks & Open Space** and **Community & Regulatory**.

## How the data behaves

Everything is synthetic and generated from a seed, so a given seed always produces the same file.
The generator shapes it so the query library has something real to find:

- **Seasonality** follows the southern hemisphere: winter peaks for drains, flooding, roads, trees
  and streetlights; summer peaks for water, parks and noise.
- **Channel correlates with urgency.** Hazards, noise and major leaks arrive by `Phone` more often
  than routine requests, which skew towards `App` and `Online form`.
- **Resolution time varies by request type**: each type has a median, scattered log-normally, and
  requests whose description reads as urgent close faster. Anything that would still be open at the
  snapshot time stays `Open` or `In Progress`, which is what gives the backlog and ageing queries
  a realistic spread.
- **Suburb is sometimes NULL**, standing in for a report that gave only a map pin — more often on
  `App` reports (8%) than on other channels (3%).

## Deliberate data defects (exercised by queries 57–60)

- `Closed` with no `DateCompleted`
- `DateCompleted` earlier than `DateLogged`
- `DateCompleted` set while `Status` is not `Closed`
- `Suburb` NULL (pin-only app reports), and empty or NULL `Description`
