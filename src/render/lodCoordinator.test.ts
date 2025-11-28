import assert from 'assert';
import { pickRoadClass, filterEdgesByLOD } from './lodCoordinator.js';

const mapIndex = { chunks: [], majorRoadIds: ['m1'] };
const edges = [
  { id: 'm1', roadType: 'motorway' },
  { id: 'p1', roadType: 'primary' },
  { id: 's1', roadType: 'secondary' },
  { id: 'l1', roadType: 'residential' },
];

assert.strictEqual(pickRoadClass(0.2), 'major');
assert.strictEqual(pickRoadClass(0.8), 'primary');
assert.strictEqual(pickRoadClass(1.5), 'all');

assert.deepStrictEqual(
  filterEdgesByLOD(mapIndex as any, edges, 0.2).map(e => e.id).sort(),
  ['m1', 'p1'] // motorway + primary because regex includes primary
);
assert.deepStrictEqual(
  filterEdgesByLOD(mapIndex as any, edges, 0.9).map(e => e.id).sort(),
  ['m1', 'p1', 's1']
);
assert.deepStrictEqual(
  filterEdgesByLOD(mapIndex as any, edges, 1.5).map(e => e.id).sort(),
  ['l1', 'm1', 'p1', 's1']
);

console.log('lodCoordinator.test.ts passed');
