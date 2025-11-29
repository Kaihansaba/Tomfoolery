# Tomfoolery

Interactive traffic simulation prototype built with React, Vite, and a custom physics/behavior model. Features dynamic OSM chunk loading, micro/macro modes, heatmaps, and in-app tools for editing the network.

## Highlights
- Live OSM/Overpass chunk loading (800m tiles) with lane geometry, traffic lights, hotspots, and crosswalks.
- Micro-level car-following (IDM) and lane changing (MOBIL) with congestion protections; macro heatmap view for zoomed-out performance.
- Canvas renderer with backdrop tiles, edge styling, vehicle sprites, and optional edge hiding for FPS headroom.
- In-app editing: add/remove roads, obstacles, spawn points, traffic lights; select subnetworks and launch sub-simulations.
- Hotspot-aware spawning to steer vehicles toward meaningful POIs (parking, schools, stations, etc.).

## Prerequisites

- Node.js 18+ (includes `npm`)
- Modern browser with hardware acceleration enabled

## Getting started

```powershell
# Install dependencies
npm install

# Run the dev server
npm run dev

# Open the printed URL (defaults to http://localhost:5173)
```

## Project structure

- `traffic_sim_webapp.tsx` - React UI, canvas renderer, tools, controls
- `simulation_engine.ts` - simulation loop, car-following, lane changes
- `road_network_impl.ts` - network storage, geometry utilities
- `traffic_sim_models.ts` - IDM/MOBIL parameter sets
- `traffic_sim_interfaces.ts` - shared types
- `src/` - config, utils, Overpass helpers, assets
- `example_networks.json` - sample scenarios
- `docs/` - loading and LOD design notes

## Data loading
- Dynamic Overpass query pulls `way["highway"]` plus POI nodes and `node["highway"="crossing"]` for crosswalks inside the visible 800m tiles.
- Network chunks are merged into the in-memory graph; duplicates are filtered by ID and crosswalks are also thinned within ~60m to avoid dense clusters.
- Geo coords are projected via `geoToWorld` using the scenario `geoReference`; `worldToGeo` is used for debugging/logging chunk centers.

## Crosswalk behavior
- Crosswalks come from OSM `highway=crossing` nodes. If snapping to a lane fails, they still render but do not affect traffic.
- Each crosswalk runs a 12s cycle: active (red for cars) for 3s, inactive for the remaining 9s.
- Vehicles approaching an active crosswalk decelerate; within ~2m they stop, wait 3s, then resume.
- Backwards compatible: if no crossings are present, nothing changes; deduplication keeps only one crossing within ~60m to reduce hotspots.

## Scripts

| Command           | Description                         |
| ----------------- | ----------------------------------- |
| `npm run dev`     | Start Vite dev server               |
| `npm run build`   | Type-check and build for production |
| `npm run preview` | Serve the production build locally  |

## Controls and tips

- Scroll/pinch to zoom, drag to pan. Press Escape to clear selection/tools.
- Tools drawer: add node+edge, select subnetworks, delete nodes/edges, place/remove obstacles, spawn points, traffic lights.
- Heatmap is always on; hide edges/backdrop from the tools toggle if you need FPS headroom. Macro view skips per-vehicle drawing at low zoom but keeps heatmaps.

## Troubleshooting

- Blank canvas: ensure the tab is focused and hardware acceleration is on.
- `npm` not found: install Node.js 18+, restart the terminal, rerun commands.
- Stale deps or TS errors: remove `node_modules`, run `npm install` again.
