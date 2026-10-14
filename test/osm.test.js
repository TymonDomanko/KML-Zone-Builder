const test = require('node:test');
const assert = require('node:assert');
const KZB = require('../site/core.js');

const g = (pts) => pts.map(([lon, lat]) => ({ lon, lat }));

test('assembleRelation joins ways (any direction) and attaches holes', () => {
  const rel = {
    members: [
      // outer square 0..10 split into three ways, one reversed
      { type: 'way', role: 'outer', geometry: g([[0, 0], [10, 0]]) },
      { type: 'way', role: 'outer', geometry: g([[0, 10], [10, 10], [10, 0]]) },
      { type: 'way', role: 'outer', geometry: g([[0, 10], [0, 0]]) },
      // hole 4..6
      { type: 'way', role: 'inner', geometry: g([[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]) },
      // second outer island
      { type: 'way', role: '', geometry: g([[20, 20], [21, 20], [21, 21], [20, 20]]) },
      { type: 'node', role: 'label' },
    ],
  };
  const geom = KZB.assembleRelation(rel);
  assert.strictEqual(geom.type, 'MultiPolygon');
  assert.strictEqual(geom.coordinates.length, 2);
  const big = geom.coordinates.find((p) => p.length === 2);
  assert.ok(big, 'square has its hole');
  assert.strictEqual(big[0].length, 5);
  assert.deepStrictEqual(big[0][0], big[0][big[0].length - 1]);
});

test('assembleRelation returns null for open outlines', () => {
  assert.strictEqual(KZB.assembleRelation({ members: [{ type: 'way', role: 'outer', geometry: g([[0, 0], [1, 0], [1, 1]]) }] }), null);
});

test('summariseOsm groups and orders boundary kinds', () => {
  const s = KZB.summariseOsm([
    { tags: { boundary: 'administrative', admin_level: '10', name: 'Mitte' } },
    { tags: { boundary: 'administrative', admin_level: '10', name: 'Moabit' } },
    { tags: { boundary: 'administrative', admin_level: '4', name: 'Berlin' } },
    { tags: { boundary: 'postal_code', postal_code: '10115' } },
    { tags: { type: 'multipolygon', place: 'suburb', name: 'Ponsonby' } },
    { tags: { boundary: 'protected_area', name: 'Park' } },
  ]);
  assert.deepStrictEqual(s.map((x) => [x.key, x.count]), [['postal', 1], ['admin:10', 2], ['admin:4', 1], ['place:suburb', 1]]);
  assert.strictEqual(s[1].label, 'Admin level 10');
  assert.strictEqual(s[3].label, 'Places: suburbs');
  assert.deepStrictEqual(s[1].examples, ['Mitte', 'Moabit']);
});

test('osmName prefers postcode + name', () => {
  assert.strictEqual(KZB.osmName({ boundary: 'postal_code', postal_code: '10115', note: 'x' }), '10115');
  assert.strictEqual(KZB.osmName({ boundary: 'postal_code', postal_code: '1011', name: 'Ponsonby' }), '1011 Ponsonby');
  assert.strictEqual(KZB.osmName({ name: 'München', 'name:en': 'Munich' }), 'Munich');
});

test('buildKml adds a document description', () => {
  const kml = KZB.buildKml([], { description: 'Boundaries © OpenStreetMap contributors' });
  assert.ok(kml.includes('<description>Boundaries © OpenStreetMap contributors</description>'));
});
