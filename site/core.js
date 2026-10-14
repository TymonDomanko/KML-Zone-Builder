// Core logic shared by the page and the tests: KML writing, list matching and search.
// No DOM access in this file.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KZB = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ---------- names ----------
  // ABS suburb names carry a state suffix when the name exists in more than one state: "Epping (NSW)", "Epping (Vic.)".
  const SUFFIX_RE = /\s*\(([^)]+)\)\s*$/;
  const STATE_ABBR = {
    nsw: 'nsw_act', act: 'nsw_act', vic: 'vic', qld: 'qld', sa: 'sa',
    wa: 'wa', tas: 'tas', nt: 'nt',
  };
  function baseName(name) {
    return name.replace(SUFFIX_RE, '');
  }
  function suffixState(name) {
    const m = name.match(SUFFIX_RE);
    if (!m) return null;
    // "(NSW)", "(Vic.)", "(Ballarat - Vic.)" -> "nsw", "vic", "vic"
    const st = m[1].replace(/\./g, '').trim().toLowerCase().match(/(nsw|act|vic|qld|sa|wa|tas|nt)$/);
    return st ? st[1] : null;
  }
  function norm(s) {
    return s.toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // ---------- index ----------
  // Turns data/index.json into a lookup used by search and list matching.
  function buildLookup(index) {
    const byId = new Map();
    const all = [];
    const salByName = new Map(); // normalised base name -> [item]
    for (const [ds, data] of Object.entries(index.datasets)) {
      for (const [code, name, region] of data.items) {
        const item = { id: `${ds}:${code}`, ds, code, name, region, key: norm(name), base: norm(baseName(name)) };
        byId.set(item.id, item);
        all.push(item);
        if (ds === 'sal') {
          if (!salByName.has(item.base)) salByName.set(item.base, []);
          salByName.get(item.base).push(item);
        }
      }
    }
    return { byId, all, salByName };
  }

  function search(lookup, query, limit = 12) {
    const q = norm(query);
    if (!q) return [];
    if (/^\d+$/.test(q)) {
      return lookup.all.filter((i) => i.ds === 'poa' && i.code.startsWith(q)).slice(0, limit);
    }
    const starts = [];
    const contains = [];
    for (const i of lookup.all) {
      if (i.ds !== 'sal') continue;
      if (i.key.startsWith(q)) starts.push(i);
      else if (i.key.includes(q)) contains.push(i);
      if (starts.length >= limit) break;
    }
    starts.sort((a, b) => (a.base === q ? -1 : 0) - (b.base === q ? -1 : 0));
    return starts.concat(contains).slice(0, limit);
  }

  // ---------- pasted lists ----------
  // Matches a pasted list of suburbs and/or postcodes.
  // "Epping", "Epping NSW", "Epping (Vic.)", "Epping 2121", "2121" are all understood.
  function matchList(lookup, text, preferredRegion) {
    const tokens = text.split(/[\n,;\t]+/).map((t) => t.trim()).filter(Boolean);
    const matched = [];
    const unmatched = [];
    const ambiguous = [];
    for (const token of tokens) {
      let t = token;
      // a bare postcode
      if (/^\d{3,4}$/.test(t)) {
        const code = t.padStart(4, '0');
        const item = lookup.byId.get(`poa:${code}`);
        if (item) matched.push(item);
        else unmatched.push(token);
        continue;
      }
      // pull off a trailing postcode and state, either bare or in brackets
      let state = null;
      t = t.replace(/\s+\d{4}$/, '');
      const sm = t.match(/^(.*?)[\s(]+(nsw|act|vic|qld|sa|wa|tas|nt)\.?\)?$/i);
      if (sm) {
        t = sm[1];
        state = sm[2].toLowerCase();
      }
      let candidates = lookup.salByName.get(norm(t)) || [];
      if (state && candidates.length > 1) {
        const bySuffix = candidates.filter((c) => suffixState(c.name) === state);
        const byRegion = candidates.filter((c) => c.region === STATE_ABBR[state]);
        candidates = bySuffix.length ? bySuffix : byRegion.length ? byRegion : candidates;
      } else if (state && candidates.length === 1 && candidates[0].region !== STATE_ABBR[state]) {
        candidates = [];
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
   * zones: [{ name, color, description, outline: Geometry|null, areas: [{ name, geom, description }] }]
 * outline is the combined outline (or null to leave it out); areas are the individual areas (may be empty).
   * options: { docName, folders (default true) }
   */
  function buildKml(zones, options = {}) {
    const folders = options.folders !== false;
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
    out.push(`<name>${esc(options.docName || 'Zones')}</name>`);
    zones.forEach((z, i) => {
      out.push(
        `<Style id="zone${i}"><LineStyle><color>${kmlColor(z.color, 1)}</color><width>3</width></LineStyle>` +
          `<PolyStyle><color>${kmlColor(z.color, 0.25)}</color></PolyStyle></Style>`,
        `<Style id="zone${i}area"><LineStyle><color>${kmlColor(z.color, 0.9)}</color><width>1.5</width></LineStyle>` +
          `<PolyStyle><color>${kmlColor(z.color, 0.12)}</color></PolyStyle></Style>`
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

  return { baseName, norm, buildLookup, search, matchList, buildKml, kmlColor, geometryKml };
});
