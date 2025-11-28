import assert from 'assert';
import { mergeLinesToBuffer } from './batching.js';

const lines = [
  [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  [{ x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }],
];

const merged = mergeLinesToBuffer(lines);
assert.strictEqual(merged.vertices.length, (2 + 3) * 2);
assert.strictEqual(merged.indices.length, (2 - 1) * 2 + (3 - 1) * 2);
assert.strictEqual(merged.drawCalls, 2);

console.log('batching.test.ts passed');
