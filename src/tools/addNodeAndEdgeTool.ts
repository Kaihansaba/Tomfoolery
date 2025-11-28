import { RoadNetworkImpl } from '../../road_network_impl';
import { Node, Edge, Lane } from '../../traffic_sim_interfaces';

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
  targetNodeId?: string,
  laneContext?: { lane: Lane; s: number }
): { newNode?: Node; newEdge?: Edge } | null {
  if (!state.active) return null;

  const pointOnLane = (lane: Lane, s: number) => {
    let remaining = s;
    for (let i = 0; i < lane.centerline.length - 1; i++) {
      const p0 = lane.centerline[i];
      const p1 = lane.centerline[i + 1];
      const segLen =
        Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1e-6;
      if (remaining <= segLen) {
        const t = remaining / segLen;
        return {
          x: p0.x + (p1.x - p0.x) * t,
          y: p0.y + (p1.y - p0.y) * t,
        };
      }
      remaining -= segLen;
    }
    const last = lane.centerline[lane.centerline.length - 1];
    return { x: last.x, y: last.y };
  };

  const attachToLaneEnds = (nodeId: string, lane: Lane, s: number) => {
    const edge = network.getEdge(lane.edgeId);
    if (!edge) return;
    const startPos = pointOnLane(lane, Math.max(0, Math.min(lane.length, s)));
    // Connect upstream
    const upId = `user_edge_${addEdgeCounter++}`;
    network.addEdge({
      id: upId,
      fromNode: edge.fromNode,
      toNode: nodeId,
      lanes: [],
      laneCount: edge.laneCount,
      geometry: [edge.geometry[0] ?? startPos, startPos],
      roadType: edge.roadType,
      oneWay: edge.oneWay,
      metadata: { direction: edge.metadata?.direction ?? 'forward', attached: true },
    });
    // Connect downstream
    const downId = `user_edge_${addEdgeCounter++}`;
    network.addEdge({
      id: downId,
      fromNode: nodeId,
      toNode: edge.toNode,
      lanes: [],
      laneCount: edge.laneCount,
      geometry: [startPos, edge.geometry[edge.geometry.length - 1] ?? startPos],
      roadType: edge.roadType,
      oneWay: edge.oneWay,
      metadata: { direction: edge.metadata?.direction ?? 'forward', attached: true },
    });
  };

  // First click: create new node
  if (!state.pendingNodeId) {
    const pos =
      laneContext && laneContext.lane.centerline.length > 1
        ? pointOnLane(laneContext.lane, laneContext.s)
        : { x: worldPos.x, y: worldPos.y };
    const nodeId = `user_node_${addNodeCounter++}`;
    const node: Node = {
      id: nodeId,
      position: pos,
      type: 'waypoint',
      incomingEdges: [],
      outgoingEdges: [],
    };
    network.addNode(node);
    if (laneContext) {
      attachToLaneEnds(nodeId, laneContext.lane, laneContext.s);
    }
    state.pendingNodeId = nodeId;
    return { newNode: node };
  }

  // Second click: existing node must be provided
  if (!targetNodeId && !laneContext) return null;
  let destNodeId = targetNodeId;
  if (!destNodeId && laneContext) {
    const pos = pointOnLane(laneContext.lane, laneContext.s);
    const nodeId = `user_node_${addNodeCounter++}`;
    const node: Node = {
      id: nodeId,
      position: pos,
      type: 'waypoint',
      incomingEdges: [],
      outgoingEdges: [],
    };
    network.addNode(node);
    destNodeId = nodeId;
    attachToLaneEnds(nodeId, laneContext.lane, laneContext.s);
  }

  const from = state.direction === 'backward' ? targetNodeId : state.pendingNodeId;
  const to = state.direction === 'backward' ? state.pendingNodeId : destNodeId;
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
