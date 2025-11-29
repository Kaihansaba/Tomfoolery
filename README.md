# Tomfoolery

Interactive traffic simulation prototype built with React, Vite, and a custom physics/behavior model. Features dynamic OSM chunk loading, micro/macro modes, heatmaps, and in-app tools for editing the network.

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

- `traffic_sim_webapp.tsx` — React UI, canvas renderer, tools, controls
- `simulation_engine.ts` — simulation loop, car-following, lane changes
- `road_network_impl.ts` — network storage, geometry utilities
- `traffic_sim_models.ts` — IDM/MOBIL parameter sets
- `traffic_sim_interfaces.ts` — shared types
- `src/` — config, utils, Overpass helpers, assets
- `example_networks.json` — sample scenarios
- `docs/` — loading and LOD design notes

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
