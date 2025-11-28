// ============================================================================
// SIMULATION ENGINE - Core orchestration and vehicle management
// ============================================================================

import {
  SimulationEngine,
  SimulationConfig,
  SimulationSnapshot,
  VehicleState,
  VehicleID,
  VehicleCategory,
  RoadNetwork,
  IDriverModel,
  ILaneChangeModel,
  ISpatialIndex,
  LaneID,
  DriverModelContext,
  BoundingBox,
  Vector2D,
  Lane,
  DEFAULT_VEHICLE_TYPES,
} from './traffic_sim_interfaces';

export class TrafficSimulationEngine implements SimulationEngine {
  currentTime: number = 0;
  vehicles: Map<VehicleID, VehicleState> = new Map();
  network: RoadNetwork;
  
  driverModels: Map<VehicleCategory, IDriverModel> = new Map();
  laneChangeModel!: ILaneChangeModel;
  
  spatialIndex: ISpatialIndex;
  
  private config: SimulationConfig;
  private frameAccumulator: number = 0;
  private laneChangeCooldown: Map<VehicleID, number> = new Map();
  
  constructor(network: RoadNetwork, config: SimulationConfig) {
    this.network = network;
    this.config = config;
    this.spatialIndex = this.createSpatialIndex(config.spatialIndexType);
  }
  
  private createSpatialIndex(type: 'quadtree' | 'rtree'): ISpatialIndex {
    const bounds = this.computeNetworkBounds();
    return new QuadTreeIndex(bounds);
  }

  private computeNetworkBounds(): BoundingBox {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const lane of this.network.lanes.values()) {
      for (const pt of lane.centerline) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
    }

    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
      return { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };
    }

    const padding = 50;
    return {
      minX: minX - padding,
      minY: minY - padding,
      maxX: maxX + padding,
      maxY: maxY + padding,
    };
  }

  private buildLaneVehicleMap(): Map<LaneID, VehicleState[]> {
    const laneVehicles = new Map<LaneID, VehicleState[]>();
    for (const vehicle of this.vehicles.values()) {
      const list = laneVehicles.get(vehicle.laneId) ?? [];
      list.push(vehicle);
      laneVehicles.set(vehicle.laneId, list);
    }

    for (const list of laneVehicles.values()) {
      list.sort((a, b) => a.lanePosition - b.lanePosition);
    }
    return laneVehicles;
  }

  private findLeaderInLane(
    laneId: LaneID,
    lanePosition: number,
    laneVehicles: Map<LaneID, VehicleState[]>,
    selfId?: VehicleID
  ): VehicleState | undefined {
    const list = laneVehicles.get(laneId);
    if (!list) return undefined;
    for (const other of list) {
      if (other.id === selfId) continue;
      if (other.lanePosition > lanePosition) {
        return other;
      }
    }
    return undefined;
  }

  private findLeaderDirect(laneId: LaneID, lanePosition: number, selfId?: VehicleID): VehicleState | undefined {
    let closest: VehicleState | undefined;
    let minDist = Infinity;
    for (const other of this.vehicles.values()) {
      if (other.id === selfId) continue;
      if (other.laneId !== laneId) continue;
      const gap = other.lanePosition - lanePosition;
      if (gap > 0 && gap < minDist) {
        minDist = gap;
        closest = other;
      }
    }
    return closest;
  }

  private findFollowerDirect(laneId: LaneID, lanePosition: number, selfId?: VehicleID): VehicleState | undefined {
    let closest: VehicleState | undefined;
    let minDist = Infinity;
    for (const other of this.vehicles.values()) {
      if (other.id === selfId) continue;
      if (other.laneId !== laneId) continue;
      const gap = lanePosition - other.lanePosition;
      if (gap > 0 && gap < minDist) {
        minDist = gap;
        closest = other;
      }
    }
    return closest;
  }

  private enforceMinimumGap(laneVehicles: Map<LaneID, VehicleState[]>): void {
    const minGap = 2.0;
    for (const [laneId, vehicles] of laneVehicles.entries()) {
      const lane = this.network.getLane(laneId);
      if (!lane) continue;

      let nextAllowed = vehicles.length > 0 ? vehicles[vehicles.length - 1].lanePosition : 0;
      for (let i = vehicles.length - 2; i >= 0; i--) {
        const follower = vehicles[i];
        const leader = vehicles[i + 1];
        const oldLanePosition = follower.lanePosition;
        
        const maxPosition = Math.max(0, nextAllowed - minGap);
        if (follower.lanePosition > maxPosition) {
          const gap = leader.lanePosition - follower.lanePosition;
          const adjustment = oldLanePosition - maxPosition;
          
          follower.lanePosition = maxPosition;
          follower.velocity = Math.min(follower.velocity, Math.max(0, vehicles[i + 1].velocity));
          follower.acceleration = Math.min(follower.acceleration, -1);
          this.updateGlobalPosition(follower, lane);
          
          if (adjustment > 1.0) {
            console.log(`⚠️ Vehicle ${follower.id} position reset: moved back ${adjustment.toFixed(2)}m (too close to ${leader.id}, gap was ${gap.toFixed(2)}m)`);
          }
        }
        nextAllowed = follower.lanePosition;
      }
    }
  }
  
  // =========================================================================
  // MAIN SIMULATION STEP
  // =========================================================================
  
  step(dt: number): void {
    this.frameAccumulator += dt;
    const timeStep = this.config.timeStep;
    
    // Fixed timestep with accumulator (for determinism)
    while (this.frameAccumulator >= timeStep) {
      const laneVehicles = this.buildLaneVehicleMap();

      this.handleLaneChanges(laneVehicles);
      this.updateVehicles(timeStep, laneVehicles);
      this.updatePositions(timeStep);

      const updatedLaneVehicles = this.buildLaneVehicleMap();
      this.enforceMinimumGap(updatedLaneVehicles);
      this.updateVehicleRelationships(updatedLaneVehicles);
      this.updateSpatialIndex();
      
      this.currentTime += timeStep;
      this.frameAccumulator -= timeStep;
    }
  }
  
  private updateVehicles(dt: number, laneVehicles: Map<LaneID, VehicleState[]>): void {
    for (const vehicle of this.vehicles.values()) {
      const model = this.driverModels.get(vehicle.type);
      if (!model) continue;

      const lane = this.network.getLane(vehicle.laneId);
      if (!lane) continue;

      const leader = this.findLeaderInLane(vehicle.laneId, vehicle.lanePosition, laneVehicles, vehicle.id);

      if (leader) {
        vehicle.leaderId = leader.id;
        const gap = leader.lanePosition - vehicle.lanePosition;
        const safeGap = 2.0;
        if (gap < safeGap) {
          const params = DEFAULT_VEHICLE_TYPES[vehicle.type]?.driver;
          const emergency = params ? -params.maxDecel * 1.5 : -8;
          vehicle.acceleration = emergency;
          continue;
        }
      } else {
        vehicle.leaderId = undefined;
      }

      const context: DriverModelContext = {
        vehicle,
        leader: leader ?? undefined,
        lane,
        network: this.network,
        dt,
      };
      
      vehicle.acceleration = model.calculateAcceleration(context);
    }
  }
  
  private handleLaneChanges(laneVehicles: Map<LaneID, VehicleState[]>): void {
    if (!this.laneChangeModel) return;
    
    const minCooldown = 1.8; // seconds
    
    for (const vehicle of this.vehicles.values()) {
      if (vehicle.isChangingLane) {
        this.updateLaneChangeProgress(vehicle);
        continue;
      }

      const lastChange = this.laneChangeCooldown.get(vehicle.id);
      if (lastChange !== undefined && this.currentTime - lastChange < minCooldown) {
        continue;
      }
      
      const currentLane = this.network.getLane(vehicle.laneId);
      if (!currentLane) continue;
      
      const adjacentLanes = this.network.getAdjacentLanes(vehicle.laneId);
      if (adjacentLanes.length === 0) continue;
      
      const decision = this.laneChangeModel.evaluateLaneChange(
        vehicle,
        currentLane,
        adjacentLanes,
        this.vehicles,
        this.network
      );
      
      if (decision.shouldChange && decision.targetLaneId) {
        console.log(`🚦 Vehicle ${vehicle.id} starting lane change: ${vehicle.laneId} → ${decision.targetLaneId}`);
        this.initiateLaneChange(vehicle, decision.targetLaneId);
        this.laneChangeCooldown.set(vehicle.id, this.currentTime);
      }
    }
  }
  
  private initiateLaneChange(vehicle: VehicleState, targetLaneId: LaneID): void {
    vehicle.isChangingLane = true;
    vehicle.targetLaneId = targetLaneId;
    vehicle.laneChangeProgress = 0;
  }
  
  private updateLaneChangeProgress(vehicle: VehicleState): void {
    if (!vehicle.targetLaneId || vehicle.laneChangeProgress === undefined) return;
    
    const oldLaneId = vehicle.laneId;
    const oldLanePosition = vehicle.lanePosition;
    
    const laneChangeDuration = 3.0; // seconds
    const progressIncrement = this.config.timeStep / laneChangeDuration;
    
    vehicle.laneChangeProgress += progressIncrement;
    
    const currentLane = this.network.getLane(vehicle.laneId);
    const targetLane = this.network.getLane(vehicle.targetLaneId);
    
    if (currentLane && targetLane) {
      const lateralDistance = (targetLane.index - currentLane.index) * currentLane.width;
      const k = 12; // controls steepness of sigmoid
      const logistic = (x: number) => 1 / (1 + Math.exp(-k * (x - 0.5)));
      const start = logistic(0);
      const end = logistic(1);
      const eased = Math.min(
        1,
        Math.max(0, (logistic(vehicle.laneChangeProgress) - start) / (end - start))
      );
      vehicle.laneOffset = lateralDistance * eased;
    }
    
    if (vehicle.laneChangeProgress >= 1.0) {
      const targetLaneId = vehicle.targetLaneId;
      if (targetLaneId) {
        const leader = this.findLeaderDirect(targetLaneId, vehicle.lanePosition, vehicle.id);
        const follower = this.findFollowerDirect(targetLaneId, vehicle.lanePosition, vehicle.id);
        const minMergeGap = 2.0;

        let newPos = vehicle.lanePosition;
        if (leader) {
          newPos = Math.min(newPos, leader.lanePosition - minMergeGap);
        }
        if (follower) {
          newPos = Math.max(newPos, follower.lanePosition + minMergeGap);
        }

        // If there is no room, abandon this lane change and keep the current lane.
        if (
          (leader && follower && leader.lanePosition - follower.lanePosition < minMergeGap * 2) ||
          newPos < 0 ||
          (leader && newPos > leader.lanePosition - minMergeGap) ||
          (follower && newPos < follower.lanePosition + minMergeGap)
        ) {
          console.log(`❌ Vehicle ${vehicle.id} aborted lane change: ${oldLaneId} → ${targetLaneId} (not enough space)`);
          vehicle.isChangingLane = false;
          vehicle.targetLaneId = undefined;
          vehicle.laneChangeProgress = undefined;
          vehicle.laneOffset = 0;
          this.laneChangeCooldown.set(vehicle.id, this.currentTime);
          return;
        }

        vehicle.laneId = targetLaneId;
        vehicle.lanePosition = newPos;
        const lane = this.network.getLane(targetLaneId);
        if (lane) {
          vehicle.lanePosition = Math.min(lane.length, Math.max(0, vehicle.lanePosition));
          this.updateGlobalPosition(vehicle, lane);
          
          const positionJump = oldLanePosition - vehicle.lanePosition;
          console.log(`✅ Vehicle ${vehicle.id} completed lane change: ${oldLaneId} → ${targetLaneId}`);
          
          if (Math.abs(positionJump) > 5) {
            console.warn(`⚠️ Vehicle ${vehicle.id} had large position jump: ${positionJump.toFixed(2)}m during lane change`);
          }
        }
      }

      vehicle.isChangingLane = false;
      vehicle.targetLaneId = undefined;
      vehicle.laneChangeProgress = undefined;
      vehicle.laneOffset = 0;
      this.laneChangeCooldown.set(vehicle.id, this.currentTime);
    }
  }
  
  private updatePositions(dt: number): void {
    for (const vehicle of this.vehicles.values()) {
      // Update velocity
      const newVelocity = Math.max(0, vehicle.velocity + vehicle.acceleration * dt);
      vehicle.velocity = newVelocity;
      
      // Update lane position
      vehicle.lanePosition += vehicle.velocity * dt;
      
      // Check lane boundaries
      let lane = this.network.getLane(vehicle.laneId);
      if (!lane) {
        console.warn(`⚠️ Vehicle ${vehicle.id}: Lane ${vehicle.laneId} not found, skipping`);
        continue;
      }
      
      if (vehicle.lanePosition > lane.length) {
        // Vehicle has left this lane - handle successor
        this.handleLaneTransition(vehicle, lane);
        lane = this.network.getLane(vehicle.laneId) || lane;
        if (!this.vehicles.has(vehicle.id)) {
          continue;
        }
      }
      
      // Update global position from lane coordinates
      this.updateGlobalPosition(vehicle, lane);
    }
  }
  
  private handleLaneTransition(vehicle: VehicleState, currentLane: Lane): void {
    const oldLaneId = vehicle.laneId;
    const oldLanePosition = vehicle.lanePosition;
    
    let lane = currentLane;
    let position = vehicle.lanePosition;
    const transitionPath: string[] = [currentLane.id];

    while (position > lane.length && lane.successors.length > 0) {
      position -= lane.length;
      const nextLaneId = lane.successors[0];
      const nextLane = this.network.getLane(nextLaneId);
      if (!nextLane) {
        console.warn(`⚠️ Vehicle ${vehicle.id}: Successor lane ${nextLaneId} not found, breaking transition`);
        break;
      }
      transitionPath.push(nextLaneId);
      lane = nextLane;
    }

    if (position > lane.length && lane.successors.length === 0) {
      console.log(`🚗 Vehicle ${vehicle.id} reached end of road and was removed`);
      vehicle.lanePosition = lane.length;
      this.removeVehicle(vehicle.id);
      return;
    }

    const newLaneId = lane.id;
    const newLanePosition = Math.min(lane.length, Math.max(0, position));
    const positionJump = oldLanePosition - newLanePosition;
    
    vehicle.laneId = newLaneId;
    vehicle.lanePosition = newLanePosition;
    
    if (transitionPath.length > 1) {
      console.log(`🔄 Vehicle ${vehicle.id} reached node and transitioned: ${oldLaneId} → ${newLaneId} (path: ${transitionPath.join(' → ')})`);
    } else {
      console.log(`🔄 Vehicle ${vehicle.id} reached end of lane ${oldLaneId} and moved to ${newLaneId}`);
    }
    
    if (Math.abs(positionJump) > 5) {
      console.warn(`⚠️ Vehicle ${vehicle.id} had large position jump: ${positionJump.toFixed(2)}m during transition`);
    }
  }
  
  private updateGlobalPosition(vehicle: VehicleState, lane: Lane): void {
    // Interpolate position along lane centerline
    const t = vehicle.lanePosition / lane.length;
    const position = this.interpolateLanePosition(lane, t);
    
    // Apply lateral offset
    const normal = this.getLaneNormal(lane, t);
    vehicle.position = {
      x: position.x + normal.x * vehicle.laneOffset,
      y: position.y + normal.y * vehicle.laneOffset,
    };
    
    // Update heading
    vehicle.heading = this.getLaneHeading(lane, t);
  }
  
  private interpolateLanePosition(lane: Lane, t: number): Vector2D {
    // Linear interpolation along centerline polyline
    const points = lane.centerline;
    const n = points.length - 1;
    const segment = Math.min(Math.floor(t * n), n - 1);
    const localT = (t * n) - segment;
    
    const p0 = points[segment];
    const p1 = points[segment + 1];
    
    return {
      x: p0.x + (p1.x - p0.x) * localT,
      y: p0.y + (p1.y - p0.y) * localT,
    };
  }
  
  private getLaneNormal(lane: Lane, t: number): Vector2D {
    // Get tangent direction
    const points = lane.centerline;
    const n = points.length - 1;
    const segment = Math.min(Math.floor(t * n), n - 1);
    
    const p0 = points[segment];
    const p1 = points[segment + 1];
    
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    
    // Normal is perpendicular to tangent
    return {
      x: -dy / len,
      y: dx / len,
    };
  }
  
  private getLaneHeading(lane: Lane, t: number): number {
    const points = lane.centerline;
    const n = points.length - 1;
    const segment = Math.min(Math.floor(t * n), n - 1);
    
    const p0 = points[segment];
    const p1 = points[segment + 1];
    
    return Math.atan2(p1.y - p0.y, p1.x - p0.x);
  }
  
  private updateVehicleRelationships(laneVehicles: Map<LaneID, VehicleState[]>): void {
    for (const vehicles of laneVehicles.values()) {
      for (const v of vehicles) {
        v.followerIds = [];
      }
      for (let i = 0; i < vehicles.length; i++) {
        const vehicle = vehicles[i];
        const leader = vehicles[i + 1];
        vehicle.leaderId = leader?.id;
        if (leader) {
          leader.followerIds?.push(vehicle.id);
        }
      }
    }
  }
  
  private updateSpatialIndex(): void {
    // Clear and rebuild spatial index
    this.spatialIndex.clear();
    
    for (const vehicle of this.vehicles.values()) {
      const bounds = this.getVehicleBounds(vehicle);
      this.spatialIndex.insert(vehicle.id, bounds);
    }
  }
  
  private getVehicleBounds(vehicle: VehicleState): BoundingBox {
    // Simplified bounding box
    const halfWidth = 2.0;
    const halfLength = 2.5;
    
    return {
      minX: vehicle.position.x - halfLength,
      minY: vehicle.position.y - halfWidth,
      maxX: vehicle.position.x + halfLength,
      maxY: vehicle.position.y + halfWidth,
    };
  }
  
  // =========================================================================
  // PUBLIC INTERFACE METHODS
  // =========================================================================
  
  addVehicle(vehicle: VehicleState): void {
    this.vehicles.set(vehicle.id, vehicle);
  }
  
  removeVehicle(id: VehicleID): void {
    const vehicle = this.vehicles.get(id);
    if (vehicle) {
      console.log(`🚗 Vehicle ${id} despawned (reached end of road at lane ${vehicle.laneId})`);
    }
    this.vehicles.delete(id);
    this.spatialIndex.remove(id);
  }
  
  getVehicle(id: VehicleID): VehicleState | undefined {
    return this.vehicles.get(id);
  }
  
  registerDriverModel(category: VehicleCategory, model: IDriverModel): void {
    this.driverModels.set(category, model);
  }
  
  setLaneChangeModel(model: ILaneChangeModel): void {
    this.laneChangeModel = model;
  }
  
  getVehiclesInLane(laneId: LaneID): VehicleState[] {
    const result: VehicleState[] = [];
    for (const vehicle of this.vehicles.values()) {
      if (vehicle.laneId === laneId) {
        result.push(vehicle);
      }
    }
    return result;
  }
  
  getLeader(vehicleId: VehicleID): VehicleState | undefined {
    const vehicle = this.vehicles.get(vehicleId);
    if (!vehicle || !vehicle.leaderId) return undefined;
    return this.vehicles.get(vehicle.leaderId);
  }
  
  getFollowers(vehicleId: VehicleID): VehicleState[] {
    const vehicle = this.vehicles.get(vehicleId);
    if (!vehicle) return [];
    
    // Find all vehicles that have this vehicle as their leader
    const followers: VehicleState[] = [];
    for (const other of this.vehicles.values()) {
      if (other.leaderId === vehicleId) {
        followers.push(other);
      }
    }
    return followers;
  }
  
  reset(): void {
    this.currentTime = 0;
    this.vehicles.clear();
    this.spatialIndex.clear();
    this.frameAccumulator = 0;
  }
  
  getState(): SimulationSnapshot {
    return {
      time: this.currentTime,
      vehicles: Array.from(this.vehicles.values()),
    };
  }
  
  setState(snapshot: SimulationSnapshot): void {
    this.currentTime = snapshot.time;
    this.vehicles.clear();
    
    for (const vehicle of snapshot.vehicles) {
      this.vehicles.set(vehicle.id, vehicle);
    }
    
    this.updateSpatialIndex();
  }
}

// ============================================================================
// QUADTREE SPATIAL INDEX
// ============================================================================

interface QuadTreeNode {
  bounds: BoundingBox;
  items: Map<VehicleID, BoundingBox>;
  children?: QuadTreeNode[];
  depth: number;
}

export class QuadTreeIndex implements ISpatialIndex {
  private root: QuadTreeNode;
  private maxDepth: number = 8;
  private maxItems: number = 10;
  
  constructor(bounds: BoundingBox) {
    this.root = {
      bounds,
      items: new Map(),
      depth: 0,
    };
  }
  
  insert(id: VehicleID, bounds: BoundingBox): void {
    this.insertIntoNode(this.root, id, bounds);
  }
  
  private insertIntoNode(node: QuadTreeNode, id: VehicleID, bounds: BoundingBox): void {
    // If node has children, insert into appropriate child
    if (node.children) {
      const childIndex = this.getChildIndex(node, bounds);
      if (childIndex !== -1) {
        this.insertIntoNode(node.children[childIndex], id, bounds);
        return;
      }
    }
    
    // Insert into this node
    node.items.set(id, bounds);
    
    // Split if necessary
    if (node.items.size > this.maxItems && node.depth < this.maxDepth && !node.children) {
      this.splitNode(node);
    }
  }
  
  private splitNode(node: QuadTreeNode): void {
    const { minX, minY, maxX, maxY } = node.bounds;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    
    node.children = [
      { bounds: { minX, minY, maxX: midX, maxY: midY }, items: new Map(), depth: node.depth + 1 },
      { bounds: { minX: midX, minY, maxX, maxY: midY }, items: new Map(), depth: node.depth + 1 },
      { bounds: { minX, minY: midY, maxX: midX, maxY }, items: new Map(), depth: node.depth + 1 },
      { bounds: { minX: midX, minY: midY, maxX, maxY }, items: new Map(), depth: node.depth + 1 },
    ];
    
    // Redistribute items
    const items = Array.from(node.items.entries());
    node.items.clear();
    
    for (const [id, bounds] of items) {
      const childIndex = this.getChildIndex(node, bounds);
      if (childIndex !== -1) {
        this.insertIntoNode(node.children[childIndex], id, bounds);
      } else {
        node.items.set(id, bounds);
      }
    }
  }
  
  private getChildIndex(node: QuadTreeNode, bounds: BoundingBox): number {
    if (!node.children) return -1;
    
    for (let i = 0; i < 4; i++) {
      if (this.boundsContained(node.children[i].bounds, bounds)) {
        return i;
      }
    }
    return -1;
  }
  
  private boundsContained(container: BoundingBox, target: BoundingBox): boolean {
    return (
      target.minX >= container.minX &&
      target.minY >= container.minY &&
      target.maxX <= container.maxX &&
      target.maxY <= container.maxY
    );
  }
  
  remove(id: VehicleID): void {
    this.removeFromNode(this.root, id);
  }
  
  private removeFromNode(node: QuadTreeNode, id: VehicleID): boolean {
    if (node.items.has(id)) {
      node.items.delete(id);
      return true;
    }
    
    if (node.children) {
      for (const child of node.children) {
        if (this.removeFromNode(child, id)) {
          return true;
        }
      }
    }
    
    return false;
  }
  
  update(id: VehicleID, bounds: BoundingBox): void {
    this.remove(id);
    this.insert(id, bounds);
  }
  
  query(bounds: BoundingBox): VehicleID[] {
    const result: VehicleID[] = [];
    this.queryNode(this.root, bounds, result);
    return result;
  }
  
  private queryNode(node: QuadTreeNode, bounds: BoundingBox, result: VehicleID[]): void {
    if (!this.boundsIntersect(node.bounds, bounds)) {
      return;
    }
    
    for (const [id, itemBounds] of node.items.entries()) {
      if (this.boundsIntersect(itemBounds, bounds)) {
        result.push(id);
      }
    }
    
    if (node.children) {
      for (const child of node.children) {
        this.queryNode(child, bounds, result);
      }
    }
  }
  
  private boundsIntersect(a: BoundingBox, b: BoundingBox): boolean {
    return !(
      a.maxX < b.minX ||
      a.minX > b.maxX ||
      a.maxY < b.minY ||
      a.minY > b.maxY
    );
  }
  
  queryRadius(center: Vector2D, radius: number): VehicleID[] {
    const bounds: BoundingBox = {
      minX: center.x - radius,
      minY: center.y - radius,
      maxX: center.x + radius,
      maxY: center.y + radius,
    };
    
    const candidates = this.query(bounds);
    
    // Filter by actual distance
    return candidates.filter(id => {
      const itemBounds = this.findBounds(this.root, id);
      if (!itemBounds) return false;
      
      const centerX = (itemBounds.minX + itemBounds.maxX) / 2;
      const centerY = (itemBounds.minY + itemBounds.maxY) / 2;
      const dx = centerX - center.x;
      const dy = centerY - center.y;
      
      return Math.sqrt(dx * dx + dy * dy) <= radius;
    });
  }
  
  private findBounds(node: QuadTreeNode, id: VehicleID): BoundingBox | undefined {
    if (node.items.has(id)) {
      return node.items.get(id);
    }
    
    if (node.children) {
      for (const child of node.children) {
        const bounds = this.findBounds(child, id);
        if (bounds) return bounds;
      }
    }
    
    return undefined;
  }
  
  clear(): void {
    this.root.items.clear();
    this.root.children = undefined;
  }
}
