/* global L, topojson, turf, KZB */
(() => {
  'use strict';

  const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa5b5', '#d6249f', '#808000', '#9a6324', '#000075'];
  const STORE_KEY = 'kml-zone-builder:project';
  const DS_LABEL = { sal: 'Suburb', poa: 'Postcode' };

  // ---------- state ----------
  const state = {
    zones: [],
    activeId: null,
    ds: 'sal',
    region: 'nsw_act',
    settings: { fileName: 'zones', folders: true, stripState: true },
  };
  let index = null; // data/index.json
  let lookup = null; // KZB.buildLookup(index)
  const regionCache = new Map(); // "ds/region" -> Promise<{ topo, geoms: Map(code -> topo geometry), features: Map(code -> GeoJSON) }>
  let membership = new Map(); // item id -> [zone ids]

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

  // ---------- data ----------
  async function loadIndex() {
    const res = await fetch('data/index.json');
    if (!res.ok) throw new Error('Boundary data not found (data/index.json). Has the data build run?');
    index = await res.json();
    lookup = KZB.buildLookup(index);
    if (index.built) $('#built').textContent = ` Data built ${index.built.slice(0, 10)}.`;
  }

  function loadRegion(ds, region) {
    const key = `${ds}/${region}`;
    if (!regionCache.has(key)) {
      const p = fetch(`data/${ds}/${region}.json`)
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

  function itemsOf(zone) {
    return zone.items.map((id) => lookup.byId.get(id)).filter(Boolean);
  }

  // Combined outline of a zone. Areas from the same file are merged on their shared topology,
  // so neighbouring areas join without slivers. Different files (state borders, or suburbs mixed
  // with postcodes) are then unioned geometrically.
  async function zoneOutline(zone) {
    const groups = new Map();
    for (const item of itemsOf(zone)) {
      const key = `${item.ds}/${item.region}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    if (!groups.size) return null;
    const parts = [];
    for (const [key, items] of groups) {
      const [ds, region] = key.split('/');
      const data = await loadRegion(ds, region);
      const geoms = items.map((i) => data.geoms.get(i.code)).filter(Boolean);
      parts.push(topojson.merge(data.topo, geoms));
    }
    if (parts.length === 1) return parts[0];
    if (typeof turf === 'undefined') throw new Error('Geometry library still loading — try again in a moment.');
    const merged = turf.union(turf.featureCollection(parts.map((g) => turf.feature(g))));
    return merged ? merged.geometry : null;
  }

  async function areaGeometry(item) {
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
    if (item.ds === 'poa') return item.code;
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
    return { app: 'kml-zone-builder', version: 1, zones: state.zones, activeId: state.activeId, settings: state.settings };
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...projectData(), ds: state.ds, region: state.region }));
    } catch (e) {
      /* storage unavailable — fine */
    }
  }
  function applyProject(p) {
    if (!p || !Array.isArray(p.zones)) throw new Error('Not a KML Zone Builder project');
    state.zones = p.zones
      .filter((z) => z && Array.isArray(z.items))
      .map((z, i) => ({
        id: String(z.id || Math.random().toString(36).slice(2, 10)),
        name: String(z.name || `Zone ${i + 1}`),
        color: /^#[0-9a-f]{6}$/i.test(z.color) ? z.color : COLORS[i % COLORS.length],
        items: z.items.filter((id) => typeof id === 'string'),
        outline: z.outline !== false,
        individual: z.individual !== false,
      }));
    state.activeId = state.zones.some((z) => z.id === p.activeId) ? p.activeId : state.zones[0]?.id || null;
    if (p.settings) Object.assign(state.settings, p.settings);
    if (p.ds && index.datasets[p.ds]) state.ds = p.ds;
    if (p.region && index.datasets[state.ds].regions[p.region]) state.region = p.region;
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
    const id = `${state.ds}:${feature.properties.code}`;
    const zones = membership.get(id) || [];
    const active = activeZone();
    if (active && zones.includes(active.id)) {
      return { color: active.color, weight: 1.6, opacity: 1, fillColor: active.color, fillOpacity: 0.35 };
    }
    if (zones.length) {
      const other = state.zones.find((z) => z.id === zones[0]);
      return { color: '#555', weight: 0.8, opacity: 0.7, fillColor: other ? other.color : '#888', fillOpacity: 0.14 };
    }
    return { color: '#4b4f55', weight: 0.7, opacity: 0.65, fillColor: '#000', fillOpacity: 0.01 };
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
    if (token !== showToken) return;
    if (areaLayer) map.removeLayer(areaLayer);
    layerByCode.clear();
    areaLayer = L.geoJSON(
      { type: 'FeatureCollection', features: [...data.features.values()] },
      {
        renderer,
        style: styleFor,
        onEachFeature: (feature, layer) => {
          layerByCode.set(feature.properties.code, layer);
          const item = lookup.byId.get(`${ds}:${feature.properties.code}`);
          layer.bindTooltip(item ? item.name : feature.properties.name, { sticky: true, direction: 'top', offset: [0, -6] });
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
    const item = lookup.byId.get(id);
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
            style: { color: z.color, weight: active ? 4 : 2.5, opacity: 0.95, fill: false, dashArray: active ? null : '6 5' },
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
    if (item.ds !== state.ds || item.region !== state.region) {
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
    document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.ds === state.ds));
    const sel = $('#region');
    sel.replaceChildren(
      ...Object.entries(index.datasets[state.ds].regions).map(([key, r]) =>
        el('option', { value: key, selected: key === state.region }, `${index.regions[key]} (${r.count.toLocaleString()})`)
      )
    );
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
        if (active || e.target.closest('button,label,textarea,summary,a,input[type=color],input[type=checkbox]')) return;
        state.activeId = z.id;
        const focusName = e.target.classList.contains('name');
        changed();
        if (focusName) $('#zones .zone.active .name')?.focus();
      },
    });
    const head = el(
      'div',
      { class: 'zone-head' },
      el('input', {
        type: 'color',
        value: z.color,
        title: 'Zone colour',
        oninput: (e) => {
          z.color = e.target.value;
          card.style.setProperty('--zc', z.color);
        },
        onchange: () => changed(),
      }),
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
      )
    );

    if (active) {
      const chips = el('div', { class: 'chips' });
      for (const item of items) {
        const others = (membership.get(item.id) || []).filter((id) => id !== z.id).length;
        chips.append(
          el(
            'span',
            { class: 'chip', title: `${DS_LABEL[item.ds]} · ${index.regions[item.region]}` },
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
      const ta = el('textarea', { placeholder: 'One per line or comma-separated, e.g.\nEpping, Carlingford, Beecroft\n2121\nEpping VIC' });
      ta.value = keep.pasteText;
      const paste = el(
        'details',
        { class: 'paste', open: keep.openPaste },
        el('summary', {}, 'Paste a list of suburbs or postcodes'),
        ta,
        el('button', { type: 'button', class: 'btn small', onclick: () => addPasted(z, ta, msg) }, 'Add to zone'),
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

  function addPasted(zone, ta, msg) {
    const res = KZB.matchList(lookup, ta.value, state.region);
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
          }, opt.name)
        );
      }
    }
    // keep only what still needs attention in the box
    ta.value = [...res.unmatched, ...res.ambiguous.map((a) => a.token)].join('\n');
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
            { class: i === sel ? 'sel' : '', onmousedown: (e) => { e.preventDefault(); pick(item); } },
            el('span', {}, item.name),
            el('span', { class: 'meta' }, `${DS_LABEL[item.ds]} · ${index.regions[item.region]}`)
          )
        )
      );
      list.hidden = !results.length;
    };
    input.addEventListener('input', () => {
      results = KZB.search(lookup, input.value);
      sel = 0;
      draw();
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
            if (geom) areas.push({ name: itemLabel(item, true), geom, description: `${DS_LABEL[item.ds]} · ${z.name}` });
          }
        }
        out.push({ name: z.name, color: z.color, outline, areas, description: names.join(', ') });
      }
      const name = safeFileName(fileName);
      const kml = KZB.buildKml(out, { docName: name, folders: state.settings.folders });
      download(`${name}.kml`, kml, 'application/vnd.google-earth.kml+xml');
      toast(`Downloaded ${name}.kml`);
    } catch (e) {
      console.error(e);
      toast(`Could not build KML: ${e.message}`, 5000);
    }
  }

  // ---------- wire up ----------
  function wire() {
    document.querySelectorAll('.seg button').forEach((b) =>
      b.addEventListener('click', () => {
        if (state.ds === b.dataset.ds) return;
        state.ds = b.dataset.ds;
        if (!index.datasets[state.ds].regions[state.region]) state.region = Object.keys(index.datasets[state.ds].regions)[0];
        syncControls();
        save();
        showRegion(false);
      })
    );
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
        syncControls();
        changed();
        await showRegion(false);
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
    if (!index.datasets[state.ds]) state.ds = Object.keys(index.datasets)[0];
    if (!index.datasets[state.ds].regions[state.region]) state.region = Object.keys(index.datasets[state.ds].regions)[0];
    syncControls();
    wire();
    changed();
    await showRegion(!state.zones.some((z) => z.items.length));
    if (activeZone() && activeZone().items.length) zoomToZone(activeZone());
  }

  start();
})();
