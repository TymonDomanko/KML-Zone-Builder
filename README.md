# KML Zone Builder

Build KML zones from suburbs and postcodes, right in the browser. Australia, the United States, Canada and
New Zealand use official government boundaries; every other country uses OpenStreetMap. No API keys, no sign-up.

**Open it:** https://tymondomanko.github.io/KML-Zone-Builder/

## What it does

- **Pick areas** by clicking suburbs or postcodes on the map, searching for them, or pasting a list
  (`Epping, Carlingford, Beecroft`, `2121`, `Epping VIC`, one per line or comma-separated).
- **Make as many zones as you like.** The same suburb or postcode can be in several zones, so zones can overlap.
- **For each zone, choose what goes in the KML:**
  - **Combined outline** – one zone that outlines all of its suburbs/postcodes together (holes are kept if you skip an area in the middle).
  - **Each area as its own zone** – a separate zone for every suburb/postcode in it.
  - Or both.
- **Set each zone's look:** outline colour and width, shading colour and shading opacity (0% for no shading).
  Individual areas use the same colours with a thinner line and half the shading, so they sit under the combined outline.
- **Download** all zones in one KML (a folder per zone, or a flat list), or download a single zone.
- **Save / open projects** as a small `.zones.json` file. Your current work is also kept in the browser.
- Suburbs and postcodes can be mixed in one zone, and zones can cross state (or country) borders.

The KML files work with Google Earth, Google My Maps and the other KML tools
([KML Zone Merger](https://github.com/TymonDomanko/KML-Zone-Merger),
[KML Zone Numberer](https://github.com/TymonDomanko/KML-Zone-Numberer),
[KML Zone Pictures](https://github.com/TymonDomanko/KML-Zone-Pictures)).

## Where the boundaries come from

### Official government data

| Country | Areas | Postcodes | Source |
|---|---|---|---|
| Australia | Suburbs and localities | Postcodes (ABS Postal Areas) | Australian Bureau of Statistics, ASGS 2021 – CC BY 4.0 |
| United States | Cities & towns (Census places) | ZIP codes (ZCTAs) | US Census Bureau cartographic boundary files – public domain |
| Canada | Municipalities (census subdivisions) | Postal areas (first 3 characters, FSAs) | Statistics Canada 2021 Census – Open Government Licence – Canada |
| New Zealand | Suburbs and localities | – (NZ Post postcode boundaries aren't open data) | LINZ NZ Suburbs and Localities – CC BY 4.0 |

Postcode areas are statistical approximations built by each agency, so edges can differ a little from the
postal service's own areas, and PO-box-only postcodes have no area. In pasted lists you can add a state or
province, e.g. `Epping VIC`, `Springfield IL`, `Richmond BC`, and full Canadian postcodes (`M5V 3L9`) or
ZIP+4 codes are cut down to the area they fall in.

### Other countries (OpenStreetMap)

Pick a country at the top. Then either:

- zoom the map to a city or district and press **Show boundaries here** – the tool lists the boundary types
  OpenStreetMap has in view (postcodes, suburbs/places, council or admin levels) and shows the one you pick, ready to click; or
- **search** or **paste a list** of places/postcodes (looked up with Nominatim).

Coverage depends on what volunteers have mapped: e.g. Germany and the Netherlands have postcode outlines,
but many suburbs worldwide are only mapped as a point, which can't be outlined. The tool tells you when
something has no outline. Overpass servers are volunteer-run and sometimes busy – if loading fails, wait a
minute and try again. Boundaries © OpenStreetMap contributors, ODbL.

Official boundaries are simplified to about 10 m so the site loads quickly. Map tiles © OpenStreetMap contributors.

## How it's built

The site is static (`site/`) and hosted on GitHub Pages. The boundary data isn't stored in the repo – the
**Build data and deploy** GitHub Action downloads the official files (or pages through the agencies' public
ArcGIS services), simplifies them with
[mapshaper](https://github.com/mbloch/mapshaper), splits them by state/province into TopoJSON, and publishes the site.
If one country's source is down during a build, that country is left out of that build and the rest still deploy.
It runs on every push to `main`, or manually from the Actions tab.

Zones are merged on the shared boundaries in the TopoJSON, so neighbouring areas join cleanly with no slivers.
To add another country, add an entry to `COUNTRIES` in `scripts/build-data.mjs`.

To switch to newer ABS boundaries later (e.g. the 2026 edition once Suburbs and Postal Areas are released),
put the new zip URLs in `SAL_URL` / `POA_URL` in `.github/workflows/deploy.yml`.

### Running it locally

```sh
npm install
npm run build:data   # downloads ~300 MB of boundary files, writes site/data/
node scripts/build-data.mjs --only sal,poa   # just one country's datasets
npm run serve        # http://localhost:8080
npm test
```

## Setup note

In the repo's **Settings → Pages**, *Source* must be set to **GitHub Actions**.
