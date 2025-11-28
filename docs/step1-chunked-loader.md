# Step 1 – Chunked Index Loader (feature-flagged)

## What changed
- Added a lightweight map parser worker (`src/workers/mapParser.worker.ts`) that parses OSM JSON off the main thread and produces a small `mapIndex` (chunk bbox + counts + major road ids).
- Added `fastIndexLoad` helper and `chunkedIndex` feature flag (`src/config.ts`).
- Added a minimal unit test for the parser (`src/utils/mapLoader.test.ts`).
- Existing full JSON loader is untouched; rendering behavior is unchanged.

## How to test manually
1. Enable the flag: set `config.optimizations.chunkedIndex = true` in `src/config.ts`.
2. Run `npm run build` (or `npm run dev`) and open the app.
3. Observe the console: the app should become interactive while the worker produces the `mapIndex` without blocking the UI.
4. Optional: run the parser test  
   ```bash
   node --loader ts-node/esm src/utils/mapLoader.test.ts
   ```

## Acceptance criteria
- With the flag on, the main thread is not blocked while the map index is produced (parsing happens in the worker).
- Nodes/edges remain functional via the existing loader; rendering is unchanged.
- Full JSON loader remains as a fallback when the flag is off.
