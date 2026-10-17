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
| Travel time between places | Self-hosted OSRM when `ROUTING_URL` is set; otherwise computed from straight-line distance | OSRM: BSD-2-Clause software, routes from OSM data (ODbL 1.0) | "© OpenStreetMap contributors"; estimates are labelled as estimates | Rebuild the OSRM graph with each OSM extract refresh |
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

Travel times sit behind one provider interface (`backend/src/services/travelTime.ts`):

- **Road times: a self-hosted OSRM server, when `ROUTING_URL` is set.** The backend calls the standard route service,
  `GET {ROUTING_URL}/route/v1/driving/{lon},{lat};{lon},{lat}?overview=false`, with a timeout (`ROUTING_TIMEOUT_MS`,
  default 2000). It accepts only `code: "Ok"` with a non-negative numeric `duration` and `distance`. The leg is the
  road time plus 10 minutes for parking and getting in and out, labelled `basis: "road"`, `source: "OSRM"`,
  confidence 0.8. OSRM's car profile uses free-flow speeds and knows nothing about traffic, so these are still
  planning times, not guarantees.
- **Fallback: the straight-line estimate.** Great-circle distance × 1.35 (roads aren't straight), at 25 km/h for short
  local legs and 40 km/h for longer ones, plus 10 minutes. It is labelled `basis: "straight_line_estimate"`,
  `isEstimate: true`, confidence 0.5, and the plan carries a warning saying the times are estimates. When OSRM was
  configured but failed (timeout, non-200, malformed reply), the source says "road routing unavailable" and the
  warning says so too. After one failure the rest of that plan uses the estimate, so a dead server costs one timeout.
  "No route" for one pair (an island, a point far from any road) falls back for that pair only.
- **Only the plan's legs are asked.** The search compares many pairs of places with the estimate; the legs a plan
  actually uses are then asked of OSRM (once per pair per request), the plan is rebuilt with those answers, and the
  validator checks the final schedule against them.

**The public demo server (`router.project-osrm.org`) is not used in production.** Its usage policy limits it to
light, non-commercial use, so the backend refuses it when `NODE_ENV=production` and falls back to estimates with a
logged warning.

**Self-hosting OSRM** (software BSD-2-Clause; the road graph is built from an OSM extract, so ODbL applies and the
"© OpenStreetMap contributors" credit the plan already carries covers it):

```bash
# a regional extract from download.geofabrik.de that covers the destination, saved as region.osm.pbf
docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/region.osm.pbf
docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/region.osrm
docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/region.osrm
docker run -d -p 5000:5000 -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/region.osrm
# then: ROUTING_URL=http://<osrm-host>:5000
```

Building the graph takes several GB of RAM for a large extract; rebuild it whenever the OSM extract is refreshed.

## Not approved, so not used

- Scraping commercial travel sites or maps (reviews, hours, prices).
- The inherited `catalog.json` deals contain another company's titles and images. They are mock data, not a licensed
  source, and must be replaced before launch.
