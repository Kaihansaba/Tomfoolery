import { Edge, Node } from '../traffic_sim_interfaces';

export type Subnetwork = {
  nodes: Record<string, Node>;
  edges: Record<string, Edge>;
  boundary: { inlets: string[]; outlets: string[] };
};

export function extractSubnetwork(
  fullNodes: Map<string, Node>,
  fullEdges: Map<string, Edge>,
  selectedIds: Set<string>
): Subnetwork {
  const nodes: Record<string, Node> = {};
  const edges: Record<string, Edge> = {};
  const inlets = new Set<string>();
  const outlets = new Set<string>();

  for (const id of selectedIds) {
    const n = fullNodes.get(id);
    if (n) nodes[id] = n;
  }

  for (const e of fullEdges.values()) {
    const inSel = selectedIds.has(e.fromNode);
    const outSel = selectedIds.has(e.toNode);
    if (inSel && outSel) {
      edges[e.id] = e;
    } else if (inSel && !outSel) {
      outlets.add(e.fromNode);
    } else if (!inSel && outSel) {
      inlets.add(e.toNode);
    }
  }

  return {
    nodes,
    edges,
    boundary: {
      inlets: Array.from(inlets),
      outlets: Array.from(outlets),
    },
  };
}

export function launchSubSimulation(json: Subnetwork) {
  // Basic launcher: open a new tab with JSON for now.
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
}
