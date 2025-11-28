import assert from 'assert';
import { ChunkManager } from '../chunkManager.js';

const cm = new ChunkManager({
  chunks: [
    { id: 'c1', bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, nodeCount: 0, edgeCount: 0 },
    { id: 'c2', bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, nodeCount: 0, edgeCount: 0 },
  ],
  majorRoadIds: [],
});

cm.markGeometryReady('c1', new Float32Array([0, 1]));
cm.markUploaded('c1');
cm.markGeometryReady('c2', new Float32Array([0, 1]));
cm.markUploaded('c2');

const released: string[] = [];
cm.evict(new Set(['c1']), id => released.push(id), 1, 0);

assert.deepStrictEqual(released, ['c2']);
assert.strictEqual(cm.getState('c2'), 'INDEXED');

console.log('chunkEviction.test.ts passed');
