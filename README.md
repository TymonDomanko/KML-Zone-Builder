# KML Zone Builder

Build KML zones from Australian suburbs and postcodes, right in the browser. No API keys, no sign-up.

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
- Suburbs and postcodes can be mixed in one zone, and zones can cross state borders.

The KML files work with Google Earth, Google My Maps and the other KML tools
([KML Zone Merger](https://github.com/TymonDomanko/KML-Zone-Merger),
[KML Zone Numberer](https://github.com/TymonDomanko/KML-Zone-Numberer),
[KML Zone Pictures](https://github.com/TymonDomanko/KML-Zone-Pictures)).

## Where the boundaries come from

Australian Bureau of Statistics, Australian Statistical Geography Standard (ASGS) Edition 3, 2021:

- **Suburbs and Localities (SAL)**
- **Postal Areas (POA)** – the ABS's approximation of Australia Post postcodes. They are built from census
  blocks, so edges can differ a little from Australia Post's own postcode areas, and PO-box-only postcodes have no area.

© Australian Bureau of Statistics, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Boundaries are simplified to about 10 m so the site loads quickly. Map tiles © OpenStreetMap contributors.

## How it's built

The site is static (`site/`) and hosted on GitHub Pages. The boundary data isn't stored in the repo – the
**Build data and deploy** GitHub Action downloads the ABS files, simplifies them with
[mapshaper](https://github.com/mbloch/mapshaper), splits them by state into TopoJSON, and publishes the site.
It runs on every push to `main`, or manually from the Actions tab.

Zones are merged on the shared boundaries in the TopoJSON, so neighbouring suburbs join cleanly with no slivers.

To switch to newer ABS boundaries later (e.g. the 2026 edition once Suburbs and Postal Areas are released),
put the new zip URLs in `SAL_URL` / `POA_URL` in `.github/workflows/deploy.yml`.

### Running it locally

```sh
npm install
npm run build:data   # downloads ~150 MB from the ABS, writes site/data/
npm run serve        # http://localhost:8080
npm test
```

## Setup note

In the repo's **Settings → Pages**, *Source* must be set to **GitHub Actions**.
