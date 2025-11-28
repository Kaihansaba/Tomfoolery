import { config } from '../config.js';

export type MapIndex = {
  chunks: Array<{
    id: string;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    nodeCount: number;
    edgeCount: number;
  }>;
  majorRoadIds: string[];
};

function bboxFromGeometry(geom: Array<{ x: number; y: number }>) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of geom) {
    minX = Math.min(minX, pt.x);
    minY = Math.min(minY, pt.y);
    maxX = Math.max(maxX, pt.x);
    maxY = Math.max(maxY, pt.y);
  }
  return { minX, minY, maxX, maxY };
}

export function parseMapIndexData(raw: any): MapIndex {
  const edges = raw?.edges ?? raw?.default?.edges ?? [];
  const nodes = raw?.nodes ?? raw?.default?.nodes ?? [];
  const chunks: MapIndex['chunks'] = [];

  // Single-chunk summary for now (non-invasive)
  if (edges.length > 0) {
    const allGeom: Array<{ x: number; y: number }> = [];
    for (const e of edges) {
      if (Array.isArray(e.geometry)) {
        allGeom.push(...e.geometry);
      }
    }
    const bbox =
      allGeom.length > 0
        ? bboxFromGeometry(allGeom)
        : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    chunks.push({
      id: 'all',
      bbox,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    });
  }

  const majorRoadIds: string[] = [];
  for (const e of edges) {
    const rt = e.roadType || e.properties?.highway || '';
    if (typeof rt === 'string' && /motorway|trunk|primary/i.test(rt)) {
      majorRoadIds.push(e.id);
    }
  }

  return { chunks, majorRoadIds };
}

export async function fastIndexLoad(url: string): Promise<MapIndex | null> {
  if (!config.optimizations.chunkedIndex) return null;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/mapParser.worker.ts', import.meta.url), {
      type: 'module',
    });
    const cleanup = () => worker.terminate();
    worker.onmessage = (event: MessageEvent) => {
      const { ok, index, error } = event.data;
      cleanup();
      if (!ok) {
        reject(new Error(error || 'map index failed'));
      } else {
        resolve(index as MapIndex);
      }
    };
    worker.onerror = err => {
      cleanup();
      reject(err);
    };
    worker.postMessage({ url });
  });
}
