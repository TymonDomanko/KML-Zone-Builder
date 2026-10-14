#!/usr/bin/env node
// Builds the boundary data used by the site from ABS digital boundary files.
//
//   node scripts/build-data.mjs [--sal file.zip] [--poa file.zip] [--out site/data] [--interval 10]
//
// With no --sal/--poa arguments the zips are downloaded from the ABS (and cached in .cache/).
// Output per dataset: data/<dataset>/<region>.json (TopoJSON, object "areas")
// plus data/index.json (search index of every area).

import mapshaper from 'mapshaper';
const { runCommands } = mapshaper;
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ABS_BASE =
  'https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-3-july-2021-june-2026/access-and-downloads/digital-boundary-files/';

const DATASETS = {
  sal: {
    label: 'Suburbs & localities',
    url: process.env.SAL_URL || ABS_BASE + 'SAL_2021_AUST_GDA2020_SHP.zip',
    code: /^SAL_CODE\d{2,4}$/,
    name: /^SAL_NAME\d{2,4}$/,
    state: /^STE_NAME\d{2,4}$/,
  },
  poa: {
    label: 'Postcodes (ABS Postal Areas)',
    url: process.env.POA_URL || ABS_BASE + 'POA_2021_AUST_GDA2020_SHP.zip',
    code: /^POA_CODE\d{2,4}$/,
    name: /^POA_NAME\d{2,4}$/,
    state: null, // region comes from the first digit of the postcode
  },
};

// Regions the data is split into. NSW and ACT share a file so Canberra/Queanbeyan zones merge cleanly.
const REGIONS = {
  nsw_act: 'NSW & ACT',
  vic: 'Victoria',
  qld: 'Queensland',
  sa: 'South Australia',
  wa: 'Western Australia',
  tas: 'Tasmania',
  nt: 'Northern Territory',
  ot: 'Other Territories',
};
const STATE_TO_REGION = {
  'New South Wales': 'nsw_act',
  'Australian Capital Territory': 'nsw_act',
  Victoria: 'vic',
  Queensland: 'qld',
  'South Australia': 'sa',
  'Western Australia': 'wa',
  Tasmania: 'tas',
  'Northern Territory': 'nt',
};
const POSTCODE_TO_REGION = { 0: 'nt', 2: 'nsw_act', 3: 'vic', 4: 'qld', 5: 'sa', 6: 'wa', 7: 'tas' };

// ---------- args ----------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
}
const OUT = path.resolve(args.out || 'site/data');
const INTERVAL = Number(args.interval || 10); // simplification tolerance in metres
const CACHE = path.resolve('.cache');
const only = args.only ? args.only.split(',') : Object.keys(DATASETS);

// ---------- helpers ----------
// JSON with single quotes, so it can sit inside a double-quoted mapshaper expression.
const sq = (o) => JSON.stringify(o).replace(/"/g, "'");

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`Using cached ${path.basename(dest)}`);
    return;
  }
  console.log(`Downloading ${url}`);
  const res = await fetch(url, {
    headers: {
      // The ABS site rejects some non-browser clients.
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: '*/*',
    },
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText} (${url})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 2).toString() !== 'PK') throw new Error(`Not a zip file: ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log(`  ${(buf.length / 1e6).toFixed(1)} MB`);
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

// Read field names from a .dbf header (so the script copes with 2021 / 2026 field suffixes).
function dbfFields(shpPath) {
  const dbf = shpPath.replace(/\.shp$/i, '.dbf');
  const buf = fs.readFileSync(dbf);
  const headerLen = buf.readUInt16LE(8);
  const fields = [];
  for (let off = 32; off + 32 <= headerLen && buf[off] !== 0x0d; off += 32) {
    fields.push(buf.toString('latin1', off, off + 11).replace(/\0.*$/, ''));
  }
  return fields;
}

function pick(fields, re, what) {
  const f = fields.find((x) => re.test(x));
  if (!f) throw new Error(`Could not find ${what} field (${re}) in ${fields.join(', ')}`);
  return f;
}

async function buildDataset(key) {
  const ds = DATASETS[key];
  let zip = args[key];
  if (!zip) {
    zip = path.join(CACHE, path.basename(new URL(ds.url).pathname));
    await download(ds.url, zip);
  }
  const tmp = path.join(CACHE, `unzipped-${key}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  execFileSync('unzip', ['-q', '-o', path.resolve(zip), '-d', tmp]);
  const shp = findShp(tmp);
  if (!shp) throw new Error(`No .shp found in ${zip}`);

  const fields = dbfFields(shp);
  const codeF = pick(fields, ds.code, 'code');
  const nameF = pick(fields, ds.name, 'name');
  let regionExpr;
  if (ds.state) {
    const steF = pick(fields, ds.state, 'state');
    regionExpr = `region=(${sq(STATE_TO_REGION)})[${steF}]||'ot'`;
  } else {
    regionExpr = `region=(${sq(POSTCODE_TO_REGION)})[String(${codeF}).charAt(0)]||'ot'`;
  }

  const outDir = path.join(OUT, key);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const work = path.join(CACHE, `work-${key}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const cmd = [
    `-i "${shp}" encoding=utf8`,
    `-filter '!this.isNull'`,
    `-each "code=String(${codeF}), name=String(${nameF}), ${regionExpr}"`,
    `-filter-fields code,name,region`,
    `-simplify interval=${INTERVAL} keep-shapes`,
    `-clean`,
    `-split region`,
    `-filter-fields code,name`,
    `-o "${work}/" format=topojson quantization=1000000 bbox singles`,
  ].join(' ');
  console.log(`mapshaper ${cmd}`);
  await runCommands(cmd);

  const items = [];
  const regions = {};
  for (const file of fs.readdirSync(work).filter((f) => f.endsWith('.json'))) {
    const region = path.basename(file, '.json');
    if (!REGIONS[region]) throw new Error(`Unexpected region "${region}"`);
    const topo = JSON.parse(fs.readFileSync(path.join(work, file), 'utf8'));
    const objKey = Object.keys(topo.objects)[0];
    const obj = topo.objects[objKey];
    topo.objects = { areas: obj };
    for (const g of obj.geometries) {
      items.push([g.properties.code, g.properties.name, region]);
    }
    const json = JSON.stringify(topo);
    fs.writeFileSync(path.join(outDir, `${region}.json`), json);
    regions[region] = { count: obj.geometries.length, bbox: topo.bbox.map((n) => +n.toFixed(4)), bytes: json.length };
    console.log(`  ${key}/${region}.json  ${obj.geometries.length} areas  ${(json.length / 1e6).toFixed(2)} MB`);
  }
  items.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  return { label: ds.label, source: ds.url, regions, items };
}

// ---------- main ----------
const index = { built: new Date().toISOString(), regions: REGIONS, datasets: {} };
for (const key of only) {
  if (!DATASETS[key]) throw new Error(`Unknown dataset ${key}`);
  index.datasets[key] = await buildDataset(key);
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
console.log(`Wrote ${path.join(OUT, 'index.json')}`);
