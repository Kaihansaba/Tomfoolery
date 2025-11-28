import { RoadNetworkImpl } from '../road_network_impl';
import { Node, Edge } from '../traffic_sim_interfaces';

export type AddNodeAndEdgeState = {
  active: boolean;
  pendingNodeId?: string;
  lanes: number;
  direction: 'forward' | 'backward' | 'bidirectional';
};

export function startAddNodeAndEdge(): AddNodeAndEdgeState {
  return { active: true, lanes: 1, direction: 'bidirectional' };
}

export function cancelAddNodeAndEdge(state: AddNodeAndEdgeState) {
  state.pendingNodeId = undefined;
  state.active = false;
}

export function setLanes(state: AddNodeAndEdgeState, lanes: number) {
  state.lanes = Math.max(1, Math.min(4, Math.round(lanes)));
}

export function setDirection(state: AddNodeAndEdgeState, dir: AddNodeAndEdgeState['direction']) {
  state.direction = dir;
}

let addNodeCounter = 100000;
let addEdgeCounter = 200000;

export function handleAddNodeEdgeClick(
  state: AddNodeAndEdgeState,
  network: RoadNetworkImpl,
  worldPos: { x: number; y: number },
  targetNodeId?: string
): { newNode?: Node; newEdge?: Edge } | null {
  if (!state.active) return null;

  // First click: create new node
  if (!state.pendingNodeId) {
    const nodeId = `user_node_${addNodeCounter++}`;
    const node: Node = {
      id: nodeId,
      position: { x: worldPos.x, y: worldPos.y },
      type: 'waypoint',
      incomingEdges: [],
      outgoingEdges: [],
    };
    network.addNode(node);
    state.pendingNodeId = nodeId;
    return { newNode: node };
  }

  // Second click: existing node must be provided
  if (!targetNodeId) return null;
  const from = state.direction === 'backward' ? targetNodeId : state.pendingNodeId;
  const to = state.direction === 'backward' ? state.pendingNodeId : targetNodeId;
  const edgeId = `user_edge_${addEdgeCounter++}`;
  const fromNode = network.getNode(from!);
  const toNode = network.getNode(to!);
  if (!fromNode || !toNode) return null;

  const edge: Edge = {
    id: edgeId,
    fromNode: from!,
    toNode: to!,
    lanes: [],
    laneCount: state.lanes,
    geometry: [fromNode.position, toNode.position],
    roadType: 'local',
    oneWay: state.direction !== 'bidirectional',
    metadata: { direction: state.direction },
  };
  network.addEdge(edge);
  network.rebuildLaneConnectivity();
  state.pendingNodeId = undefined;
  state.active = false;
  return { newEdge: edge };
}
