import assert from 'assert';
import { ChunkManager } from '../chunkManager.js';

const cm = new ChunkManager({
  chunks: [{ id: 'c1', bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, nodeCount: 0, edgeCount: 0 }],
  majorRoadIds: [],
});

assert.strictEqual(cm.getState('c1'), 'INDEXED');
assert.ok(cm.needsGeometry('c1'));

cm.markGeometryReady('c1', new Float32Array([0, 1, 2]));
assert.strictEqual(cm.getState('c1'), 'GEOMETRY_READY');
assert.ok(cm.shouldUpload('c1'));

cm.markUploaded('c1');
assert.strictEqual(cm.getState('c1'), 'UPLOADED');

console.log('chunkManager.test.ts passed');
