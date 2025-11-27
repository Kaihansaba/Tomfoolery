// ============================================================================
// ROAD NETWORK IMPLEMENTATION
// ============================================================================

import {
  RoadNetwork,
  Node,
  Edge,
  Lane,
  Intersection,
  NodeID,
  EdgeID,
  LaneID,
  Vector2D,
  NetworkJSON,
  ISpatialIndex,
} from './traffic_sim_interfaces';

export class RoadNetworkImpl implements RoadNetwork {
  nodes: Map<NodeID, Node> = new Map();
  edges: Map<EdgeID, Edge> = new Map();
  lanes: Map<LaneID, Lane> = new Map();
  intersections: Map<NodeID, Intersection> = new Map();
  spatialIndex?: ISpatialIndex;
  
  // =========================================================================
  // BASIC ACCESSORS
  // =========================================================================
  
  getNode(id: NodeID): Node | undefined {
    return this.nodes.get(id);
  }
  
  getEdge(id: EdgeID): Edge | undefined {
    return this.edges.get(id);
  }
  
  getLane(id: LaneID): Lane | undefined {
    return this.lanes.get(id);
  }
  
  getIntersection(nodeId: NodeID): Intersection | undefined {
    return this.intersections.get(nodeId);
  }
  
  // =========================================================================
  // NETWORK CONSTRUCTION
  // =========================================================================
  
  addNode(node: Node): void {
    this.nodes.set(node.id, node);
  }
  
  addEdge(edge: Edge): void {
    this.edges.set(edge.id, edge);
    
    // Generate lanes for this edge
    this.generateLanes(edge);
    
    // Update node connections
    const fromNode = this.nodes.get(edge.fromNode);
    const toNode = this.nodes.get(edge.toNode);
    
    if (fromNode) {
      if (!fromNode.outgoingEdges.includes(edge.id)) {
        fromNode.outgoingEdges.push(edge.id);
      }
    }
    
    if (toNode) {
      if (!toNode.incomingEdges.includes(edge.id)) {
        toNode.incomingEdges.push(edge.id);
      }
    }
  }
  
  private generateLanes(edge: Edge): void {
    const laneWidth = 3.5; // meters (standard lane width)
    
    // Generate centerline from geometry
    const centerline = this.generateCenterline(edge.geometry);
    const length = this.calculateArcLength(centerline);
    
    // Create lanes
    for (let i = 0; i < edge.laneCount; i++) {
      const laneId = `${edge.id}_lane_${i}`;
      
      // Offset centerline for each lane
      const offset = (i - (edge.laneCount - 1) / 2) * laneWidth;
      const laneCenterline = this.offsetCurve(centerline, offset);
      
      const lane: Lane = {
        id: laneId,
        edgeId: edge.id,
        index: i,
        centerline: laneCenterline,
        width: laneWidth,
        length,
        speedLimit: 30, // Default, should be set from edge properties
        laneType: 'driving',
        predecessors: [],
        successors: [],
      };
      
      // Set neighbors
      if (i > 0) {
        lane.rightNeighbor = `${edge.id}_lane_${i - 1}`;
      }
      if (i < edge.laneCount - 1) {
        lane.leftNeighbor = `${edge.id}_lane_${i + 1}`;
      }
      
      this.lanes.set(laneId, lane);
      edge.lanes.push(lane);
    }
    
    // Connect lanes to predecessors/successors at nodes
    this.connectLanes(edge);
  }
  
  private generateCenterline(geometry: Vector2D[]): Vector2D[] {
    if (geometry.length < 2) {
      throw new Error('Edge geometry must have at least 2 points');
    }
    
    // If only 2 points, return straight line
    if (geometry.length === 2) {
      return this.interpolateLinear(geometry[0], geometry[1], 20);
    }
    
    // Use Catmull-Rom spline for smooth curves
    return this.interpolateCatmullRom(geometry, 50);
  }
  
  private interpolateLinear(p0: Vector2D, p1: Vector2D, segments: number): Vector2D[] {
    const result: Vector2D[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      result.push({
        x: p0.x + (p1.x - p0.x) * t,
        y: p0.y + (p1.y - p0.y) * t,
      });
    }
    return result;
  }
  
  private interpolateCatmullRom(points: Vector2D[], segments: number): Vector2D[] {
    const result: Vector2D[] = [];
    const n = points.length;
    
    for (let i = 0; i < n - 1; i++) {
      const p0 = i > 0 ? points[i - 1] : points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = i < n - 2 ? points[i + 2] : points[i + 1];
      
      const segmentsForCurve = i === n - 2 ? segments + 1 : segments;
      
      for (let j = 0; j < segmentsForCurve; j++) {
        const t = j / segments;
        const t2 = t * t;
        const t3 = t2 * t;
        
        const x = 0.5 * (
          2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
        );
        
        const y = 0.5 * (
          2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
        );
        
        result.push({ x, y });
      }
    }
    
    return result;
  }
  
  private calculateArcLength(polyline: Vector2D[]): number {
    let length = 0;
    for (let i = 0; i < polyline.length - 1; i++) {
      const dx = polyline[i + 1].x - polyline[i].x;
      const dy = polyline[i + 1].y - polyline[i].y;
      length += Math.sqrt(dx * dx + dy * dy);
    }
    return length;
  }
  
  private offsetCurve(centerline: Vector2D[], offset: number): Vector2D[] {
    const result: Vector2D[] = [];
    
    for (let i = 0; i < centerline.length; i++) {
      const p = centerline[i];
      
      // Calculate tangent direction
      let tangent: Vector2D;
      if (i === 0) {
        tangent = {
          x: centerline[1].x - centerline[0].x,
          y: centerline[1].y - centerline[0].y,
        };
      } else if (i === centerline.length - 1) {
        tangent = {
          x: centerline[i].x - centerline[i - 1].x,
          y: centerline[i].y - centerline[i - 1].y,
        };
      } else {
        tangent = {
          x: centerline[i + 1].x - centerline[i - 1].x,
          y: centerline[i + 1].y - centerline[i - 1].y,
        };
      }
      
      // Normalize
      const len = Math.sqrt(tangent.x * tangent.x + tangent.y * tangent.y);
      tangent.x /= len;
      tangent.y /= len;
      
      // Normal is perpendicular (rotated 90 degrees CCW)
      const normal = { x: -tangent.y, y: tangent.x };
      
      // Apply offset
      result.push({
        x: p.x + normal.x * offset,
        y: p.y + normal.y * offset,
      });
    }
    
    return result;
  }
  
  private connectLanes(edge: Edge): void {
    const toNode = this.nodes.get(edge.toNode);
    if (!toNode) return;
    
    // For each outgoing edge from toNode
    for (const outgoingEdgeId of toNode.outgoingEdges) {
      if (outgoingEdgeId === edge.id) continue;
      
      const outgoingEdge = this.edges.get(outgoingEdgeId);
      if (!outgoingEdge) continue;
      
      // Connect compatible lanes (simple heuristic: same index)
      for (const lane of edge.lanes) {
        const targetIndex = Math.min(lane.index, outgoingEdge.lanes.length - 1);
        const targetLane = outgoingEdge.lanes[targetIndex];
        
        if (targetLane) {
          lane.successors.push(targetLane.id);
          targetLane.predecessors.push(lane.id);
        }
      }
    }
  }

  /**
   * Recompute successor and predecessor lane links for the entire network.
   * Useful after bulk-loading edges so vehicles can traverse contiguous roads.
   */
  rebuildLaneConnectivity(): void {
    // Clear existing connectivity
    for (const lane of this.lanes.values()) {
      lane.successors = [];
      lane.predecessors = [];
    }

    for (const node of this.nodes.values()) {
      const incoming = node.incomingEdges
        .map(id => this.edges.get(id))
        .filter((edge): edge is Edge => Boolean(edge));
      const outgoing = node.outgoingEdges
        .map(id => this.edges.get(id))
        .filter((edge): edge is Edge => Boolean(edge));

      for (const inEdge of incoming) {
        for (const outEdge of outgoing) {
          if (inEdge.id === outEdge.id) continue;

          for (const lane of inEdge.lanes) {
            const targetIndex = Math.min(lane.index, outEdge.lanes.length - 1);
            const targetLane = outEdge.lanes[targetIndex];
            if (!targetLane) continue;

            if (!lane.successors.includes(targetLane.id)) {
              lane.successors.push(targetLane.id);
            }
            if (!targetLane.predecessors.includes(lane.id)) {
              targetLane.predecessors.push(lane.id);
            }
          }
        }
      }
    }
  }
  
  // =========================================================================
  // TOPOLOGY QUERIES
  // =========================================================================
  
  getAdjacentLanes(laneId: LaneID): Lane[] {
    const lane = this.lanes.get(laneId);
    if (!lane) return [];
    
    const adjacent: Lane[] = [];
    
    if (lane.leftNeighbor) {
      const left = this.lanes.get(lane.leftNeighbor);
      if (left) adjacent.push(left);
    }
    
    if (lane.rightNeighbor) {
      const right = this.lanes.get(lane.rightNeighbor);
      if (right) adjacent.push(right);
    }
    
    return adjacent;
  }
  
  getLaneAt(position: Vector2D): LaneID | undefined {
    // Find closest lane to position
    let closestLane: LaneID | undefined;
    let minDistance = Infinity;
    
    for (const [laneId, lane] of this.lanes.entries()) {
      const distance = this.distanceToLane(position, lane);
      if (distance < minDistance && distance < lane.width / 2) {
        minDistance = distance;
        closestLane = laneId;
      }
    }
    
    return closestLane;
  }
  
  private distanceToLane(point: Vector2D, lane: Lane): number {
    let minDist = Infinity;
    
    for (let i = 0; i < lane.centerline.length - 1; i++) {
      const p0 = lane.centerline[i];
      const p1 = lane.centerline[i + 1];
      const dist = this.distanceToSegment(point, p0, p1);
      minDist = Math.min(minDist, dist);
    }
    
    return minDist;
  }
  
  private distanceToSegment(p: Vector2D, a: Vector2D, b: Vector2D): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    
    if (lengthSq === 0) {
      const dpx = p.x - a.x;
      const dpy = p.y - a.y;
      return Math.sqrt(dpx * dpx + dpy * dpy);
    }
    
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    
    const dpx = p.x - projX;
    const dpy = p.y - projY;
    return Math.sqrt(dpx * dpx + dpy * dpy);
  }
  
  // =========================================================================
  // PATHFINDING (Simple shortest path)
  // =========================================================================
  
  findRoute(fromLane: LaneID, toLane: LaneID): LaneID[] {
    // Simplified A* on lane graph
    const openSet = new Set<LaneID>([fromLane]);
    const cameFrom = new Map<LaneID, LaneID>();
    const gScore = new Map<LaneID, number>();
    const fScore = new Map<LaneID, number>();
    
    gScore.set(fromLane, 0);
    fScore.set(fromLane, this.heuristic(fromLane, toLane));
    
    while (openSet.size > 0) {
      // Find node with lowest fScore
      let current: LaneID | undefined;
      let minF = Infinity;
      
      for (const id of openSet) {
        const f = fScore.get(id) || Infinity;
        if (f < minF) {
          minF = f;
          current = id;
        }
      }
      
      if (!current) break;
      
      if (current === toLane) {
        return this.reconstructPath(cameFrom, current);
      }
      
      openSet.delete(current);
      const currentLane = this.lanes.get(current);
      if (!currentLane) continue;
      
      // Check successors
      for (const successor of currentLane.successors) {
        const tentativeG = (gScore.get(current) || 0) + currentLane.length;
        
        if (tentativeG < (gScore.get(successor) || Infinity)) {
          cameFrom.set(successor, current);
          gScore.set(successor, tentativeG);
          fScore.set(successor, tentativeG + this.heuristic(successor, toLane));
          openSet.add(successor);
        }
      }
    }
    
    return []; // No path found
  }
  
  private heuristic(laneA: LaneID, laneB: LaneID): number {
    const a = this.lanes.get(laneA);
    const b = this.lanes.get(laneB);
    
    if (!a || !b) return Infinity;
    
    // Euclidean distance between lane endpoints
    const aEnd = a.centerline[a.centerline.length - 1];
    const bEnd = b.centerline[b.centerline.length - 1];
    
    const dx = bEnd.x - aEnd.x;
    const dy = bEnd.y - aEnd.y;
    
    return Math.sqrt(dx * dx + dy * dy);
  }
  
  private reconstructPath(cameFrom: Map<LaneID, LaneID>, current: LaneID): LaneID[] {
    const path = [current];
    
    while (cameFrom.has(current)) {
      current = cameFrom.get(current)!;
      path.unshift(current);
    }
    
    return path;
  }
  
  // =========================================================================
  // SERIALIZATION
  // =========================================================================
  
  toJSON(): NetworkJSON {
    return {
      version: '1.0',
      nodes: Array.from(this.nodes.values()).map(node => ({
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        type: node.type,
        properties: node.metadata,
      })),
      edges: Array.from(this.edges.values()).map(edge => ({
        id: edge.id,
        from: edge.fromNode,
        to: edge.toNode,
        lanes: edge.laneCount,
        geometry: edge.geometry,
        speedLimit: edge.lanes[0]?.speedLimit,
        roadType: edge.roadType,
        properties: edge.metadata,
      })),
      intersections: Array.from(this.intersections.values()).map(intersection => ({
        nodeId: intersection.nodeId,
        type: intersection.type,
        signalPhases: intersection.signalPhases,
      })),
    };
  }

  // Convert lat/lon style networks into a local meter-based frame to keep rendering scales stable.
  private static normalizeCoordinates(json: NetworkJSON): NetworkJSON {
    if (!json.nodes || json.nodes.length === 0) {
      return json;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of json.nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }

    const width = maxX - minX;
    const height = maxY - minY;

    const looksLikeLatLon =
      minX >= -180 &&
      maxX <= 180 &&
      minY >= -90 &&
      maxY <= 90 &&
      width < 5 &&
      height < 5;

    if (!looksLikeLatLon) {
      return json;
    }

    const originLat = (minY + maxY) / 2;
    const originLon = (minX + maxX) / 2;
    const metersPerDegLat = 111320;
    const metersPerDegLon = Math.cos((originLat * Math.PI) / 180) * 111320;

    const project = (pt: { x: number; y: number }) => ({
      x: (pt.x - originLon) * metersPerDegLon,
      y: (pt.y - originLat) * metersPerDegLat,
    });

    return {
      ...json,
      nodes: json.nodes.map(node => {
        const projected = project({ x: node.x, y: node.y });
        return { ...node, x: projected.x, y: projected.y };
      }),
      edges: json.edges.map(edge => ({
        ...edge,
        geometry: (edge.geometry || []).map(pt => project(pt)),
      })),
    };
  }

  static fromJSON(json: NetworkJSON): RoadNetworkImpl {
    const normalized = RoadNetworkImpl.normalizeCoordinates(json);
    const network = new RoadNetworkImpl();
    
    // Add nodes
    for (const nodeData of normalized.nodes) {
      const node: Node = {
        id: nodeData.id,
        position: { x: nodeData.x, y: nodeData.y },
        type: nodeData.type as any,
        incomingEdges: [],
        outgoingEdges: [],
        metadata: nodeData.properties,
      };
      network.addNode(node);
    }
    
    // Add edges
    for (const edgeData of normalized.edges) {
      const edge: Edge = {
        id: edgeData.id,
        fromNode: edgeData.from,
        toNode: edgeData.to,
        lanes: [],
        laneCount: edgeData.lanes,
        geometry: edgeData.geometry || [],
        roadType: (edgeData.roadType as any) || 'local',
        oneWay: true,
        name: edgeData.properties?.name,
        metadata: edgeData.properties,
      };
      
      // If no geometry provided, use straight line
      if (edge.geometry.length === 0) {
        const fromNode = network.getNode(edge.fromNode);
        const toNode = network.getNode(edge.toNode);
        if (fromNode && toNode) {
          edge.geometry = [fromNode.position, toNode.position];
        }
      }
      
      network.addEdge(edge);
      
      // Update speed limits if provided
      if (edgeData.speedLimit) {
        for (const lane of edge.lanes) {
          lane.speedLimit = edgeData.speedLimit;
        }
      }
    }
    
    // Add intersections
    if (normalized.intersections) {
      for (const intData of normalized.intersections) {
        const intersection: Intersection = {
          nodeId: intData.nodeId,
          type: intData.type as any,
          signalPhases: intData.signalPhases,
          movements: [], // Would be computed from topology
        };
        network.intersections.set(intersection.nodeId, intersection);
      }
    }

    // Ensure lane connectivity across edge boundaries
    network.rebuildLaneConnectivity();
    
    return network;
  }
}
