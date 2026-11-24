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

Query 54 rolls these up into themes: **Three Waters**, **Transport**, **Waste**, **Parks & Open Space**
and **Community & Regulatory**. "Three Waters" is the common New Zealand term for drinking water,
wastewater and stormwater.

## Where this comes from (New Zealand councils, public sources)

- **Christchurch City Council** groups its public Snap Send Solve reports as Roading/Streets, Water Supply,
  Wastewater/Stormwater, Flooding, Rubbish/Recycling, Parks, Graffiti and Other (its ArcGIS service legend).
  It also publishes Request for Service tickets located in public spaces as open data.
- **Auckland Council "Report a problem"** covers bins and missed collections, public spaces, litter, noise,
  wandering or barking dogs, flooding, graffiti, dumped rubbish, manhole and catchpit covers, and abandoned vehicles.
- **Wellington City Council FIXiT** asks for a problem category, a description (600 characters) and optional
  photos. Hazards, noise and major leaks go to the phone line, which is why this data sends urgent types to `Phone` more often.
- **Antenno** (Waitaki, Waikato, Nelson, Whakatāne and others) lists potholes and road damage, streetlights,
  graffiti and vandalism, blocked drains, fallen trees, and rubbish and recycling as typical reports.
- **Status and dates.** Open council service-request datasets commonly publish service type, date opened,
  date closed and status (for example City of Melbourne's customer service requests data dictionary).
  Received date, closed date and status are the backbone here too.

Volumes and timings are synthetic. Seasonality follows the southern hemisphere: winter peaks for drains,
flooding, roads, trees and streetlights, and summer peaks for water, parks and noise.

## Deliberate data defects (exercised by queries 57–60)

- `Closed` with no `DateCompleted`
- `DateCompleted` earlier than `DateLogged`
- `DateCompleted` set while `Status` is not `Closed`
- `Suburb` NULL (pin-only app reports), and empty or NULL `Description`
