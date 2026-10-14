const test = require('node:test');
const assert = require('node:assert');
const KZB = require('../site/core.js');

const index = {
  regions: { nsw_act: 'NSW & ACT', vic: 'Victoria', qld: 'Queensland' },
  datasets: {
    sal: {
      items: [
        ['1', 'Epping (NSW)', 'nsw_act'],
        ['2', 'Epping (Vic.)', 'vic'],
        ['3', 'Carlingford', 'nsw_act'],
        ['4', 'Beecroft', 'nsw_act'],
        ['5', "O'Connor (ACT)", 'nsw_act'],
        ['6', "O'Connor (WA)", 'wa'],
        ['7', 'North Epping', 'nsw_act'],
        ['8', 'Ascot (Qld)', 'qld'],
        ['9', 'Ascot (WA)', 'wa'],
        ['10', 'Ascot (Vic.)', 'vic'],
      ],
    },
    poa: { items: [['2121', '2121', 'nsw_act'], ['0800', '0800', 'nt']] },
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
  assert.strictEqual(r.ambiguous[0].options.length, 3);
  assert.deepStrictEqual(names(KZB.matchList(lookup, 'Ascot WA', 'nsw_act').matched), ['Ascot (WA)']);
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
  const flat = KZB.buildKml(zones, { folders: false });
  assert.strictEqual((flat.match(/<Folder>/g) || []).length, 0);
  assert.strictEqual((flat.match(/<Placemark>/g) || []).length, 4);
});
