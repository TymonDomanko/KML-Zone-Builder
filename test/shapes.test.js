const test = require('node:test');
const assert = require('node:assert');
const KZB = require('../site/core.js');

test('parseKmlPolygons reads polygons, holes, multigeometry and names', () => {
  const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Zone &amp; 1</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
    151,-33,0 151.1,-33,0 151.1,-33.1,0 151,-33.1,0 151,-33,0</coordinates></LinearRing></outerBoundaryIs>
    <innerBoundaryIs><LinearRing><coordinates>151.04,-33.04 151.06,-33.04 151.06,-33.06 151.04,-33.06</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark>
  <Placemark><name><![CDATA[Two parts]]></name><MultiGeometry>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>5,5 6,5 6,6 5,5</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </MultiGeometry></Placemark>
  <Placemark><name>A pin</name><Point><coordinates>1,1</coordinates></Point></Placemark>
  <kml:Placemark><kml:Polygon><kml:outerBoundaryIs><kml:LinearRing><kml:coordinates>9,9 10,9 10,10 9,9</kml:coordinates></kml:LinearRing></kml:outerBoundaryIs></kml:Polygon></kml:Placemark>
  </Document></kml>`;
  const res = KZB.parseKmlPolygons(kml);
  assert.deepStrictEqual(res.map((r) => [r.name, r.geom.type]), [['Zone & 1', 'Polygon'], ['Two parts', 'MultiPolygon'], ['Shape 4', 'Polygon']]);
  assert.strictEqual(res[0].geom.coordinates.length, 2);
  // the hole wasn't closed in the file; it is now
  const hole = res[0].geom.coordinates[1];
  assert.deepStrictEqual(hole[0], hole[hole.length - 1]);
  assert.strictEqual(res[1].geom.coordinates.length, 2);
});

test('KML round trip: buildKml output parses back', () => {
  const geom = { type: 'Polygon', coordinates: [[[151, -33], [151.1, -33], [151.1, -33.1], [151, -33]]] };
  const kml = KZB.buildKml([{ name: 'Round <trip>', color: '#ff0000', outline: geom, areas: [{ name: 'Inner', geom }] }]);
  const back = KZB.parseKmlPolygons(kml);
  assert.deepStrictEqual(back.map((b) => b.name), ['Round <trip>', 'Inner']);
  assert.deepStrictEqual(back[0].geom, geom);
});
