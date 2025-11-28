import assert from 'assert';
import { extractSubnetwork } from './subnetworkExtractor.js';

const nodes = new Map([
  ['n1', { id: 'n1', position: { x: 0, y: 0 }, type: 'waypoint' as const, incomingEdges: [], outgoingEdges: [] }],
  ['n2', { id: 'n2', position: { x: 1, y: 0 }, type: 'waypoint' as const, incomingEdges: [], outgoingEdges: [] }],
  ['n3', { id: 'n3', position: { x: 2, y: 0 }, type: 'waypoint' as const, incomingEdges: [], outgoingEdges: [] }],
]);

const edges = new Map([
  ['e1', { id: 'e1', fromNode: 'n1', toNode: 'n2', lanes: [], laneCount: 1, geometry: [], roadType: 'local' as const, oneWay: true }],
  ['e2', { id: 'e2', fromNode: 'n2', toNode: 'n3', lanes: [], laneCount: 1, geometry: [], roadType: 'local' as const, oneWay: true }],
]);

const sel = new Set(['n1', 'n2']);
const sub = extractSubnetwork(nodes, edges, sel);

assert.ok(sub.nodes['n1'] && sub.nodes['n2'], 'selected nodes present');
assert.ok(sub.edges['e1'], 'internal edge present');
assert.ok(!sub.edges['e2'], 'external edge excluded');
assert.deepStrictEqual(sub.boundary.outlets.sort(), ['n2']);
assert.deepStrictEqual(sub.boundary.inlets.sort(), []);

console.log('subnetworkExtractor.test.ts passed');
