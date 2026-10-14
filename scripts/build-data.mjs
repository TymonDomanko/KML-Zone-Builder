#!/usr/bin/env node
// Builds the official boundary data used by the site.
//
//   node scripts/build-data.mjs [--out site/data] [--only sal,poa] [--interval 10] [--<ds> local-file]
//
// Sources are downloaded (and cached in .cache/) unless a local file is given, e.g. --sal SAL.zip.
// Output:
//   data/index.json                 countries + datasets + regions (small)
//   data/<ds>/items.json            [[code, name, regionKey], ...] for search and pasted lists
//   data/<ds>/<regionKey>.json      TopoJSON, object "areas", properties { code, name }

import mapshaper from 'mapshaper';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const { runCommands } = mapshaper;

const ABS =
  'https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-3-july-2021-june-2026/access-and-downloads/digital-boundary-files/';

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico', GU: 'Guam', VI: 'US Virgin Islands', AS: 'American Samoa', MP: 'Northern Mariana Islands',
};
// ZIP codes start with a digit that covers a group of states.
const ZIP_GROUPS = {
  0: 'ZIP 0xxxx: CT, MA, ME, NH, NJ, RI, VT, PR',
  1: 'ZIP 1xxxx: DE, NY, PA',
  2: 'ZIP 2xxxx: DC, MD, NC, SC, VA, WV',
  3: 'ZIP 3xxxx: AL, FL, GA, MS, TN',
  4: 'ZIP 4xxxx: IN, KY, MI, OH',
  5: 'ZIP 5xxxx: IA, MN, MT, ND, SD, WI',
  6: 'ZIP 6xxxx: IL, KS, MO, NE',
  7: 'ZIP 7xxxx: AR, LA, OK, TX',
  8: 'ZIP 8xxxx: AZ, CO, ID, NM, NV, UT, WY',
  9: 'ZIP 9xxxx: AK, CA, HI, OR, WA',
};
const CA_PROVINCES = {
  10: ['Newfoundland and Labrador', 'NL'], 11: ['Prince Edward Island', 'PE'], 12: ['Nova Scotia', 'NS'],
  13: ['New Brunswick', 'NB'], 24: ['Quebec', 'QC'], 35: ['Ontario', 'ON'], 46: ['Manitoba', 'MB'],
  47: ['Saskatchewan', 'SK'], 48: ['Alberta', 'AB'], 59: ['British Columbia', 'BC'], 60: ['Yukon', 'YT'],
  61: ['Northwest Territories', 'NT'], 62: ['Nunavut', 'NU'],
};
const CA_PROV_NAME = Object.fromEntries(Object.entries(CA_PROVINCES).map(([k, v]) => [k, v[0]]));
const CA_PROV_ABBR = Object.fromEntries(Object.entries(CA_PROVINCES).map(([k, v]) => [k, v[1]]));
const STATCAN = 'https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer';

// region: how to get the region label for each area, as a mapshaper expression built from fields.
//   { field, map }   label = map[field]        { field }   label = field value
//   { codeDigit: n, map }  label = map[first n characters of the code]
// hint: optional field whose value (lower-cased) is a state/province abbreviation for pasted lists.
const COUNTRIES = {
  AU: {
    name: 'Australia',
    credit: 'Australian Bureau of Statistics (ASGS 2021), CC BY 4.0',
    postcode: { ds: 'poa', re: '^\\d{3,4}$', pad: 4 },
    hints: { nsw: 'nsw_act', act: 'nsw_act', vic: 'victoria', qld: 'queensland', sa: 'south_australia', wa: 'western_australia', tas: 'tasmania', nt: 'northern_territory' },
    datasets: {
      sal: {
        label: 'Suburbs',
        kind: 'area',
        source: { zip: process.env.SAL_URL || ABS + 'SAL_2021_AUST_GDA2020_SHP.zip' },
        code: /^SAL_CODE\d{2,4}$/,
        name: /^SAL_NAME\d{2,4}$/,
        region: {
          field: /^STE_NAME\d{2,4}$/,
          map: {
            'New South Wales': 'NSW & ACT', 'Australian Capital Territory': 'NSW & ACT', Victoria: 'Victoria',
            Queensland: 'Queensland', 'South Australia': 'South Australia', 'Western Australia': 'Western Australia',
            Tasmania: 'Tasmania', 'Northern Territory': 'Northern Territory',
          },
          other: 'Other Territories',
        },
      },
      poa: {
        label: 'Postcodes',
        kind: 'postcode',
        source: { zip: process.env.POA_URL || ABS + 'POA_2021_AUST_GDA2020_SHP.zip' },
        code: /^POA_CODE\d{2,4}$/,
        name: /^POA_CODE\d{2,4}$/,
        region: {
          codeDigit: 1,
          map: { 0: 'Northern Territory', 2: 'NSW & ACT', 3: 'Victoria', 4: 'Queensland', 5: 'South Australia', 6: 'Western Australia', 7: 'Tasmania' },
          other: 'Other Territories',
        },
      },
    },
  },
  US: {
    name: 'United States',
    credit: 'US Census Bureau cartographic boundary files (public domain)',
    postcode: { ds: 'uszip', re: '^\\d{5}(-\\d{4})?$', len: 5 },
    hints: {}, // filled from the data (state abbreviations)
    datasets: {
      usplace: {
        label: 'Cities & towns',
        kind: 'area',
        source: { zip: 'https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_place_500k.zip' },
        code: /^GEOID$/,
        name: /^NAME$/,
        region: { field: /^STUSPS$/, map: US_STATES },
        hint: /^STUSPS$/,
      },
      uszip: {
        label: 'ZIP codes',
        kind: 'postcode',
        source: { zip: 'https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip' },
        code: /^ZCTA5CE\d\d$/,
        name: /^ZCTA5CE\d\d$/,
        region: { codeDigit: 1, map: ZIP_GROUPS },
      },
    },
  },
  CA: {
    name: 'Canada',
    credit: 'Statistics Canada 2021 Census boundary files, Open Government Licence – Canada',
    postcode: { ds: 'cafsa', re: '^[A-Za-z]\\d[A-Za-z](\\d[A-Za-z]\\d)?$', len: 3, upper: true },
    hints: {},
    datasets: {
      cacsd: {
        label: 'Municipalities',
        kind: 'area',
        source: { arcgis: STATCAN, layer: /^CSD\b/i },
        code: /^CSDUID$/,
        name: /^CSDNAME$/,
        region: { field: /^PRUID$/, map: CA_PROV_NAME },
        hint: { field: /^PRUID$/, map: CA_PROV_ABBR },
      },
      cafsa: {
        label: 'Postal areas (FSA)',
        kind: 'postcode',
        source: { arcgis: STATCAN, layer: /^FSA\b/i },
        code: /^CFSAUID$/,
        name: /^CFSAUID$/,
        region: { field: /^PRUID$/, map: CA_PROV_NAME },
      },
    },
  },
  NZ: {
    name: 'New Zealand',
    credit: 'Land Information New Zealand (LINZ), CC BY 4.0',
    postcode: null, // NZ Post postcode boundaries aren't open data
    hints: {},
    datasets: {
      nzsal: {
        label: 'Suburbs & localities',
        kind: 'area',
        source: { arcgis: 'https://services.arcgis.com/xdsHIIxuCWByZiCB/ArcGIS/rest/services/LINZ_NZ_Suburbs_and_Localities/FeatureServer/0' },
        code: /^id$/,
        name: /^name$/,
        region: { field: /^territorial_authority$/, other: 'Other' },
      },
    },
  },
};

// ---------- args ----------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
}
const OUT = path.resolve(args.out || 'site/data');
const INTERVAL = Number(args.interval || 10); // simplification tolerance in metres
const CACHE = path.resolve('.cache');
const ONLY = args.only ? new Set(args.only.split(',')) : null;

// ---------- helpers ----------
// JSON with single quotes, so it can sit inside a double-quoted mapshaper expression.
const sq = (o) => JSON.stringify(o).replace(/'/g, '’').replace(/"/g, "'");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'other';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function getJson(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw new Error(`${e.message} (${url.slice(0, 160)})`);
      await new Promise((res) => setTimeout(res, 2000 * i));
    }
  }
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  using cached ${path.basename(dest)}`);
    return;
  }
  console.log(`  downloading ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText} (${url})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 2).toString() !== 'PK') throw new Error(`Not a zip file: ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log(`  ${(buf.length / 1e6).toFixed(1)} MB`);
}

// Downloads every feature of an ArcGIS layer as GeoJSON (WGS84), in batches of object ids.
async function arcgisToGeoJSON(source, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  using cached ${path.basename(dest)}`);
    return;
  }
  let layerUrl = source.arcgis;
  if (source.layer) {
    const svc = await getJson(`${source.arcgis}?f=json`);
    const layer = svc.layers.find((l) => source.layer.test(l.name));
    if (!layer) throw new Error(`No layer matching ${source.layer} in ${source.arcgis}: ${svc.layers.map((l) => l.name).join(', ')}`);
    layerUrl = `${source.arcgis}/${layer.id}`;
    console.log(`  layer ${layer.id} "${layer.name}"`);
  }
  const ids = (await getJson(`${layerUrl}/query?where=1%3D1&returnIdsOnly=true&f=json`)).objectIds || [];
  ids.sort((a, b) => a - b);
  console.log(`  ${ids.length} features from ${layerUrl}`);
  const out = fs.createWriteStream(dest + '.part');
  out.write('{"type":"FeatureCollection","features":[\n');
  let first = true;
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const body = new URLSearchParams({
      objectIds: batch.join(','),
      outFields: '*',
      outSR: '4326',
      geometryPrecision: '6',
      f: 'geojson',
    });
    const fc = await getJson(`${layerUrl}/query?${body}`);
    for (const f of fc.features || []) {
      out.write((first ? '' : ',\n') + JSON.stringify(f));
      first = false;
    }
    if ((i / BATCH) % 10 === 0) process.stdout.write(`  ${Math.min(i + BATCH, ids.length)}/${ids.length}\r`);
  }
  out.write('\n]}\n');
  await new Promise((r) => out.end(r));
  fs.renameSync(dest + '.part', dest);
  console.log(`  ${(fs.statSync(dest).size / 1e6).toFixed(1)} MB written`);
}

function findShp(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findShp(p);
      if (found) return found;
    } else if (/\.shp$/i.test(entry.name)) return p;
  }
  return null;
}

// Field names from a .dbf header (copes with 2021 / 2026 field suffixes).
function dbfFields(shpPath) {
  const buf = fs.readFileSync(shpPath.replace(/\.shp$/i, '.dbf'));
  const headerLen = buf.readUInt16LE(8);
  const fields = [];
  for (let off = 32; off + 32 <= headerLen && buf[off] !== 0x0d; off += 32) {
    fields.push(buf.toString('latin1', off, off + 11).replace(/\0.*$/, ''));
  }
  return fields;
}
// Field names from the first feature of a GeoJSON file.
function geojsonFields(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(200000);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const m = buf.toString('utf8', 0, n).match(/"properties"\s*:\s*(\{[^{}]*\})/);
  return m ? Object.keys(JSON.parse(m[1])) : [];
}

function pick(fields, re, what) {
  const f = fields.find((x) => re.test(x));
  if (!f) throw new Error(`Could not find ${what} field (${re}) in ${fields.join(', ')}`);
  return f;
}

function labelExpr(spec, fields, codeF) {
  const other = sq(spec.other || 'Other');
  if (spec.codeDigit) return `(${sq(spec.map)})[String(${codeF}).slice(0, ${spec.codeDigit})]||${other}`;
  const f = pick(fields, spec.field, 'region');
  return spec.map ? `(${sq(spec.map)})[String(${f})]||${other}` : `(${f} ? String(${f}) : ${other})`;
}

async function buildDataset(country, key, ds) {
  console.log(`\n${country} ${key}: ${ds.label}`);
  let input;
  if (args[key]) input = path.resolve(args[key]);
  else if (ds.source.zip) {
    input = path.join(CACHE, path.basename(new URL(ds.source.zip).pathname));
    await download(ds.source.zip, input);
  } else {
    input = path.join(CACHE, `${key}.geojson`);
    await arcgisToGeoJSON(ds.source, input);
  }
  if (/\.zip$/i.test(input)) {
    const tmp = path.join(CACHE, `unzipped-${key}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    execFileSync('unzip', ['-q', '-o', input, '-d', tmp]);
    input = findShp(tmp);
    if (!input) throw new Error(`No .shp in ${key} zip`);
  }
  const fields = /\.shp$/i.test(input) ? dbfFields(input) : geojsonFields(input);
  const codeF = pick(fields, ds.code, 'code');
  const nameF = pick(fields, ds.name, 'name');
  const parts = [`code=String(${codeF})`, `name=String(${nameF})`, `rlabel=${labelExpr(ds.region, fields, codeF)}`];
  parts.push(`region=rlabel.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')||'other'`);
  if (ds.hint) {
    const spec = ds.hint instanceof RegExp ? { field: ds.hint } : ds.hint;
    const f = pick(fields, spec.field, 'hint');
    parts.push(spec.map ? `hint=(${sq(spec.map)})[String(${f})]||''` : `hint=String(${f}||'')`);
  } else parts.push(`hint=''`);

  const work = path.join(CACHE, `work-${key}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const cmd = [
    `-i "${input}" ${/\.shp$/i.test(input) ? 'encoding=utf8' : ''}`,
    `-filter '!this.isNull'`,
    `-proj wgs84`,
    `-each "${parts.join(', ')}"`,
    `-filter-fields code,name,region,rlabel,hint`,
    `-simplify interval=${INTERVAL} keep-shapes`,
    `-clean`,
    `-split region`,
    `-o "${work}/" format=topojson quantization=1000000 bbox singles`,
  ].join(' ');
  await runCommands(cmd);

  const outDir = path.join(OUT, key);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const items = [];
  const regions = {};
  const hints = {};
  let total = 0;
  for (const file of fs.readdirSync(work).filter((f) => f.endsWith('.json'))) {
    const region = path.basename(file, '.json');
    const topo = JSON.parse(fs.readFileSync(path.join(work, file), 'utf8'));
    const obj = topo.objects[Object.keys(topo.objects)[0]];
    topo.objects = { areas: obj };
    let label = region;
    for (const g of obj.geometries) {
      const p = g.properties;
      label = p.rlabel;
      if (p.hint) hints[String(p.hint).toLowerCase()] = region;
      items.push([p.code, p.name, region]);
      g.properties = { code: p.code, name: p.name };
    }
    const json = JSON.stringify(topo);
    fs.writeFileSync(path.join(outDir, `${region}.json`), json);
    total += json.length;
    regions[region] = { label, count: obj.geometries.length, bbox: topo.bbox.map((n) => +n.toFixed(4)), bytes: json.length };
  }
  items.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  fs.writeFileSync(path.join(outDir, 'items.json'), JSON.stringify(items));
  const sorted = Object.fromEntries(Object.entries(regions).sort((a, b) => a[1].label.localeCompare(b[1].label)));
  console.log(`  ${items.length} areas in ${Object.keys(regions).length} files, ${(total / 1e6).toFixed(1)} MB`);
  return { meta: { country, label: ds.label, kind: ds.kind, regions: sorted }, hints };
}

// ---------- main ----------
const index = { built: new Date().toISOString(), countries: {}, datasets: {} };
const prevIndex = fs.existsSync(path.join(OUT, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8')) : null;
const failures = [];
for (const [cc, c] of Object.entries(COUNTRIES)) {
  const dsKeys = [];
  const hints = { ...c.hints };
  for (const [key, ds] of Object.entries(c.datasets)) {
    if (ONLY && !ONLY.has(key)) {
      if (prevIndex?.datasets?.[key]) {
        index.datasets[key] = prevIndex.datasets[key];
        Object.assign(hints, prevIndex.countries?.[cc]?.hints || {});
        dsKeys.push(key);
      }
      continue;
    }
    try {
      const { meta, hints: h } = await buildDataset(cc, key, ds);
      index.datasets[key] = meta;
      if (!Object.keys(c.hints).length) Object.assign(hints, h);
      dsKeys.push(key);
    } catch (e) {
      // One country's source being down shouldn't take the whole site down.
      console.error(`  FAILED ${cc} ${key}: ${e.message}`);
      failures.push(`${cc} ${key}`);
    }
  }
  if (!dsKeys.length) continue;
  const postcode = c.postcode && dsKeys.includes(c.postcode.ds) ? c.postcode : null;
  index.countries[cc] = { name: c.name, credit: c.credit, datasets: dsKeys, postcode, hints };
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
console.log(`\nWrote ${path.join(OUT, 'index.json')}`);
if (failures.length) console.log(`::warning::Some datasets failed and were left out: ${failures.join(', ')}`);
if (!index.countries.AU) process.exit(1);
