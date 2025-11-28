# Step 4 – Zoom-based LOD filtering (feature-flagged)

## What changed
- Added `config.optimizations.lodZooms` (Z1/Z2) and `chunkBatching` flag remains default off.
- Added LOD coordinator (`src/render/lodCoordinator.ts`) to pick road classes by zoom and filter edges accordingly.
- Added unit test for LOD filtering (`src/render/lodCoordinator.test.ts`).
- Rendering API unchanged; this is a filtering layer you can wire between camera and renderer.

## How to test manually
1. Set `lodZooms` thresholds in `src/config.ts` (e.g., Z1=0.6, Z2=1.2).
2. Enable LOD filtering in your rendering pipeline by calling `filterEdgesByLOD(mapIndex, edges, zoom)` before drawing a chunk.
3. Run the unit test:  
   ```bash
   node --loader ts-node/esm src/render/lodCoordinator.test.ts
   ```
4. Inspect draw counts or visuals: at low zoom only major roads render; medium zoom shows primary/secondary; high zoom shows all.

## Acceptance criteria
- At low zoom, minor streets are filtered out (or de-emphasized) using the LOD thresholds.
- When zooming in, higher LOD is requested only for nearby chunks.
- Visual output remains correct; only the intended road classes render per zoom level.
