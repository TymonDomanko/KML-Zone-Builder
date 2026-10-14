const test = require('node:test');
const assert = require('node:assert');
const KZB = require('../site/core.js');

const index = {
  datasets: {
    sal: {
      items: [
        ['1', 'Epping (NSW)', 'nsw_act'],
        ['2', 'Epping (Vic.)', 'victoria'],
        ['3', 'Carlingford', 'nsw_act'],
        ['4', 'Beecroft', 'nsw_act'],
        ['5', "O'Connor (ACT)", 'nsw_act'],
        ['6', "O'Connor (WA)", 'western_australia'],
        ['7', 'North Epping', 'nsw_act'],
        ['8', 'Ascot (Toowoomba - Qld)', 'queensland'],
        ['9', 'Ascot (WA)', 'western_australia'],
        ['10', 'Ascot (Ballarat - Vic.)', 'victoria'],
        ['11', 'Ascot (Brisbane - Qld)', 'queensland'],
      ],
    },
    poa: { items: [['2121', '2121', 'nsw_act'], ['0800', '0800', 'northern_territory']] },
  },
};
const lookup = KZB.buildLookup(index);

const names = (items) => items.map((i) => i.name);

test('search: names and postcodes', () => {
  assert.deepStrictEqual(names(KZB.search(lookup, 'epp')), ['Epping (NSW)', 'Epping (Vic.)', 'North Epping']);
  assert.deepStrictEqual(names(KZB.search(lookup, '212')), ['2121']);
  assert.deepStrictEqual(names(KZB.search(lookup, 'oconnor')), ["O'Connor (ACT)", "O'Connor (WA)"]);
});

test('matchList: plain names prefer the current region', () => {
  const r = KZB.matchList(lookup, 'Epping, Carlingford\nBeecroft', 'nsw_act');
  assert.deepStrictEqual(names(r.matched), ['Epping (NSW)', 'Carlingford', 'Beecroft']);
  assert.deepStrictEqual(r.unmatched, []);
});

test('matchList: state hints and postcodes', () => {
  const r = KZB.matchList(lookup, 'Epping VIC; epping (nsw); Epping NSW 2121; 2121; 800; Nowhere', 'qld');
  assert.deepStrictEqual(names(r.matched), ['Epping (Vic.)', 'Epping (NSW)', 'Epping (NSW)', '2121', '0800']);
  assert.deepStrictEqual(r.unmatched, ['Nowhere']);
});

test('matchList: ambiguous names are reported', () => {
  const r = KZB.matchList(lookup, 'Ascot', 'nsw_act');
  assert.strictEqual(r.matched.length, 0);
  assert.strictEqual(r.ambiguous.length, 1);
  assert.strictEqual(r.ambiguous[0].options.length, 4);
  assert.deepStrictEqual(names(KZB.matchList(lookup, 'Ascot WA', 'nsw_act').matched), ['Ascot (WA)']);
  assert.deepStrictEqual(names(KZB.matchList(lookup, 'Ascot VIC', 'nsw_act').matched), ['Ascot (Ballarat - Vic.)']);
  assert.strictEqual(KZB.matchList(lookup, 'Ascot QLD', 'nsw_act').ambiguous[0].options.length, 2);
  assert.deepStrictEqual(KZB.matchList(lookup, 'Carlingford VIC').unmatched, ['Carlingford VIC']);
});

test('kmlColor converts to aabbggrr', () => {
  assert.strictEqual(KZB.kmlColor('#ff8000', 1), 'ff0080ff');
  assert.strictEqual(KZB.kmlColor('#112233', 0.25), '40332211');
});

test('buildKml: folders, holes, multipolygons and escaping', () => {
  const square = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
  const zones = [
    {
      name: 'North & West <A>',
      color: '#e6194b',
      description: 'Epping, Carlingford',
      outline: { type: 'Polygon', coordinates: [square(0, 0, 3), square(1, 1, 1)] },
      areas: [
        { name: 'Epping', geom: { type: 'Polygon', coordinates: [square(0, 0, 1)] } },
        { name: 'Carlingford', geom: { type: 'MultiPolygon', coordinates: [[square(5, 5, 1)], [square(7, 7, 1)]] } },
      ],
    },
    { name: 'Only areas', color: '#3cb44b', outline: null, areas: [{ name: '2121', geom: { type: 'Polygon', coordinates: [square(9, 9, 1)] } }] },
  ];
  const kml = KZB.buildKml(zones, { docName: 'Test' });
  assert.match(kml, /^<\?xml/);
  assert.strictEqual((kml.match(/<Placemark>/g) || []).length, 4);
  assert.strictEqual((kml.match(/<innerBoundaryIs>/g) || []).length, 1);
  assert.strictEqual((kml.match(/<MultiGeometry>/g) || []).length, 1);
  assert.ok(kml.includes('North &amp; West &lt;A&gt;'));
  assert.ok(kml.includes('<Folder><name>North &amp; West &lt;A&gt; – areas</name>'));
  // 3 folders: zone 1, its areas, zone 2
  assert.strictEqual((kml.match(/<Folder>/g) || []).length, 3);
  assert.ok(kml.includes('<Style id="zone0"><LineStyle><color>ff4b19e6</color><width>3</width></LineStyle><PolyStyle><color>404b19e6</color></PolyStyle></Style>'));
  const flat = KZB.buildKml(zones, { folders: false });
  assert.strictEqual((flat.match(/<Folder>/g) || []).length, 0);
  assert.strictEqual((flat.match(/<Placemark>/g) || []).length, 4);
});

test('buildKml: custom outline, shading colour, opacity and width', () => {
  const geom = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  const kml = KZB.buildKml([{ name: 'A', color: '#ff0000', fill: '#0000ff', fillOpacity: 0.5, width: 5, outline: geom, areas: [] }]);
  assert.ok(kml.includes('<Style id="zone0"><LineStyle><color>ff0000ff</color><width>5</width></LineStyle><PolyStyle><color>80ff0000</color></PolyStyle></Style>'));
  assert.ok(kml.includes('<Style id="zone0area"><LineStyle><color>e60000ff</color><width>2.5</width></LineStyle><PolyStyle><color>40ff0000</color></PolyStyle></Style>'));
  const none = KZB.buildKml([{ name: 'A', color: '#ff0000', fillOpacity: 0, outline: geom, areas: [] }]);
  assert.ok(none.includes('<PolyStyle><fill>0</fill></PolyStyle>'));
});

test('other countries: US ZIPs, Canadian FSAs and state/province hints', () => {
  const lk = KZB.createLookup();
  KZB.addDataset(lk, 'usplace', 'area', [['1', 'Springfield', 'illinois'], ['2', 'Springfield', 'missouri'], ['3', 'Chicago', 'illinois']]);
  KZB.addDataset(lk, 'uszip', 'postcode', [['60601', '60601', 'zip_6'], ['02134', '02134', 'zip_0']]);
  KZB.addDataset(lk, 'cafsa', 'postcode', [['M5V', 'M5V', 'ontario']]);
  KZB.addDataset(lk, 'cacsd', 'area', [['9', 'Montréal', 'quebec']]);
  const us = { datasets: ['usplace', 'uszip'], postcode: { ds: 'uszip', re: '^\\d{5}(-\\d{4})?$', len: 5 }, hints: { il: 'illinois', mo: 'missouri' } };
  const r = KZB.matchList(lk, 'Springfield IL\nSpringfield, MO\n60601-1234\n02134\nChicago 60601\nSpringfield', 'texas', us);
  assert.deepStrictEqual(r.matched.map((i) => i.id), ['usplace:1', 'uszip:60601', 'uszip:02134', 'usplace:3']);
  // "Springfield, MO" splits on the comma into "Springfield" + "MO"
  assert.deepStrictEqual(r.unmatched, ['MO']);
  assert.strictEqual(r.ambiguous.length, 2);
  assert.deepStrictEqual(KZB.search(lk, '6060', us).map((i) => i.code), ['60601']);
  assert.deepStrictEqual(KZB.search(lk, 'spring', us).map((i) => i.id), ['usplace:1', 'usplace:2']);
  const ca = { datasets: ['cacsd', 'cafsa'], postcode: { ds: 'cafsa', re: '^[A-Za-z]\\d[A-Za-z](\\d[A-Za-z]\\d)?$', len: 3, upper: true }, hints: { qc: 'quebec' } };
  const c = KZB.matchList(lk, 'm5v 3l9\nMontreal QC\nm5v', null, ca);
  assert.deepStrictEqual(c.matched.map((i) => i.id), ['cafsa:M5V', 'cacsd:9', 'cafsa:M5V']);
  assert.deepStrictEqual(KZB.search(lk, 'montre', ca).map((i) => i.id), ['cacsd:9']);
  assert.deepStrictEqual(KZB.search(lk, 'spring', ca), []);
});
