import assert from 'assert';
import { parseMapIndexData } from './mapLoader.js';

const sample = {
  nodes: [
    { id: 'n1', x: 0, y: 0 },
    { id: 'n2', x: 10, y: 10 },
  ],
  edges: [
    {
      id: 'e1',
      from: 'n1',
      to: 'n2',
      geometry: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      roadType: 'primary',
    },
  ],
};

const index = parseMapIndexData(sample);
assert.ok(index.chunks.length === 1, 'one chunk summary');
assert.ok(index.majorRoadIds.includes('e1'), 'major road detected');
assert.ok(index.chunks[0].edgeCount === 1, 'edge count ok');

console.log('mapLoader.test.ts passed');
