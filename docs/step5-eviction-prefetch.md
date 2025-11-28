# Step 5 – Chunk eviction & prefetch (feature-flagged)

## What changed
- Added `config.optimizations.chunkRadius`, `chunkMargin`, and `prefetchNeighbors`.
- Extended `ChunkManager` with LRU-like eviction: `evict` downgrades far, uploaded chunks back to INDEXED and calls `releaseBuffers` to free GPU memory.
- Added a unit test for eviction (`src/utils/chunkEviction.test.ts`).
- Prefetch hook is ready (supply neighbors to load with low priority) — wiring to loader/renderer can be added without breaking APIs.

## How to test manually
1. Tune `chunkRadius`/`chunkMargin` in `src/config.ts` (e.g., radius=2, margin=1).
2. Instrument renderer to call `cm.evict(visibleIds, releaseBuffers, radius, margin)` when visible chunks change; verify buffers for distant chunks are released.
3. Run tests:  
   ```bash
   node --loader ts-node/esm src/utils/chunkEviction.test.ts
   ```
4. Use devtools to monitor GPU memory as you zoom/pan; distant chunks should unload when out of radius.

## Acceptance criteria
- Distant chunks free their GPU buffers when outside radius+margin.
- Zooming in/out does not retain all buffers, improving FPS/memory.
- Prefetch can be enabled to load a small set of neighbors; no change to public APIs.
