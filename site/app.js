/* global L, topojson, turf, KZB */
(() => {
  'use strict';

  // Deploys stamp ?v=<commit> on this script; reuse it so fresh data isn't hidden behind the browser cache.
  const VERSION = (document.currentScript?.src.match(/[?&]v=([^&]+)/) || [])[1] || 'dev';

  const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa5b5', '#d6249f', '#808000', '#9a6324', '#000075'];
  const STORE_KEY = 'kml-zone-builder:project';
  const PASTE_EXAMPLES = {
    AU: 'Epping, Carlingford, Beecroft\n2121\nEpping VIC',
    US: 'Evanston, Skokie\n60601\nSpringfield IL',
    CA: 'Toronto, Mississauga\nM5V\nRichmond BC',
    NZ: 'Ponsonby, Grey Lynn\nRiverside',
  };
  const dsLabel = (ds) => (ds === 'osm' ? 'OpenStreetMap' : index.datasets[ds]?.label || ds);
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://lambert.openstreetmap.de/api/interpreter',
    'https://gall.openstreetmap.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  // ISO 3166-1 alpha-2 codes; names come from the browser.
  const COUNTRY_CODES =
    'AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'.split(' ');

  // ---------- state ----------
  const state = {
    zones: [],
    activeId: null,
    ds: 'sal',
    region: 'nsw_act',
    country: 'AU', // countries in data/index.json use official data; anything else uses OpenStreetMap
    osm: {}, // OSM areas used in zones: id -> { name, kind, detail, geom }
    osmKind: null,
    settings: { fileName: 'zones', folders: true, stripState: true },
  };
  let index = null; // data/index.json
  const lookup = KZB.createLookup(); // filled per dataset as countries are opened
  const regionCache = new Map(); // "ds/region" -> Promise<{ topo, geoms: Map(code -> topo geometry), features: Map(code -> GeoJSON) }>
  let membership = new Map(); // item id -> [zone ids]
  const osmLoaded = new Map(); // OSM areas currently shown on the map: id -> GeoJSON feature
  // true when the current country has official (prebuilt) boundaries
  const hasOfficial = () => !!(index && index.countries[state.country]);
  const countryCfg = () => index.countries[state.country];
  const regionLabel = (item) => index.datasets[item.ds]?.regions[item.region]?.label || item.region;
  const countryOfDs = (ds) => index.datasets[ds]?.country;

  // Loads the search items for these datasets (once each).
  const itemLoads = new Map();
  function ensureItems(dsList) {
    return Promise.all(
      [...new Set(dsList)]
        .filter((ds) => index.datasets[ds])
        .map((ds) => {
          if (!itemLoads.has(ds)) {
            const p = fetch(`data/${ds}/items.json?v=${VERSION}`)
              .then((r) => {
                if (!r.ok) throw new Error(`Could not load ${ds} names`);
                return r.json();
              })
              .then((items) => KZB.addDataset(lookup, ds, index.datasets[ds].kind, items));
            p.catch(() => itemLoads.delete(ds));
            itemLoads.set(ds, p);
          }
          return itemLoads.get(ds);
        })
    );
  }

  // ---------- dom ----------
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  };
  let toastTimer;
  function toast(msg, ms = 3000) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  // ---------- map ----------
  const map = L.map('map', { preferCanvas: true, zoomControl: true }).setView([-33.77, 151.08], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  }).addTo(map);
  const renderer = L.canvas({ padding: 0.5, tolerance: 3 });
  let areaLayer = null; // L.GeoJSON of the boundaries being shown
  const layerByCode = new Map();
  const outlineLayer = L.layerGroup().addTo(map);
  window.KZBApp = { map, state, layers: () => ({ areaLayer, outlineLayer }) }; // handy for debugging

  // ---------- data ----------
  async function loadIndex() {
    const res = await fetch(`data/index.json?v=${VERSION}`);
    if (!res.ok) throw new Error('Boundary data not found (data/index.json). Has the data build run?');
    index = await res.json();
    if (index.built) $('#built').textContent = ` Data built ${index.built.slice(0, 10)}.`;
  }

  function loadRegion(ds, region) {
    const key = `${ds}/${region}`;
    if (!regionCache.has(key)) {
      const p = fetch(`data/${ds}/${region}.json?v=${VERSION}`)
        .then((r) => {
          if (!r.ok) throw new Error(`Could not load ${key}`);
          return r.json();
        })
        .then((topo) => {
          const geoms = new Map();
          for (const g of topo.objects.areas.geometries) geoms.set(g.properties.code, g);
          const features = new Map();
          for (const f of topojson.feature(topo, topo.objects.areas).features) features.set(f.properties.code, f);
          return { topo, geoms, features };
        });
      p.catch(() => regionCache.delete(key));
      regionCache.set(key, p);
    }
    return regionCache.get(key);
  }

  function getItem(id) {
    if (id.startsWith('osm:')) {
      const o = state.osm[id];
      return o ? { id, ds: 'osm', region: 'osm', code: id, name: o.name, kind: o.kind, detail: o.detail } : null;
    }
    return lookup.byId.get(id) || null;
  }
  // datasets referenced by items in any zone
  function zoneDatasets() {
    return [...new Set(state.zones.flatMap((z) => z.items.map((id) => id.split(':')[0])).filter((ds) => ds !== 'osm'))];
  }
  function itemsOf(zone) {
    return zone.items.map(getItem).filter(Boolean);
  }
  function itemPlace(item) {
    if (item.ds === 'osm') return item.detail || item.kind || '';
    const cc = countryOfDs(item.ds);
    return cc === state.country ? regionLabel(item) : `${regionLabel(item)}, ${index.countries[cc]?.name || cc}`;
  }

  // Combined outline of a zone. Areas from the same file are merged on their shared topology,
  // so neighbouring areas join without slivers. Different files (state borders, or suburbs mixed
  // with postcodes) are then unioned geometrically.
  async function zoneOutline(zone) {
    const groups = new Map();
    const osmParts = [];
    for (const item of itemsOf(zone)) {
      if (item.ds === 'osm') {
        osmParts.push(state.osm[item.id].geom);
        continue;
      }
      const key = `${item.ds}/${item.region}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    if (!groups.size && !osmParts.length) return null;
    const parts = [];
    for (const [key, items] of groups) {
      const [ds, region] = key.split('/');
      const data = await loadRegion(ds, region);
      const geoms = items.map((i) => data.geoms.get(i.code)).filter(Boolean);
      parts.push(topojson.merge(data.topo, geoms));
    }
    parts.push(...osmParts);
    if (parts.length === 1) return parts[0];
    if (typeof turf === 'undefined') throw new Error('Geometry library still loading — try again in a moment.');
    const merged = turf.union(turf.featureCollection(parts.map((g) => turf.feature(g))));
    return merged ? merged.geometry : null;
  }

  async function areaGeometry(item) {
    if (item.ds === 'osm') return state.osm[item.id]?.geom || null;
    const data = await loadRegion(item.ds, item.region);
    const f = data.features.get(item.code);
    return f ? f.geometry : null;
  }

  // ---------- zones ----------
  function activeZone() {
    return state.zones.find((z) => z.id === state.activeId) || null;
  }
  function newZone(name) {
    const used = new Set(state.zones.map((z) => z.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[state.zones.length % COLORS.length];
    const zone = {
      id: Math.random().toString(36).slice(2, 10),
      name: name || `Zone ${state.zones.length + 1}`,
      color,
      fill: color,
      fillOpacity: 0.25,
      width: 3,
      items: [],
      outline: true,
      individual: true,
    };
    state.zones.push(zone);
    state.activeId = zone.id;
    return zone;
  }
  function ensureActive() {
    return activeZone() || newZone();
  }
  function addItems(zone, items) {
    let added = 0;
    for (const item of items) {
      if (!zone.items.includes(item.id)) {
        zone.items.push(item.id);
        added++;
      }
    }
    return added;
  }
  function itemLabel(item, forExport) {
    if (item.kind === 'postcode') return item.code;
    if (item.ds === 'osm') return item.name;
    return forExport && state.settings.stripState ? KZB.baseName(item.name) : item.name;
  }

  function changed() {
    membership = new Map();
    for (const z of state.zones) {
      for (const id of z.items) {
        if (!membership.has(id)) membership.set(id, []);
        membership.get(id).push(z.id);
      }
    }
    save();
    renderZones();
    restyleAreas();
    refreshOutlines();
  }

  // ---------- persistence ----------
  function projectData() {
    // keep only the OSM areas that are still in a zone
    const used = new Set(state.zones.flatMap((z) => z.items));
    for (const id of Object.keys(state.osm)) if (!used.has(id)) delete state.osm[id];
    return { app: 'kml-zone-builder', version: 2, zones: state.zones, activeId: state.activeId, settings: state.settings, osm: state.osm };
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...projectData(), ds: state.ds, region: state.region, country: state.country, osmKind: state.osmKind }));
    } catch (e) {
      /* storage unavailable — fine */
    }
  }
  function applyProject(p) {
    if (!p || !Array.isArray(p.zones)) throw new Error('Not a KML Zone Builder project');
    state.osm = {};
    for (const [id, o] of Object.entries(p.osm || {})) {
      if (/^osm:[nwr]\d+$/.test(id) && o && o.geom && /^(Multi)?Polygon$/.test(o.geom.type)) {
        state.osm[id] = { name: String(o.name || id), kind: String(o.kind || ''), detail: String(o.detail || ''), geom: o.geom };
      }
    }
    state.zones = p.zones
      .filter((z) => z && Array.isArray(z.items))
      .map((z, i) => ({
        id: String(z.id || Math.random().toString(36).slice(2, 10)),
        name: String(z.name || `Zone ${i + 1}`),
        color: /^#[0-9a-f]{6}$/i.test(z.color) ? z.color : COLORS[i % COLORS.length],
        fill: /^#[0-9a-f]{6}$/i.test(z.fill) ? z.fill : /^#[0-9a-f]{6}$/i.test(z.color) ? z.color : COLORS[i % COLORS.length],
        fillOpacity: Number.isFinite(z.fillOpacity) ? Math.max(0, Math.min(1, z.fillOpacity)) : 0.25,
        width: Number.isFinite(z.width) ? Math.max(1, Math.min(10, z.width)) : 3,
        items: z.items.filter((id) => typeof id === 'string' && (!id.startsWith('osm:') || state.osm[id])),
        outline: z.outline !== false,
        individual: z.individual !== false,
      }));
    state.activeId = state.zones.some((z) => z.id === p.activeId) ? p.activeId : state.zones[0]?.id || null;
    if (p.settings) Object.assign(state.settings, p.settings);
    if (p.ds && index.datasets[p.ds]) state.ds = p.ds;
    if (p.region && index.datasets[state.ds].regions[p.region]) state.region = p.region;
    if (p.country && COUNTRY_CODES.includes(p.country)) state.country = p.country;
    if (p.osmKind) state.osmKind = p.osmKind;
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) applyProject(JSON.parse(raw));
    } catch (e) {
      /* ignore a bad saved project */
    }
  }

  // ---------- area layer ----------
  function styleFor(feature) {
    const id = feature.properties.id || `${state.ds}:${feature.properties.code}`;
    const zones = membership.get(id) || [];
    const active = activeZone();
    if (active && zones.includes(active.id)) {
      return { color: active.color, weight: 1.4, opacity: 1, dashArray: null, fillColor: active.fill, fillOpacity: 0.15 };
    }
    if (zones.length) {
      const other = state.zones.find((z) => z.id === zones[0]);
      return { color: other ? other.color : '#555', weight: 1, opacity: 0.7, dashArray: '5 3', fillColor: '#000', fillOpacity: 0.01 };
    }
    return { color: '#1f2a44', weight: 1.1, opacity: 0.75, dashArray: '5 3', fillColor: '#000', fillOpacity: 0.01 };
  }
  function restyleAreas() {
    if (!areaLayer) return;
    areaLayer.eachLayer((l) => l.setStyle(styleFor(l.feature)));
  }

  let showToken = 0;
  async function showRegion(fit) {
    const token = ++showToken;
    const ds = state.ds;
    const region = state.region;
    const data = await loadRegion(ds, region);
    if (token !== showToken || !hasOfficial()) return;
    if (areaLayer) map.removeLayer(areaLayer);
    layerByCode.clear();
    areaLayer = L.geoJSON(
      { type: 'FeatureCollection', features: [...data.features.values()] },
      {
        renderer,
        style: styleFor,
        onEachFeature: (feature, layer) => {
          layerByCode.set(feature.properties.code, layer);
          layer.bindTooltip(feature.properties.name, { sticky: true, direction: 'top', offset: [0, -6] });
          layer.on('mouseover', () => layer.setStyle({ weight: 3 }));
          layer.on('mouseout', () => layer.setStyle(styleFor(feature)));
          layer.on('click', () => toggleArea(`${ds}:${feature.properties.code}`));
        },
      }
    ).addTo(map);
    outlineLayer.eachLayer((l) => l.bringToFront && l.bringToFront());
    if (fit) {
      const b = index.datasets[ds].regions[region].bbox;
      map.fitBounds([[b[1], b[0]], [b[3], b[2]]]);
    }
  }

  function toggleArea(id) {
    const zone = ensureActive();
    const i = zone.items.indexOf(id);
    if (id.startsWith('osm:') && !state.osm[id]) {
      const f = osmLoaded.get(id);
      if (!f) return;
      state.osm[id] = { name: f.properties.name, kind: f.properties.kind, detail: f.properties.detail, geom: f.geometry };
    }
    const item = getItem(id);
    if (i >= 0) {
      zone.items.splice(i, 1);
      toast(`Removed ${item ? item.name : id} from ${zone.name}`, 1500);
    } else {
      zone.items.push(id);
      toast(`Added ${item ? item.name : id} to ${zone.name}`, 1500);
    }
    changed();
  }

  // ---------- zone outlines on the map ----------
  let outlineTimer;
  function refreshOutlines() {
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(drawOutlines, 120);
  }
  let outlineToken = 0;
  async function drawOutlines() {
    const token = ++outlineToken;
    const layers = [];
    for (const z of state.zones) {
      try {
        const g = await zoneOutline(z);
        if (!g) continue;
        const active = z.id === state.activeId;
        layers.push(
          L.geoJSON(g, {
            renderer,
            interactive: false,
            style: {
              color: z.color,
              weight: active ? z.width + 1 : z.width,
              opacity: 0.95,
              fill: z.fillOpacity > 0,
              fillColor: z.fill,
              fillOpacity: z.fillOpacity,
              dashArray: active ? null : '6 5',
            },
          })
        );
      } catch (e) {
        console.warn(e);
      }
    }
    if (token !== outlineToken) return;
    outlineLayer.clearLayers();
    layers.forEach((l) => outlineLayer.addLayer(l));
  }

  async function zoomToZone(zone) {
    const g = await zoneOutline(zone);
    if (!g) return toast('This zone has no areas yet');
    map.fitBounds(L.geoJSON(g).getBounds(), { padding: [30, 30] });
  }

  async function goToItem(item) {
    if (item.ds === 'osm') {
      const g = state.osm[item.id]?.geom;
      if (g) map.fitBounds(L.geoJSON(g).getBounds(), { padding: [60, 60], maxZoom: 15 });
      return;
    }
    const cc = countryOfDs(item.ds);
    const switching = cc !== state.country;
    if (switching) {
      state.country = cc;
      await ensureItems(countryCfg().datasets);
      save();
    }
    if (switching || item.ds !== state.ds || item.region !== state.region) {
      state.ds = item.ds;
      state.region = item.region;
      syncControls();
      await showRegion(false);
    }
    const g = await areaGeometry(item);
    if (g) map.fitBounds(L.geoJSON(g).getBounds(), { padding: [60, 60], maxZoom: 15 });
  }

  // ---------- sidebar ----------
  function syncControls() {
    $('#country').value = state.country;
    $('#auControls').hidden = !hasOfficial();
    $('#osmControls').hidden = hasOfficial();
    if (hasOfficial()) {
      const cfg = countryCfg();
      if (!cfg.datasets.includes(state.ds)) state.ds = cfg.datasets[0];
      const regions = index.datasets[state.ds].regions;
      if (!regions[state.region]) {
        // start on the biggest region (by number of areas)
        const ranked = Object.entries(regions).filter(([, r]) => !/outside|other/i.test(r.label)).sort((a, b) => b[1].count - a[1].count);
        state.region = (ranked[0] || Object.entries(regions)[0])[0];
      }
      const names = cfg.datasets.map((ds) => index.datasets[ds].label.toLowerCase());
      $('#search').placeholder = `Search ${names.join(' or ')} to add…`;
      $('#auControls .seg').replaceChildren(
        ...cfg.datasets.map((ds) =>
          el(
            'button',
            {
              type: 'button',
              class: ds === state.ds ? 'on' : '',
              onclick: () => {
                if (state.ds === ds) return;
                state.ds = ds;
                syncControls();
                save();
                showRegion(false);
              },
            },
            index.datasets[ds].label
          )
        )
      );
      $('#region').replaceChildren(
        ...Object.entries(regions).map(([key, r]) =>
          el('option', { value: key, selected: key === state.region }, `${r.label} (${r.count.toLocaleString()})`)
        )
      );
    } else {
      $('#search').placeholder = 'Search a place or postcode to add…';
    }
    $('#fileName').value = state.settings.fileName;
    $('#folders').checked = state.settings.folders;
    $('#stripState').checked = state.settings.stripState;
  }

  function renderZones() {
    const wrap = $('#zones');
    if (!state.zones.length) {
      wrap.replaceChildren(el('p', { class: 'empty' }, 'No zones yet. Click the map or search to start one.'));
      return;
    }
    const openPaste = wrap.querySelector('details.paste[open]') ? true : false;
    const pasteText = wrap.querySelector('details.paste textarea')?.value || '';
    const pasteMsg = wrap.querySelector('details.paste .msg')?.innerHTML || '';
    wrap.replaceChildren(...state.zones.map((z) => zoneCard(z, { openPaste, pasteText, pasteMsg })));
  }

  function zoneCard(z, keep) {
    const active = z.id === state.activeId;
    const items = itemsOf(z);
    const card = el('div', {
      class: 'zone' + (active ? ' active' : ''),
      style: `--zc:${z.color}`,
      onclick: (e) => {
        if (active || e.target.closest('button,label,textarea,summary,a,input:not(.name)')) return;
        state.activeId = z.id;
        const focusName = e.target.classList.contains('name');
        changed();
        if (focusName) $('#zones .zone.active .name')?.focus();
      },
    });
    const swatch = el('span', { class: 'swatch', title: 'Outline and shading' });
    const paintSwatch = () => {
      swatch.style.borderColor = z.color;
      swatch.style.background = z.fillOpacity > 0 ? hexA(z.fill, z.fillOpacity) : 'transparent';
      card.style.setProperty('--zc', z.color);
    };
    paintSwatch();
    const head = el(
      'div',
      { class: 'zone-head' },
      swatch,
      el('input', {
        class: 'name',
        type: 'text',
        value: z.name,
        'aria-label': 'Zone name',
        onchange: (e) => {
          z.name = e.target.value.trim() || z.name;
          changed();
        },
      }),
      el('span', { class: 'count' }, `${items.length} ${items.length === 1 ? 'area' : 'areas'}`),
      el('button', { class: 'icon', type: 'button', title: 'Zoom to zone', onclick: () => zoomToZone(z) }, '⌖'),
      el('button', {
        class: 'icon',
        type: 'button',
        title: 'Duplicate zone',
        onclick: () => {
          const copy = newZone(`${z.name} copy`);
          copy.items = [...z.items];
          copy.outline = z.outline;
          copy.individual = z.individual;
          Object.assign(copy, { color: z.color, fill: z.fill, fillOpacity: z.fillOpacity, width: z.width });
          changed();
        },
      }, '⧉'),
      el('button', {
        class: 'icon',
        type: 'button',
        title: 'Delete zone',
        onclick: () => {
          if (z.items.length && !confirm(`Delete “${z.name}”?`)) return;
          state.zones = state.zones.filter((x) => x !== z);
          if (state.activeId === z.id) state.activeId = state.zones[0]?.id || null;
          changed();
        },
      }, '✕')
    );
    card.append(head);

    const body = el('div', { class: 'zone-body' });
    body.append(
      el(
        'div',
        { class: 'zone-opts' },
        el('label', {}, el('input', { type: 'checkbox', checked: z.outline, onchange: (e) => { z.outline = e.target.checked; save(); } }), 'Combined outline'),
        el('label', {}, el('input', { type: 'checkbox', checked: z.individual, onchange: (e) => { z.individual = e.target.checked; save(); } }), 'Each area as its own zone')
      ),
      styleControls(z, paintSwatch)
    );

    if (active) {
      const chips = el('div', { class: 'chips' });
      for (const item of items) {
        const others = (membership.get(item.id) || []).filter((id) => id !== z.id).length;
        chips.append(
          el(
            'span',
            { class: 'chip', title: `${dsLabel(item.ds)} · ${itemPlace(item)}` },
            el('a', { href: '#', style: 'color:inherit;text-decoration:none', onclick: (e) => { e.preventDefault(); goToItem(item); } }, item.name),
            others ? el('span', { class: 'also', title: `Also in ${others} other zone${others > 1 ? 's' : ''}` }, ` +${others}`) : null,
            el('button', { class: 'x', type: 'button', title: 'Remove', onclick: () => { z.items = z.items.filter((id) => id !== item.id); changed(); } }, '×')
          )
        );
      }
      if (items.length) body.append(chips);
      else body.append(el('p', { class: 'hint' }, 'Click areas on the map, search above, or paste a list.'));

      const msg = el('div', { class: 'msg' });
      msg.innerHTML = keep.pasteMsg;
      const ta = el('textarea', {
        placeholder: 'One per line or comma-separated, e.g.\n' + (PASTE_EXAMPLES[state.country] || 'Mitte, Moabit\n10115'),
      });
      ta.value = keep.pasteText;
      const paste = el(
        'details',
        { class: 'paste', open: keep.openPaste },
        el('summary', {}, 'Paste a list of suburbs or postcodes'),
        ta,
        el('button', { type: 'button', class: 'btn small', onclick: (e) => (hasOfficial() ? addPasted(z, ta, msg) : addPastedOsm(z, ta, msg, e.target)) }, 'Add to zone'),
        msg
      );
      body.append(paste);
    }

    body.append(
      el(
        'div',
        { class: 'zone-foot' },
        el('button', { type: 'button', class: 'btn small', onclick: () => downloadKml([z], z.name) }, 'Download this zone')
      )
    );
    card.append(body);
    return card;
  }

  // Outline colour + width, shading colour + opacity. Live preview while dragging, saved on release.
  function styleControls(z, paintSwatch) {
    const live = () => {
      paintSwatch();
      refreshOutlines();
    };
    const pct = el('span', { class: 'val' }, `${Math.round(z.fillOpacity * 100)}%`);
    const px = el('span', { class: 'val' }, `${z.width}px`);
    return el(
      'div',
      { class: 'zone-style' },
      el('label', { title: 'Outline colour' }, 'Outline',
        el('input', { type: 'color', value: z.color, oninput: (e) => { z.color = e.target.value; live(); }, onchange: () => changed() })),
      el('label', { title: 'Outline width' },
        el('input', { type: 'range', min: 1, max: 8, step: 0.5, value: z.width, oninput: (e) => { z.width = +e.target.value; px.textContent = `${z.width}px`; live(); }, onchange: () => save() }),
        px),
      el('label', { title: 'Shading colour' }, 'Shading',
        el('input', { type: 'color', value: z.fill, oninput: (e) => { z.fill = e.target.value; live(); }, onchange: () => changed() })),
      el('label', { title: 'Shading opacity (0% = no shading)' },
        el('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round(z.fillOpacity * 100), oninput: (e) => { z.fillOpacity = e.target.value / 100; pct.textContent = `${e.target.value}%`; live(); }, onchange: () => save() }),
        pct)
    );
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function addPasted(zone, ta, msg) {
    const res = KZB.matchList(lookup, ta.value, state.region, countryCfg());
    const added = addItems(zone, res.matched);
    msg.replaceChildren();
    msg.append(`Added ${added} area${added === 1 ? '' : 's'}${res.matched.length > added ? ` (${res.matched.length - added} already in zone)` : ''}.`);
    if (res.unmatched.length) {
      msg.append(el('br'), el('span', { class: 'bad' }, `Not found: ${res.unmatched.join(', ')}`));
    }
    for (const amb of res.ambiguous) {
      msg.append(el('br'), `“${amb.token}” matches several — pick: `);
      for (const opt of amb.options) {
        msg.append(
          el('button', {
            type: 'button',
            class: 'btn small pick',
            onclick: (e) => {
              addItems(zone, [opt]);
              e.target.disabled = true;
              changed();
            },
          }, opt.ds === 'osm' ? opt.name : `${opt.name} (${regionLabel(opt)})`)
        );
      }
    }
    // keep only what still needs attention in the box
    ta.value = [...res.unmatched, ...res.ambiguous.map((a) => a.token)].join('\n');
    changed();
  }

  // ---------- OpenStreetMap (countries other than Australia) ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function osmStatus(text) {
    $('#osmStatus').textContent = text;
  }

  // Overpass servers are run by volunteers and are often busy. Ask one; if it fails or hasn't answered
  // within a few seconds, also ask the next. The first good answer wins and the rest are cancelled.
  let overpassFirst = 0; // start with whichever server answered last time
  function overpass(query, { stagger = 8000, timeout = 90000 } = {}) {
    return new Promise((resolve, reject) => {
      const order = OVERPASS.map((_, i) => OVERPASS[(overpassFirst + i) % OVERPASS.length]);
      const controllers = [];
      const errors = [];
      let next = 0;
      let running = 0;
      let done = false;
      let staggerTimer;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        clearTimeout(staggerTimer);
        clearTimeout(overall);
        controllers.forEach((c) => c.abort());
        fn(v);
      };
      const overall = setTimeout(
        () => finish(reject, new Error('OpenStreetMap boundary servers are busy right now — try again in a minute, or zoom in to a smaller area.')),
        timeout
      );
      const launch = () => {
        clearTimeout(staggerTimer);
        if (done || next >= order.length) {
          if (!done && running === 0) finish(reject, new Error(`OpenStreetMap boundary servers are busy right now — try again in a minute. (${errors.join('; ')})`));
          return;
        }
        const ep = order[next++];
        const ac = new AbortController();
        controllers.push(ac);
        running++;
        fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ac.signal })
          .then(async (r) => {
            if (!r.ok) throw new Error(`${r.status}`);
            const json = await r.json();
            overpassFirst = OVERPASS.indexOf(ep);
            finish(resolve, json);
          })
          .catch((e) => {
            if (done) return;
            errors.push(`${new URL(ep).host} ${e.name === 'AbortError' ? 'cancelled' : e.message}`);
            running--;
            launch(); // failed fast: try the next one now
          });
        staggerTimer = setTimeout(launch, stagger);
      };
      launch();
    });
  }

  // Nominatim allows one request a second.
  let nominatimNext = 0;
  async function nominatim(path, params) {
    const wait = nominatimNext - Date.now();
    nominatimNext = Math.max(Date.now(), nominatimNext) + 1100;
    if (wait > 0) await sleep(wait);
    const u = new URL(`${NOMINATIM}/${path}`);
    for (const [k, v] of Object.entries({ format: 'jsonv2', ...params })) u.searchParams.set(k, v);
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Search failed (${r.status})`);
    return r.json();
  }
  function hasOutline(x) {
    return x.geojson && /^(Multi)?Polygon$/.test(x.geojson.type);
  }
  function nominatimItem(x) {
    const id = `osm:${x.osm_type[0]}${x.osm_id}`;
    const parts = x.display_name.split(', ');
    return {
      id,
      ds: 'osm',
      region: 'osm',
      code: id,
      name: x.name || parts[0],
      kind: x.addresstype || x.type,
      detail: parts.slice(1, 4).join(', '),
      geom: hasOutline(x) ? KZB.roundGeom(x.geojson) : null,
    };
  }
  async function searchOsm(q, limit = 8) {
    const res = await nominatim('search', { q, countrycodes: state.country.toLowerCase(), polygon_geojson: 1, limit });
    const seen = new Set();
    return res.map(nominatimItem).filter((i) => !seen.has(i.id) && seen.add(i.id));
  }
  function rememberOsm(item) {
    state.osm[item.id] = { name: item.name, kind: item.kind, detail: item.detail, geom: item.geom };
  }

  function viewBox() {
    const b = map.getBounds();
    return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((n) => n.toFixed(5)).join(',');
  }
  function kindQuery(kind, bb) {
    if (kind === 'postal') return `relation["boundary"="postal_code"](${bb});`;
    if (kind.startsWith('admin:')) return `relation["boundary"="administrative"]["admin_level"="${kind.slice(6)}"](${bb});`;
    return `relation["place"="${kind.slice(6)}"](${bb});`;
  }

  async function osmScan() {
    if (map.getZoom() < 9) {
      osmStatus('Zoom in further first — to a city or district — then press “Show boundaries here”.');
      return;
    }
    const btn = $('#osmScan');
    btn.disabled = true;
    osmStatus('Looking for boundaries in this view…');
    try {
      const bb = viewBox();
      const json = await overpass(
        `[out:json][timeout:40];(relation["boundary"="administrative"]["admin_level"](${bb});` +
          `relation["boundary"="postal_code"](${bb});` +
          `relation["place"~"^(suburb|quarter|neighbourhood|town|village|city|borough|hamlet|locality)$"](${bb}););out tags;`
      );
      const groups = KZB.summariseOsm(json.elements);
      const sel = $('#osmType');
      if (!groups.length) {
        sel.replaceChildren(el('option', {}, 'None found here'));
        sel.disabled = true;
        osmStatus('OpenStreetMap has no suburb, postcode or council boundaries in this view. Try searching instead.');
        return;
      }
      if (!groups.some((g) => g.key === state.osmKind)) {
        state.osmKind = (groups.find((g) => g.key === 'postal' || g.key.startsWith('place:')) || groups[0]).key;
      }
      sel.replaceChildren(
        ...groups.map((g) =>
          el('option', { value: g.key, selected: g.key === state.osmKind }, `${g.label} (${g.count}) — e.g. ${g.examples.join(', ')}`)
        )
      );
      sel.disabled = false;
      await osmLoad();
    } catch (e) {
      osmStatus(e.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function osmLoad() {
    const kind = state.osmKind;
    if (!kind) return;
    const label = KZB.osmKindLabel(kind).toLowerCase();
    osmStatus(`Loading ${label}…`);
    try {
      const json = await overpass(`[out:json][timeout:90];(${kindQuery(kind, viewBox())});out geom;`);
      osmLoaded.clear();
      const features = [];
      for (const e of json.elements) {
        const geometry = KZB.assembleRelation(e);
        if (!geometry) continue;
        const f = {
          type: 'Feature',
          properties: { id: `osm:r${e.id}`, name: KZB.osmName(e.tags || {}), kind, detail: KZB.osmKindLabel(kind) },
          geometry,
        };
        osmLoaded.set(f.properties.id, f);
        features.push(f);
      }
      if (hasOfficial()) return;
      showOsmLayer(features);
      osmStatus(
        features.length
          ? `${features.length} ${label} shown. Click them to add to or remove from the selected zone. Move the map and press the button again to load more.`
          : `No complete ${label} outlines here.`
      );
    } catch (e) {
      osmStatus(e.message);
    }
  }

  function showOsmLayer(features) {
    if (areaLayer) map.removeLayer(areaLayer);
    layerByCode.clear();
    areaLayer = L.geoJSON(
      { type: 'FeatureCollection', features },
      {
        renderer,
        style: styleFor,
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(feature.properties.name, { sticky: true, direction: 'top', offset: [0, -6] });
          layer.on('mouseover', () => layer.setStyle({ weight: 3 }));
          layer.on('mouseout', () => layer.setStyle(styleFor(feature)));
          layer.on('click', () => toggleArea(feature.properties.id));
        },
      }
    ).addTo(map);
  }

  async function setCountry(code) {
    state.country = code;
    save();
    syncControls();
    $('#search').value = '';
    if (areaLayer) {
      map.removeLayer(areaLayer);
      areaLayer = null;
    }
    if (hasOfficial()) {
      await ensureItems(countryCfg().datasets);
      syncControls();
      return showRegion(true);
    }
    osmLoaded.clear();
    $('#osmType').replaceChildren(el('option', {}, 'Press “Show boundaries here”'));
    $('#osmType').disabled = true;
    osmStatus('Zoom the map to the area you want, then press “Show boundaries here”. You can also search or paste a list.');
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
      const [c] = await nominatim('search', { country: name, countrycodes: code.toLowerCase(), limit: 1 });
      if (c && state.country === code) {
        const [s, n, w, e] = c.boundingbox.map(Number);
        map.fitBounds([[s, w], [n, e]]);
      }
    } catch (e) {
      /* stay where we are */
    }
  }

  async function addPastedOsm(zone, ta, msg, btn) {
    const tokens = ta.value.split(/[\n,;\t]+/).map((t) => t.trim()).filter(Boolean);
    if (!tokens.length) return;
    btn.disabled = true;
    const found = [];
    const unmatched = [];
    const noOutline = [];
    const ambiguous = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      msg.textContent = `Looking up ${i + 1} of ${tokens.length}: ${token}…`;
      try {
        const results = await searchOsm(token, 5);
        const withOutline = results.filter((r) => r.geom);
        const exact = withOutline.filter((r) => KZB.norm(r.name) === KZB.norm(token));
        const pick = exact.length === 1 ? exact : withOutline.length === 1 ? withOutline : null;
        if (pick) found.push(pick[0]);
        else if (withOutline.length) ambiguous.push({ token, options: withOutline });
        else if (results.length) noOutline.push(token);
        else unmatched.push(token);
      } catch (e) {
        unmatched.push(token);
      }
    }
    found.forEach(rememberOsm);
    const added = addItems(zone, found);
    msg.replaceChildren(`Added ${added} area${added === 1 ? '' : 's'}${found.length > added ? ` (${found.length - added} already in zone)` : ''}.`);
    if (unmatched.length) msg.append(el('br'), el('span', { class: 'bad' }, `Not found: ${unmatched.join(', ')}`));
    if (noOutline.length) {
      msg.append(el('br'), el('span', { class: 'bad' }, `Found but OpenStreetMap has no outline for: ${noOutline.join(', ')}`));
    }
    for (const amb of ambiguous) {
      msg.append(el('br'), `“${amb.token}” matches several — pick: `);
      for (const opt of amb.options) {
        msg.append(
          el('button', {
            type: 'button',
            class: 'btn small pick',
            title: opt.detail,
            onclick: (e) => {
              rememberOsm(opt);
              addItems(zone, [opt]);
              e.target.disabled = true;
              changed();
            },
          }, `${opt.name} (${opt.detail})`)
        );
      }
    }
    ta.value = [...unmatched, ...noOutline, ...ambiguous.map((a) => a.token)].join('\n');
    btn.disabled = false;
    changed();
  }

  // ---------- search ----------
  function setupSearch() {
    const input = $('#search');
    const list = $('#results');
    let results = [];
    let sel = 0;
    const close = () => {
      list.hidden = true;
      results = [];
    };
    const pick = async (item) => {
      if (item.ds === 'osm') {
        if (!item.geom) return toast(`OpenStreetMap has no outline for ${item.name}`, 2500);
        rememberOsm(item);
      }
      const zone = ensureActive();
      const added = addItems(zone, [item]);
      toast(added ? `Added ${item.name} to ${zone.name}` : `${item.name} is already in ${zone.name}`, 1800);
      input.value = '';
      close();
      changed();
      await goToItem(item);
    };
    const draw = () => {
      list.replaceChildren(
        ...results.map((item, i) =>
          el(
            'li',
            { class: (i === sel ? 'sel' : '') + (item.ds === 'osm' && !item.geom ? ' off' : ''), onmousedown: (e) => { e.preventDefault(); pick(item); } },
            el('span', {}, item.name),
            el(
              'span',
              { class: 'meta' },
              item.ds === 'osm' ? (item.geom ? `${item.kind} · ${item.detail}` : 'no outline in OpenStreetMap') : `${dsLabel(item.ds)} · ${regionLabel(item)}`
            )
          )
        )
      );
      list.hidden = !results.length;
    };
    let timer;
    let token = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      if (hasOfficial()) {
        results = KZB.search(lookup, input.value, countryCfg());
        sel = 0;
        draw();
        return;
      }
      const q = input.value.trim();
      if (q.length < 2) return close();
      timer = setTimeout(async () => {
        const mine = ++token;
        try {
          const found = await searchOsm(q);
          if (mine !== token) return;
          results = found;
          sel = Math.max(0, results.findIndex((r) => r.geom));
          draw();
          if (!results.length) toast(`Nothing found for “${q}”`, 1800);
        } catch (e) {
          toast(e.message, 3000);
        }
      }, 600);
    });
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, results.length - 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
      else if (e.key === 'Enter' && results[sel]) { pick(results[sel]); e.preventDefault(); }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
  }

  // ---------- export ----------
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function safeFileName(s) {
    return (s || 'zones').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'zones';
  }

  async function downloadKml(zones, fileName) {
    const usable = zones.filter((z) => z.items.length && (z.outline || z.individual));
    if (!usable.length) return toast('Nothing to download — add areas to a zone first');
    try {
      const out = [];
      for (const z of usable) {
        const items = itemsOf(z);
        const names = items.map((i) => itemLabel(i, true));
        const outline = z.outline ? await zoneOutline(z) : null;
        const areas = [];
        if (z.individual) {
          for (const item of items) {
            const geom = await areaGeometry(item);
            if (geom) areas.push({ name: itemLabel(item, true), geom, description: `${dsLabel(item.ds)} · ${z.name}` });
          }
        }
        out.push({ name: z.name, color: z.color, fill: z.fill, fillOpacity: z.fillOpacity, width: z.width, outline, areas, description: names.join(', ') });
      }
      const name = safeFileName(fileName);
      const used = usable.flatMap(itemsOf);
      const credits = [];
      for (const cc of new Set(used.filter((i) => i.ds !== 'osm').map((i) => countryOfDs(i.ds)))) {
        if (index.countries[cc]) credits.push(`${index.countries[cc].name} boundaries © ${index.countries[cc].credit}`);
      }
      if (used.some((i) => i.ds === 'osm')) credits.push('Boundaries © OpenStreetMap contributors, ODbL');
      const kml = KZB.buildKml(out, { docName: name, folders: state.settings.folders, description: credits.join('. ') });
      download(`${name}.kml`, kml, 'application/vnd.google-earth.kml+xml');
      toast(`Downloaded ${name}.kml`);
    } catch (e) {
      console.error(e);
      toast(`Could not build KML: ${e.message}`, 5000);
    }
  }

  // ---------- wire up ----------
  function wire() {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    const countries = COUNTRY_CODES.map((c) => [c, names.of(c) || c]).sort((a, b) => a[1].localeCompare(b[1]));
    const official = Object.entries(index.countries).sort((a, b) => a[1].name.localeCompare(b[1].name));
    $('#country').replaceChildren(
      el('optgroup', { label: 'Official boundaries' },
        ...official.map(([c, info]) => el('option', { value: c }, `${info.name} (${info.datasets.map((ds) => index.datasets[ds].label.toLowerCase()).join(', ')})`))),
      el('optgroup', { label: 'OpenStreetMap (coverage varies)' },
        ...countries.filter(([c]) => !index.countries[c]).map(([c, n]) => el('option', { value: c }, n)))
    );
    $('#country').value = state.country;
    $('#country').addEventListener('change', (e) => setCountry(e.target.value));
    $('#osmScan').addEventListener('click', osmScan);
    $('#osmType').addEventListener('change', (e) => {
      state.osmKind = e.target.value;
      save();
      osmLoad();
    });
    $('#region').addEventListener('change', (e) => {
      state.region = e.target.value;
      save();
      showRegion(true);
    });
    $('#addZone').addEventListener('click', () => {
      newZone();
      changed();
    });
    $('#fileName').addEventListener('change', (e) => { state.settings.fileName = e.target.value; save(); });
    $('#folders').addEventListener('change', (e) => { state.settings.folders = e.target.checked; save(); });
    $('#stripState').addEventListener('change', (e) => { state.settings.stripState = e.target.checked; save(); });
    $('#download').addEventListener('click', () => downloadKml(state.zones, state.settings.fileName));
    $('#saveProject').addEventListener('click', () =>
      download(`${safeFileName(state.settings.fileName)}.zones.json`, JSON.stringify(projectData(), null, 1), 'application/json')
    );
    $('#openProject').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        applyProject(JSON.parse(await file.text()));
        await ensureItems([...zoneDatasets(), ...(hasOfficial() ? countryCfg().datasets : [])]);
        syncControls();
        changed();
        if (hasOfficial()) await showRegion(false);
        else if (areaLayer) {
          map.removeLayer(areaLayer);
          areaLayer = null;
        }
        if (activeZone()) zoomToZone(activeZone());
        toast(`Opened ${file.name}`);
      } catch (err) {
        toast(`Could not open project: ${err.message}`, 5000);
      }
    });
    setupSearch();
  }

  async function start() {
    try {
      await loadIndex();
    } catch (e) {
      $('#zones').replaceChildren(el('p', { class: 'empty' }, e.message));
      toast(e.message, 8000);
      return;
    }
    restore();
    if (!COUNTRY_CODES.includes(state.country)) state.country = 'AU';
    try {
      await ensureItems([...zoneDatasets(), ...(hasOfficial() ? countryCfg().datasets : [])]);
    } catch (e) {
      toast(e.message, 5000);
    }
    syncControls();
    wire();
    changed();
    if (hasOfficial()) await showRegion(!state.zones.some((z) => z.items.length));
    if (activeZone() && activeZone().items.length) zoomToZone(activeZone());
    else if (!hasOfficial()) setCountry(state.country);
  }

  start();
})();
