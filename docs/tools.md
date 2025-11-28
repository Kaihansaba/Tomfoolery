# New Tools

## Add Node + Draw Edge
- Toggle the tool in the UI (Add Node/Edge panel).
- Click on the map to place a new node.
- Click an existing node to connect it. Configure lanes (1–4) and direction (forward/backward/bidirectional).
- Press ESC to cancel.

## Subnetwork Simulation Extractor
- Toggle Subnetwork mode.
- Click nodes to add/remove them from the selection. Selected nodes and their internal edges are highlighted.
- Click “Extract Sub-Simulation” to build the isolated JSON; it is kept in memory and can be downloaded as `subsimulation.json`.
- Boundary nodes (inlets/outlets) are identified where selected nodes connect to outside nodes.
- `launchSubSimulation(json)` opens the extracted JSON in a new tab (placeholder runner).

Tests:
- `node --loader ts-node/esm src/tools/subnetworkExtractor.test.ts`
- `node --loader ts-node/esm src/tools/addNodeAndEdgeTool.test.ts` (if added)
