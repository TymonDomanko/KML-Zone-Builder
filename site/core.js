// Core logic shared by the page and the tests: KML writing, list matching and search.
// No DOM access in this file.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KZB = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ---------- names ----------
  // Some official names carry a region suffix when the name exists in more than one region:
  // "Epping (NSW)", "Epping (Vic.)", "Ascot (Ballarat - Vic.)".
  const SUFFIX_RE = /\s*\(([^)]+)\)\s*$/;
  function baseName(name) {
    return name.replace(SUFFIX_RE, '');
  }
  function suffixState(name) {
    const m = name.match(SUFFIX_RE);
    if (!m) return null;
    const st = m[1].replace(/\./g, '').trim().toLowerCase().match(/([a-z]+)$/);
    return st ? st[1] : null;
  }
  function norm(s) {
    return s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[’'`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ---------- lookup ----------
  // Items from data/<ds>/items.json, added dataset by dataset as countries are opened.
  function createLookup() {
    return { byId: new Map(), all: [], byName: new Map(), loaded: new Set() };
  }
  function addDataset(lookup, ds, kind, items) {
    if (lookup.loaded.has(ds)) return;
    lookup.loaded.add(ds);
    for (const [code, name, region] of items) {
      const item = { id: `${ds}:${code}`, ds, kind, code, name, region, key: norm(name), base: norm(baseName(name)) };
      lookup.byId.set(item.id, item);
      lookup.all.push(item);
      if (kind !== 'postcode') {
        if (!lookup.byName.has(item.base)) lookup.byName.set(item.base, []);
        lookup.byName.get(item.base).push(item);
      }
    }
  }
  // Old style: { datasets: { ds: { kind?, items } } } in one go (used by tests).
  function buildLookup(index) {
    const lookup = createLookup();
    for (const [ds, d] of Object.entries(index.datasets)) addDataset(lookup, ds, d.kind || (ds === 'poa' ? 'postcode' : 'area'), d.items);
    return lookup;
  }

  // Country settings used by search and list matching:
  // { datasets: [ds...], postcode: { ds, re, len, pad, upper } | null, hints: { abbr: regionKey } }
  const AU_CFG = {
    datasets: ['sal', 'poa'],
    postcode: { ds: 'poa', re: '^\\d{3,4}$', pad: 4 },
    hints: { nsw: 'nsw_act', act: 'nsw_act', vic: 'victoria', qld: 'queensland', sa: 'south_australia', wa: 'western_australia', tas: 'tasmania', nt: 'northern_territory' },
  };

  function postcodeCode(pc, token) {
    let t = token.replace(/\s+/g, '');
    if (!new RegExp(pc.re, 'i').test(t)) return null;
    if (pc.len) t = t.slice(0, pc.len);
    if (pc.pad) t = t.padStart(pc.pad, '0');
    if (pc.upper) t = t.toUpperCase();
    return t;
  }

  function search(lookup, query, cfg = AU_CFG, limit = 12) {
    const q = norm(query);
    if (!q) return [];
    const inCountry = (i) => cfg.datasets.includes(i.ds);
    const pc = cfg.postcode;
    const compact = query.replace(/\s+/g, '').toUpperCase();
    if (pc && /\d/.test(compact) && /^[A-Z0-9-]+$/.test(compact)) {
      const out = lookup.all.filter((i) => i.ds === pc.ds && i.code.toUpperCase().startsWith(compact.slice(0, pc.len || 99)));
      if (out.length) return out.slice(0, limit);
    }
    const starts = [];
    const contains = [];
    for (const i of lookup.all) {
      if (i.kind === 'postcode' || !inCountry(i)) continue;
      if (i.key.startsWith(q)) starts.push(i);
      else if (i.key.includes(q)) contains.push(i);
      if (starts.length >= limit * 3) break;
    }
    starts.sort((a, b) => (a.base === q ? 0 : 1) - (b.base === q ? 0 : 1));
    return starts.concat(contains).slice(0, limit);
  }

  // ---------- pasted lists ----------
  // Matches a pasted list of places and/or postcodes, e.g. (Australia)
  // "Epping", "Epping NSW", "Epping (Vic.)", "Epping 2121", "2121".
  function matchList(lookup, text, preferredRegion, cfg = AU_CFG) {
    const tokens = text.split(/[\n,;\t]+/).map((t) => t.trim()).filter(Boolean);
    const hints = cfg.hints || {};
    const hintKeys = Object.keys(hints).sort((a, b) => b.length - a.length);
    const hintRe = hintKeys.length ? new RegExp(`^(.*?)[\\s(]+(${hintKeys.map(escRe).join('|')})\\.?\\)?$`, 'i') : null;
    const matched = [];
    const unmatched = [];
    const ambiguous = [];
    for (const token of tokens) {
      // a postcode on its own
      if (cfg.postcode) {
        const code = postcodeCode(cfg.postcode, token);
        if (code) {
          const item = lookup.byId.get(`${cfg.postcode.ds}:${code}`);
          if (item) matched.push(item);
          else unmatched.push(token);
          continue;
        }
      }
      // pull off a trailing postcode and state/province, either bare or in brackets
      let t = token.replace(/\s+(\d{3,5}(-\d{4})?|[A-Za-z]\d[A-Za-z](\s?\d[A-Za-z]\d)?)$/, '');
      let state = null;
      const sm = hintRe && t.match(hintRe);
      if (sm && sm[1].trim()) {
        t = sm[1];
        state = sm[2].toLowerCase();
      }
      let candidates = (lookup.byName.get(norm(t)) || []).filter((c) => cfg.datasets.includes(c.ds));
      if (state) {
        const bySuffix = candidates.filter((c) => suffixState(c.name) === state);
        const byRegion = candidates.filter((c) => c.region === hints[state]);
        candidates = bySuffix.length ? bySuffix : byRegion;
      }
      if (candidates.length > 1 && preferredRegion) {
        const pref = candidates.filter((c) => c.region === preferredRegion);
        if (pref.length) candidates = pref;
      }
      if (candidates.length === 1) matched.push(candidates[0]);
      else if (candidates.length === 0) unmatched.push(token);
      else ambiguous.push({ token, options: candidates });
    }
    return { matched, unmatched, ambiguous };
  }

  // ---------- KML ----------
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  // "#rrggbb" + opacity -> KML "aabbggrr"
  function kmlColor(hex, opacity) {
    const h = hex.replace('#', '');
    const a = Math.round(opacity * 255).toString(16).padStart(2, '0');
    return (a + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toLowerCase();
  }
  function lineStyle(hex, opacity, width) {
    return `<LineStyle><color>${kmlColor(hex, opacity)}</color><width>${+width.toFixed(1)}</width></LineStyle>`;
  }
  function polyStyle(hex, opacity) {
    // opacity 0 means no shading at all
    return opacity > 0
      ? `<PolyStyle><color>${kmlColor(hex, opacity)}</color></PolyStyle>`
      : `<PolyStyle><fill>0</fill></PolyStyle>`;
  }
  function ringKml(ring) {
    const pts = ring.map((p) => `${+p[0].toFixed(6)},${+p[1].toFixed(6)},0`);
    const f = ring[0];
    const l = ring[ring.length - 1];
    if (f[0] !== l[0] || f[1] !== l[1]) pts.push(pts[0]);
    return `<LinearRing><coordinates>${pts.join(' ')}</coordinates></LinearRing>`;
  }
  function polygonKml(rings) {
    const [outer, ...holes] = rings;
    return (
      '<Polygon>' +
      `<outerBoundaryIs>${ringKml(outer)}</outerBoundaryIs>` +
      holes.map((h) => `<innerBoundaryIs>${ringKml(h)}</innerBoundaryIs>`).join('') +
      '</Polygon>'
    );
  }
  function geometryKml(geom) {
    if (!geom) return '';
    if (geom.type === 'Polygon') return polygonKml(geom.coordinates);
    if (geom.type === 'MultiPolygon') {
      const polys = geom.coordinates.filter((p) => p.length && p[0].length >= 3);
      if (polys.length === 1) return polygonKml(polys[0]);
      return `<MultiGeometry>${polys.map(polygonKml).join('')}</MultiGeometry>`;
    }
    throw new Error('Unsupported geometry ' + geom.type);
  }
  function placemark(name, styleId, geom, description) {
    return (
      `<Placemark><name>${esc(name)}</name>` +
      (description ? `<description>${esc(description)}</description>` : '') +
      `<styleUrl>#${styleId}</styleUrl>${geometryKml(geom)}</Placemark>`
    );
  }

  /**
   * zones: [{ name, color (outline), fill (shading colour), fillOpacity (0–1), width (outline px), description, outline: Geometry|null, areas: [{ name, geom, description }] }]
 * outline is the combined outline (or null to leave it out); areas are the individual areas (may be empty).
   * options: { docName, folders (default true) }
   */
  function buildKml(zones, options = {}) {
    const folders = options.folders !== false;
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
    out.push(`<name>${esc(options.docName || 'Zones')}</name>`);
    if (options.description) out.push(`<description>${esc(options.description)}</description>`);
    zones.forEach((z, i) => {
      const fill = z.fill || z.color;
      const op = z.fillOpacity == null ? 0.25 : Math.max(0, Math.min(1, z.fillOpacity));
      const width = z.width || 3;
      out.push(
        `<Style id="zone${i}">${lineStyle(z.color, 1, width)}${polyStyle(fill, op)}</Style>`,
        // individual areas: same colours, thinner line and half the shading so they read under the outline
        `<Style id="zone${i}area">${lineStyle(z.color, 0.9, Math.max(1, width / 2))}${polyStyle(fill, op / 2)}</Style>`
      );
    });
    zones.forEach((z, i) => {
      const parts = [];
      if (z.outline) {
        parts.push(placemark(z.name, `zone${i}`, z.outline, z.description));
      }
      const areaMarks = (z.areas || []).map((a) => placemark(a.name, `zone${i}area`, a.geom, a.description));
      if (folders) {
        out.push(`<Folder><name>${esc(z.name)}</name>`);
        out.push(...parts);
        if (areaMarks.length) {
          if (z.outline) out.push(`<Folder><name>${esc(z.name)} – areas</name>${areaMarks.join('')}</Folder>`);
          else out.push(...areaMarks);
        }
        out.push('</Folder>');
      } else {
        out.push(...parts, ...areaMarks);
      }
    });
    out.push('</Document></kml>');
    return out.join('\n');
  }

  // ---------- OpenStreetMap ----------
  const PLACE_RE = /^(suburb|quarter|neighbourhood|town|village|city|borough|hamlet|locality)$/;

  // Which kind of boundary an OSM relation is, as a key the page can group by.
  function osmKind(tags) {
    if (!tags) return null;
    if (tags.boundary === 'postal_code') return 'postal';
    if (tags.boundary === 'administrative' && tags.admin_level) return `admin:${tags.admin_level}`;
    if (tags.place && PLACE_RE.test(tags.place)) return `place:${tags.place}`;
    return null;
  }
  function osmKindLabel(kind) {
    if (kind === 'postal') return 'Postcodes';
    if (kind.startsWith('admin:')) return `Admin level ${kind.slice(6)}`;
    if (kind.startsWith('place:')) {
      const p = kind.slice(6);
      return `Places: ${p}s`.replace('ys', 'ies').replace('hs', 'hes');
    }
    return kind;
  }
  function osmName(tags) {
    const pc = tags.postal_code || (tags.boundary === 'postal_code' ? tags.ref : null);
    const name = tags['name:en'] || tags.name;
    if (pc && name && name !== pc) return `${pc} ${name}`;
    return pc || name || tags.ref || 'Unnamed';
  }

  // Groups relations from an Overpass "out tags" reply into boundary kinds, most local first.
  function summariseOsm(elements) {
    const groups = new Map();
    for (const e of elements) {
      const kind = osmKind(e.tags);
      if (!kind) continue;
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(osmName(e.tags));
    }
    const rank = (k) => (k === 'postal' ? 100 : k.startsWith('admin:') ? 50 + Number(k.slice(6)) : 40);
    return [...groups.entries()]
      .map(([key, names]) => ({ key, label: osmKindLabel(key), count: names.length, examples: names.sort().slice(0, 3) }))
      .sort((a, b) => rank(b.key) - rank(a.key));
  }

  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  function roundGeom(geom) {
    if (!geom) return geom;
    const ring = (r) => r.map((p) => [r6(p[0]), r6(p[1])]);
    if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(ring) };
    if (geom.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geom.coordinates.map((p) => p.map(ring)) };
    return null;
  }

  function pointInRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Joins way segments (arrays of [lon, lat]) end to end into closed rings.
  function joinRings(ways) {
    const key = (p) => `${p[0]},${p[1]}`;
    const left = ways.filter((w) => w.length >= 2).map((w) => w.slice());
    const rings = [];
    while (left.length) {
      let ring = left.shift();
      let guard = 0;
      while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 100000) {
        const end = key(ring[ring.length - 1]);
        const i = left.findIndex((w) => key(w[0]) === end || key(w[w.length - 1]) === end);
        if (i < 0) break;
        let w = left.splice(i, 1)[0];
        if (key(w[0]) !== end) w = w.reverse();
        ring = ring.concat(w.slice(1));
      }
      if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring);
    }
    return rings;
  }

  // Builds a GeoJSON (Multi)Polygon from an Overpass relation returned with "out geom".
  function assembleRelation(rel) {
    const outer = [];
    const inner = [];
    for (const m of rel.members || []) {
      if (m.type !== 'way' || !m.geometry) continue;
      const coords = m.geometry.filter(Boolean).map((g) => [r6(g.lon), r6(g.lat)]);
      (m.role === 'inner' ? inner : outer).push(coords);
    }
    const outers = joinRings(outer);
    if (!outers.length) return null;
    const polys = outers.map((r) => [r]);
    for (const hole of joinRings(inner)) {
      const owner = polys.find((p) => pointInRing(hole[0], p[0]));
      if (owner) owner.push(hole);
    }
    return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  }

  return {
    baseName, norm, createLookup, addDataset, buildLookup, postcodeCode, search, matchList, buildKml, kmlColor, geometryKml,
    osmKind, osmKindLabel, osmName, summariseOsm, assembleRelation, roundGeom,
  };
});
