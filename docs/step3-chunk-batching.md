# Step 3 – Chunk-level batching (feature-flagged)

## What changed
- Added `config.optimizations.chunkBatching` (default false).
- Added `mergeLinesToBuffer` utility (`src/render/batching.ts`) to merge multiple line geometries into a single vertex/index buffer per chunk, reducing draw calls without changing the public draw API.
- Added a small unit test for the merger (`src/render/batching.test.ts`).
- No renderer wiring changed yet; batching is available behind the flag.

## How to test manually
1. Enable `chunkBatching` in `src/config.ts`.
2. Run the merger test:  
   ```bash
   node --loader ts-node/esm src/render/batching.test.ts
   ```
3. (Optional) instrument your renderer to use `mergeLinesToBuffer` per chunk and log draw-call counts; verify counts drop when batching is used.

## Acceptance criteria
- Merging multiple street lines into a single buffer works (unit test passes).
- Draw-call count can be reduced per chunk when batching is applied (verifiable via instrumentation).
- Visual output remains unchanged when the merged buffer is used instead of per-line draws.
