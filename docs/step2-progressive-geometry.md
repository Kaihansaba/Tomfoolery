# Step 2 – Progressive Geometry Upload (feature-flagged)

## What changed
- Added `ChunkManager` to track per-chunk states (`UNLOADED → INDEXED → GEOMETRY_READY → UPLOADED`).
- Added `uploadBuffersToGPU` helper to guard uploads by visibility and feature flag.
- Added `config.optimizations.progressiveGeometry` flag (default: false).
- Added small unit test for chunk state transitions.

## How to test manually
1. Enable the flag in `src/config.ts` (`progressiveGeometry = true`).
2. (Optional) Simulate slow network via browser devtools throttling.
3. Run the app and pan/zoom; chunks should only upload once geometry is ready and visible. No errors about missing geometry.
4. Run the test:  
   ```bash
   node --loader ts-node/esm src/utils/chunkManager.test.ts
   ```

## Acceptance criteria
- No rendering/upload attempts for chunks until geometry is marked `GEOMETRY_READY`.
- Uploads are idempotent and gated by visibility.
- Clicking nodes/edges still works even if geometry hasn’t uploaded yet (visuals may appear after upload).
