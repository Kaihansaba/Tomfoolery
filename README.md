# Tomfoolery

Interactive traffic simulation prototype built with React, Vite, and a custom physics/behavioral model.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer (installs `npm`)
- Modern browser with WebGL 2 support (Chrome, Edge, Firefox, etc.)

## Getting started

```powershell
# 1. Install dependencies
npm install

# 2. Run the Vite dev server
npm run dev

# 3. Open the printed URL (default http://localhost:5173)
```

If `npm` is not available in your shell, install Node.js first and then restart the terminal so that `node`/`npm` are on your `PATH`.

## Project structure

- `src/` – Vite entrypoint and global styles
- `traffic_sim_webapp.tsx` – React UI that renders the simulation canvas and controls
- `simulation_engine.ts`, `road_network_impl.ts`, `traffic_sim_models.ts`, `traffic_sim_interfaces.ts` – numerical simulation core
- `example_networks.json` – sample scenarios selectable from the sidebar
- `worker_plugin_system.ts` – optional extension hooks for custom logic

## Available scripts

| Command        | Description                               |
| -------------- | ----------------------------------------- |
| `npm run dev`  | Start Vite dev server with hot reloading  |
| `npm run build`| Type-check and create a production build  |
| `npm run preview` | Serve the production build locally     |

## Troubleshooting

- **Canvas is blank** – ensure the browser tab has focus and GPU acceleration is enabled.
- **`npm` command not found** – install Node.js 18+, reopen your terminal, then rerun the commands above.
- **Typescript errors about JSON imports** – delete `node_modules`, run `npm install` to ensure `tsconfig.json` is picked up by the compiler.