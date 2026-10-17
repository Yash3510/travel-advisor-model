# Data sources, licences and attribution

Every fact the itinerary engine uses comes from one of the sources below, keeps its source and checked date, and is
shown with the attribution the licence requires. Where a source has no data (opening hours, visit length, live
events), the app says "unknown" or "not checked" and states an assumption. It never fills the gap with made-up facts.
No commercial website is scraped.

## Summary

| Data | Source | Licence | Attribution the app must show | Refresh |
|---|---|---|---|---|
| Places to visit (name, coordinates, category, opening hours, wheelchair access, fees, vegetarian-friendly restaurants) | OpenStreetMap | ODbL 1.0 | "© OpenStreetMap contributors", linking to https://www.openstreetmap.org/copyright | Re-run the importer per destination (dev: Overpass; production: regional extract) |
| Destination guide (when to go, climate, getting in, permits, seasonal closures) | Wikivoyage, cached in `data/raw/wikivoyage/` (121 Indian destinations, fetched 2026-10-11) | CC BY-SA 4.0 | Article title and link, "CC BY-SA 4.0" | Re-fetch with the model repo's `travel/kb.py`, then rebuild |
| Weather forecast | Open-Meteo | Data CC BY 4.0 | "Weather data by Open-Meteo.com" | Fetched per plan, at most 16 days ahead |
| Travel time between places | Computed: straight-line distance × road factor ÷ speed | — | Shown as an estimate | — |
| Events, closures beyond opening hours, advisories, entry rules | None approved yet | — | Shown as "not checked" | Phase 3 |

## OpenStreetMap (places)

- **Licence:** Open Database License 1.0. The app must credit "© OpenStreetMap contributors" and make clear the data
  is under the ODbL, wherever places from it are shown. The API puts this notice in every itinerary's `sources`, and
  the frontend must display it.
- **Share-alike:** the normalised place files (`app/backend/data/poi/*.json`) are a derived database. If it is used
  publicly, it must be offered under the ODbL, so these files are kept separate from any proprietary data, and the
  importer and its raw inputs are reproducible.
- **Access:**
  - *Development:* the public Overpass API (`overpass-api.de`), one query per destination. The client identifies
    itself, sends no parallel requests, and caches the raw response. Its usage policy: under 10,000 queries and 1 GB a
    day, and commercial use should self-host or use extracts.
  - *Production:* a regional extract (for example Geofabrik's India extract), filtered with osmium. Alternatively a
    self-hosted Overpass, which keeps the same importer.
- **Coverage:** major attractions in Indian destinations are well mapped. `opening_hours` is often missing, so the
  app treats it as unknown with low confidence, not as "open". OSM has no visit lengths: the app uses a duration per
  category, labelled as an assumption ("about 2 h, typical for a museum").
- **Reproducibility:** each import keeps the raw response, its SHA-256, the query and the date in a manifest. The
  normalised output is a pure function of that raw file.

## Wikivoyage (destination guide)

- **Licence:** CC BY-SA 4.0. Each guide insight carries the article title, URL and licence. Text derived from it
  (snippets, sentences the model rephrases) stays CC BY-SA 4.0.
- **Use:** retrieval for seasons, routes, permits and closures, never presented as a live check. The pages are a
  snapshot: an insight is marked stale when the snapshot is more than a year old.

## Open-Meteo (weather)

- **Licence:** data under CC BY 4.0. Credit "Weather data by Open-Meteo.com".
- **Terms:** the free API is for **non-commercial use only** (under 10,000 calls a day). A production Takeoff needs a
  paid plan (API key, `customer-api.open-meteo.com`) or a self-hosted Open-Meteo server (AGPL-3.0). The app only
  calls the free API outside production; in production it needs `OPEN_METEO_API_KEY`, or weather is reported as not
  checked.
- **Horizon:** daily forecasts up to 16 days ahead. Trips further out get "forecast not available yet", plus the
  guide's seasonal notes when there are any.

## Travel time

No routing provider is used in Phase 2. The OSRM public demo server is non-commercial and limited to one request per
second, so it isn't suitable. Estimate: great-circle distance × 1.35 (roads aren't straight), at 25 km/h for short
local legs and 40 km/h for longer ones, plus 10 minutes for parking and walking. Every leg is labelled an estimate
with confidence 0.5. Phase 3 option: a self-hosted OSRM (BSD-2-Clause) on OSM data.

## Not approved, so not used

- Scraping commercial travel sites or maps (reviews, hours, prices).
- The inherited `catalog.json` deals contain another company's titles and images. They are mock data, not a licensed
  source, and must be replaced before launch.
