import { writeFileSync } from "fs";
import fetch from "node-fetch";

const query = `
[out:json][timeout:25];
area["name"="Heilbronn"]["boundary"="administrative"]->.searchArea;
way["highway"](area.searchArea);
(._;>;);
out;
`;

interface OSMNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

interface OSMWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

type OSMElement =
  | OSMNode
  | OSMWay
  | {
      type?: string;
      tags?: Record<string, string>;
      [key: string]: unknown;
    };

interface OSMResponse {
  elements: OSMElement[];
}

export interface NetworkJSON {
  version: string;
  metadata?: {
    name?: string;
    description?: string;
    author?: string;
    created?: string;
  };
  nodes: Array<{
    id: string;
    x: number;
    y: number;
    type: string;
    properties?: Record<string, any>;
  }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    lanes: number;
    geometry?: Array<{ x: number; y: number }>;
    speedLimit?: number;
    roadType?: string;
    properties?: Record<string, any>;
  }>;
  intersections?: Array<{
    nodeId: string;
    type: string;
    signalPhases?: any[];
  }>;
}

async function fetchOSM(): Promise<OSMResponse> {
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: query,
    headers: { "Content-Type": "text/plain" }
  });

  if (!res.ok) {
    throw new Error(`Overpass error: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<OSMResponse>;
}

async function main() {
  const osm = await fetchOSM();

  const nodeMap: Record<number, OSMNode> = {};
  osm.elements
    .filter((e): e is OSMNode => e.type === "node")
    .forEach((node) => {
      nodeMap[node.id] = node;
    });

  const nodes: NetworkJSON["nodes"] = [];
  const edges: NetworkJSON["edges"] = [];
  const intersections: NonNullable<NetworkJSON["intersections"]> = [];
  const nodeUseCount: Record<number, number> = {};

  osm.elements
    .filter(
      (e): e is OSMWay =>
        e.type === "way" && typeof (e as OSMWay).tags?.highway === "string"
    )
    .forEach((way) => {
      const nodesInEdge = way.nodes;
      const tags = way.tags ?? {};

      nodesInEdge.forEach((nodeId) => {
        nodeUseCount[nodeId] = (nodeUseCount[nodeId] || 0) + 1;
      });

      const geometry = nodesInEdge.map((nodeId) => ({
        x: nodeMap[nodeId]?.lon,
        y: nodeMap[nodeId]?.lat
      }));

      const edge = {
        id: `edge_${way.id}`,
        from: String(nodesInEdge[0]),
        to: String(nodesInEdge[nodesInEdge.length - 1]),
        lanes: parseInt(tags.lanes ?? "1", 10),
        geometry,
        speedLimit: parseInt(tags.maxspeed ?? "50", 10),
        roadType: tags.highway,
        properties: tags
      };

      edges.push(edge);
    });

  Object.values(nodeMap).forEach((node) => {
    nodes.push({
      id: String(node.id),
      x: node.lon,
      y: node.lat,
      type: nodeUseCount[node.id] > 1 ? "intersection" : "point",
      properties: {}
    });
  });

  Object.entries(nodeUseCount)
    .filter(([, count]) => count > 1)
    .forEach(([nodeId]) => {
      intersections.push({
        nodeId,
        type: "traffic",
        signalPhases: []
      });
    });

  const network: NetworkJSON = {
    version: "1.0",
    metadata: {
      name: "Generated Road Network",
      created: new Date().toISOString()
    },
    nodes,
    edges,
    intersections
  };

  writeFileSync("heilbronnperchance.json", JSON.stringify(network, null, 2));
  console.log("✔ heilbronnperchance.json generated!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

