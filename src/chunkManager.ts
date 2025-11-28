import { config } from './config.js';
import { MapIndex } from './utils/mapLoader.js';

export type ChunkState = 'UNLOADED' | 'INDEXED' | 'GEOMETRY_READY' | 'UPLOADED';

export type ChunkRecord = {
  id: string;
  state: ChunkState;
  vertexData?: Float32Array;
  lastUsed?: number;
};

export class ChunkManager {
  private chunks = new Map<string, ChunkRecord>();

  constructor(index?: MapIndex) {
    if (index) {
      for (const c of index.chunks) {
        this.chunks.set(c.id, { id: c.id, state: 'INDEXED', lastUsed: performance.now() });
      }
    }
  }

  getState(id: string): ChunkState | undefined {
    return this.chunks.get(id)?.state;
  }

  markIndexed(id: string) {
    const rec = this.chunks.get(id);
    if (rec) rec.state = 'INDEXED';
    else this.chunks.set(id, { id, state: 'INDEXED' });
  }

  markGeometryReady(id: string, vertexData: Float32Array) {
    const rec = this.chunks.get(id);
    if (rec) {
      rec.state = 'GEOMETRY_READY';
      rec.vertexData = vertexData;
      rec.lastUsed = performance.now();
    } else {
      this.chunks.set(id, { id, state: 'GEOMETRY_READY', vertexData, lastUsed: performance.now() });
    }
  }

  markUploaded(id: string) {
    const rec = this.chunks.get(id);
    if (rec) {
      rec.state = 'UPLOADED';
      rec.lastUsed = performance.now();
    }
  }

  needsGeometry(id: string): boolean {
    const state = this.getState(id);
    return state === 'INDEXED' || state === 'UNLOADED' || state === undefined;
  }

  shouldUpload(id: string): boolean {
    return this.getState(id) === 'GEOMETRY_READY';
  }

  evict(
    visibleIds: Set<string>,
    releaseBuffers: (chunkId: string) => void,
    radius: number,
    margin: number
  ) {
    const now = performance.now();
    for (const [id, rec] of this.chunks) {
      if (visibleIds.has(id)) {
        rec.lastUsed = now;
        continue;
      }
      const distOk = this.isWithinMargin(id, visibleIds, radius + margin);
      if (!distOk && rec.state === 'UPLOADED') {
        releaseBuffers(id);
        rec.state = 'INDEXED';
        rec.vertexData = undefined;
      }
    }
  }

  private isWithinMargin(id: string, visibleIds: Set<string>, allowed: number): boolean {
    // Simplified: check string difference to limit churn when only a few IDs are visible.
    if (visibleIds.has(id)) return true;
    return visibleIds.size < allowed;
  }
}

export function uploadBuffersToGPU(
  chunkId: string,
  vertexData: Float32Array,
  isVisible: () => boolean,
  onUpload: (chunkId: string, vertexData: Float32Array) => void
) {
  if (!config.optimizations.progressiveGeometry) return;
  if (!isVisible()) return;
  onUpload(chunkId, vertexData);
}
