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
  private readonly HOTSPOT_REACHED_RADIUS = 30; // meters
  private readonly MAX_SUBSTEPS = 3; // cap fixed steps per frame to avoid spiral of death
 
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
    const minGap = 4.0;
    for (const [laneId, vehicles] of laneVehicles.entries()) {
      const lane = this.network.getLane(laneId);
      if (!lane) continue;

      let nextAllowed = vehicles.length > 0 ? vehicles[vehicles.length - 1].lanePosition : 0;
      for (let i = vehicles.length - 2; i >= 0; i--) {
        const follower = vehicles[i];
        const leader = vehicles[i + 1];
        const oldLanePosition = follower.lanePosition;

        if (follower.kind === 'obstacle') {
          nextAllowed = follower.lanePosition;
          continue;
        }
        
        const maxPosition = Math.max(0, nextAllowed - minGap);
        if (follower.lanePosition > maxPosition) {
          const gap = leader.lanePosition - follower.lanePosition;
          const adjustment = oldLanePosition - maxPosition;
          
          follower.lanePosition = maxPosition;
          follower.velocity = Math.min(follower.velocity, Math.max(0, vehicles[i + 1].velocity));
          follower.acceleration = Math.min(follower.acceleration, -1);
          this.updateGlobalPosition(follower, lane);
          
          if (adjustment > 1.0) {
            console.log(` Vehicle ${follower.id} position reset: moved back ${adjustment.toFixed(2)}m (too close to ${leader.id}, gap was ${gap.toFixed(2)}m)`);
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
    let steps = 0;
 
    // Fixed timestep with accumulator (for determinism)
    while (this.frameAccumulator >= timeStep && steps < this.MAX_SUBSTEPS) {
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
      steps += 1;
    }

    // Prevent unbounded accumulation if we hit the substep cap
    const maxCarry = timeStep * this.MAX_SUBSTEPS;
    if (this.frameAccumulator > maxCarry) {
      this.frameAccumulator = maxCarry;
    }
  }
  
  private updateVehicles(dt: number, laneVehicles: Map<LaneID, VehicleState[]>): void {
    const toRemove: VehicleID[] = [];
    for (const vehicle of this.vehicles.values()) {
      if (vehicle.kind === 'obstacle') {
        vehicle.velocity = 0;
        vehicle.acceleration = 0;
        vehicle.isChangingLane = false;
        vehicle.targetLaneId = undefined;
        vehicle.laneChangeProgress = undefined;
        vehicle.laneOffset = 0;
        continue;
      }

      const model = this.driverModels.get(vehicle.type);
      if (!model) continue;

      const lane = this.network.getLane(vehicle.laneId);
      if (!lane) continue;

      // If vehicle is at end of lane with no successors (dead end), despawn it
      if (vehicle.lanePosition >= lane.length - 0.1 && lane.successors.length === 0) {
        toRemove.push(vehicle.id);
        continue;
      }

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

    for (const id of toRemove) {
      this.removeVehicle(id);
    }
  }
  
  private handleLaneChanges(laneVehicles: Map<LaneID, VehicleState[]>): void {
    if (!this.laneChangeModel) return;
    
    const minCooldown = 1.8; // seconds
    
    for (const vehicle of this.vehicles.values()) {
      if (vehicle.kind === 'obstacle') {
        vehicle.isChangingLane = false;
        vehicle.targetLaneId = undefined;
        vehicle.laneChangeProgress = undefined;
        vehicle.laneOffset = 0;
        continue;
      }

      const leaderForBypass = this.findLeaderInLane(vehicle.laneId, vehicle.lanePosition, laneVehicles, vehicle.id);
      const approachingObstacle =
        leaderForBypass?.kind === 'obstacle' &&
        leaderForBypass.lanePosition - vehicle.lanePosition < 80;

      if (vehicle.isChangingLane) {
        this.updateLaneChangeProgress(vehicle);
        continue;
      }

      const lastChange = this.laneChangeCooldown.get(vehicle.id);
      if (!approachingObstacle && lastChange !== undefined && this.currentTime - lastChange < minCooldown) {
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
        console.log(` Vehicle ${vehicle.id} starting lane change: ${vehicle.laneId} → ${decision.targetLaneId}`);
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
    
    const currentLane = this.network.getLane(vehicle.laneId);
    const targetLane = this.network.getLane(vehicle.targetLaneId);
    
    if (currentLane && targetLane) {
      const nextProgress = Math.min(1, vehicle.laneChangeProgress + progressIncrement);
      const lateralDistance = (targetLane.index - currentLane.index) * currentLane.width;
      const k = 12; // controls steepness of sigmoid
      const logistic = (x: number) => 1 / (1 + Math.exp(-k * (x - 0.5)));
      const start = logistic(0);
      const end = logistic(1);
      const eased = Math.min(
        1,
        Math.max(0, (logistic(nextProgress) - start) / (end - start))
      );
      vehicle.laneOffset = lateralDistance * eased;

      const leader = this.findLeaderDirect(targetLane.id, vehicle.lanePosition, vehicle.id);
      const follower = this.findFollowerDirect(targetLane.id, vehicle.lanePosition, vehicle.id);
      const currentEdge = this.network.getEdge(currentLane.edgeId);
      const targetEdge = this.network.getEdge(targetLane.edgeId);
      const streetKey = (edge: any) =>
        edge?.name ?? edge?.metadata?.name ?? edge?.metadata?.ref ?? edge?.id;
      const crossingDifferentStreet = streetKey(currentEdge) !== streetKey(targetEdge);
      const priorityRoad =
        (targetEdge?.roadType === 'highway' || (targetEdge?.laneCount ?? 0) > (currentEdge?.laneCount ?? 0)) ?? false;
      const minMergeGap = crossingDifferentStreet ? (priorityRoad ? 8 : 5) : 2.5;

      const proposedPos = vehicle.lanePosition;
      const safeAhead = !leader || leader.lanePosition - proposedPos >= minMergeGap;
      const safeBehind = !follower || proposedPos - follower.lanePosition >= minMergeGap;
      if (crossingDifferentStreet && (!safeAhead || !safeBehind)) {
        // Yield: pause merge until a gap opens on a different street
        vehicle.laneChangeProgress = Math.min(vehicle.laneChangeProgress, 0.95);
        vehicle.velocity = Math.min(vehicle.velocity, 0.5);
        vehicle.acceleration = -2;
        return;
      }

      vehicle.laneChangeProgress = nextProgress;
    }
    
    if (vehicle.laneChangeProgress >= 1.0) {
      const targetLaneId = vehicle.targetLaneId;
      if (targetLaneId) {
        const leader = this.findLeaderDirect(targetLaneId, vehicle.lanePosition, vehicle.id);
        const follower = this.findFollowerDirect(targetLaneId, vehicle.lanePosition, vehicle.id);
        const tgtLane = this.network.getLane(targetLaneId);
        const targetEdge = tgtLane ? this.network.getEdge(tgtLane.edgeId) : undefined;
        const curEdge = this.network.getLane(oldLaneId)?.edgeId
          ? this.network.getEdge(this.network.getLane(oldLaneId)!.edgeId)
          : undefined;
        const streetKey = (edge: any) =>
          edge?.name ?? edge?.metadata?.name ?? edge?.metadata?.ref ?? edge?.id;
        const crossingDifferentStreet = streetKey(curEdge) !== streetKey(targetEdge);
        const priorityRoad =
          (targetEdge?.roadType === 'highway' || (targetEdge?.laneCount ?? 0) >= (curEdge?.laneCount ?? 0)) ?? false;
        const minMergeGap = crossingDifferentStreet ? (priorityRoad ? 8 : 5) : 2.5;
        let newPos = vehicle.lanePosition;
        if (leader) {
          newPos = Math.min(newPos, leader.lanePosition - minMergeGap);
        }
        if (follower) {
          newPos = Math.max(newPos, follower.lanePosition + minMergeGap);
        }

        // If there is no room, hold and keep yielding instead of aborting for different streets.
        if (
          (leader && follower && leader.lanePosition - follower.lanePosition < minMergeGap * 2) ||
          newPos < 0 ||
          (leader && newPos > leader.lanePosition - minMergeGap) ||
          (follower && newPos < follower.lanePosition + minMergeGap)
        ) {
          if (crossingDifferentStreet) {
            vehicle.laneChangeProgress = 0.95;
            vehicle.velocity = Math.min(vehicle.velocity, 0.5);
            vehicle.acceleration = -2;
            return;
          } else {
            // Same street: cancel this attempt to avoid blocking.
            vehicle.isChangingLane = false;
            vehicle.targetLaneId = undefined;
            vehicle.laneChangeProgress = undefined;
            vehicle.laneOffset = 0;
            this.laneChangeCooldown.set(vehicle.id, this.currentTime);
            return;
          }
        }

        vehicle.laneId = targetLaneId;
        vehicle.lanePosition = newPos;
        const lane = this.network.getLane(targetLaneId);
        if (lane) {
          vehicle.lanePosition = Math.min(lane.length, Math.max(0, vehicle.lanePosition));
          this.updateGlobalPosition(vehicle, lane);
          
          const positionJump = oldLanePosition - vehicle.lanePosition;
          console.log(` Vehicle ${vehicle.id} completed lane change: ${oldLaneId} → ${targetLaneId}`);
          
          if (Math.abs(positionJump) > 5) {
            console.warn(` Vehicle ${vehicle.id} had large position jump: ${positionJump.toFixed(2)}m during lane change`);
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
    const toRemove: VehicleID[] = [];
    for (const vehicle of this.vehicles.values()) {
      if (vehicle.kind === 'obstacle') {
        vehicle.velocity = 0;
        vehicle.acceleration = 0;
        vehicle.isChangingLane = false;
        vehicle.targetLaneId = undefined;
        vehicle.laneChangeProgress = undefined;
        vehicle.laneOffset = 0;
        const laneStatic = this.network.getLane(vehicle.laneId);
        if (laneStatic) {
          this.updateGlobalPosition(vehicle, laneStatic);
        }
        continue;
      }

      // Update velocity
      const newVelocity = Math.max(0, vehicle.velocity + vehicle.acceleration * dt);
      vehicle.velocity = newVelocity;
      
      // Update lane position
      vehicle.lanePosition += vehicle.velocity * dt;
      
      // Check lane boundaries
      let lane = this.network.getLane(vehicle.laneId);
      if (!lane) {
        console.warn(` Vehicle ${vehicle.id}: Lane ${vehicle.laneId} not found, skipping`);
        continue;
      }

      // Congestion guard: if nearing lane end and successors are blocked, slow/stop
      const remaining = lane.length - vehicle.lanePosition;
      if (remaining < 20 && lane.successors.length > 0) {
        let blocked = false;
        for (const succId of lane.successors) {
          const succLane = this.network.getLane(succId);
          if (!succLane) continue;
          let nearest: number | null = null;
          for (const v of this.vehicles.values()) {
            if (v.laneId !== succId) continue;
            if (nearest === null || v.lanePosition < nearest) nearest = v.lanePosition;
          }
          if (nearest !== null && nearest < 12) {
            blocked = true;
            break;
          }
        }
        if (blocked) {
          vehicle.velocity = Math.max(0, vehicle.velocity - 4 * dt);
          vehicle.acceleration = Math.min(vehicle.acceleration, -4);
        }
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

      // Hotspot arrival check
      const targetPos = this.getVehicleTargetPosition(vehicle);
      if (targetPos) {
        const dx = vehicle.position.x - targetPos.x;
        const dy = vehicle.position.y - targetPos.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < this.HOTSPOT_REACHED_RADIUS * this.HOTSPOT_REACHED_RADIUS) {
          toRemove.push(vehicle.id);
          continue;
        }
      }

      // Track idle time and fade out stuck vehicles
      if (!vehicle.isAtDeadEnd) {
        const idleSpeed = 0.3;
        const idleAccel = 0.3;
        const timeout = 8; // seconds before fading a stuck vehicle
        if (vehicle.velocity < idleSpeed && Math.abs(vehicle.acceleration) < idleAccel) {
          vehicle.idleTime = (vehicle.idleTime ?? 0) + dt;
          if (vehicle.idleTime > timeout) {
            vehicle.fadeOutProgress = (vehicle.fadeOutProgress ?? 0) + dt / 2; // 2s fade
            if (vehicle.fadeOutProgress >= 1) {
              toRemove.push(vehicle.id);
            }
          }
        } else {
          vehicle.idleTime = 0;
          if (!vehicle.isAtDeadEnd) {
            vehicle.fadeOutProgress = undefined;
          }
        }
      }
    }

    for (const id of toRemove) {
      this.removeVehicle(id);
    }
  }
  
  private leadsToDeadEnd(laneId: LaneID, visited: Set<LaneID> = new Set(), depth: number = 0): boolean {
    // Prevent infinite recursion
    if (visited.has(laneId) || depth > 10) return false;
    visited.add(laneId);
    
    const lane = this.network.getLane(laneId);
    if (!lane) return true;
    
    // If no successors, it's a dead end
    if (lane.successors.length === 0) return true;
    
    // Check if all successors lead to dead ends
    for (const successorId of lane.successors) {
      if (!this.leadsToDeadEnd(successorId, new Set(visited), depth + 1)) {
        return false; // At least one path continues
      }
    }
    
    return true; // All paths lead to dead ends
  }

  private handleLaneTransition(vehicle: VehicleState, currentLane: Lane): void {
    const oldLaneId = vehicle.laneId;
    const oldLanePosition = vehicle.lanePosition;
    
    let lane = currentLane;
    let position = vehicle.lanePosition;
    const transitionPath: string[] = [currentLane.id];

    while (position > lane.length && lane.successors.length > 0) {
      position -= lane.length;
      let candidateLanes = lane.successors
        .map(id => this.network.getLane(id))
        .filter((l): l is Lane => {
          if (!l) return false;
          return l.laneType === 'driving';
        });

      if (candidateLanes.length === 0) {
        const edge = this.network.getEdge(lane.edgeId);
        const node = edge ? this.network.getNode(edge.toNode) : undefined;
        if (node) {
          for (const outEdgeId of node.outgoingEdges) {
            const outEdge = this.network.getEdge(outEdgeId);
            if (!outEdge) continue;
            const idx = Math.min(lane.index, outEdge.lanes.length - 1);
            const cand = outEdge.lanes[idx];
            if (cand && cand.laneType === 'driving') candidateLanes.push(cand);
          }
        }
      }

      if (candidateLanes.length === 0) {
        break;
      }

      // Weighted random selection to avoid bias toward the first successor
      const targetPos = this.getVehicleTargetPosition(vehicle);
      const weights = candidateLanes.map(next => {
        const nextEdge = this.network.getEdge(next.edgeId);
        const currentEdge = this.network.getEdge(lane.edgeId);
        const indexAffinity = 1 / (1 + Math.abs(next.index - lane.index));
        const sameRoadBonus =
          nextEdge && currentEdge && nextEdge.roadType === currentEdge.roadType ? 0.5 : 0;
        const deadEndPenalty = this.leadsToDeadEnd(next.id) ? -0.5 : 0.5;
        let base = Math.max(0.05, 1 + indexAffinity + sameRoadBonus + deadEndPenalty);
        if (targetPos) {
          const endPos = this.getLaneEndPosition(next);
          if (endPos) {
            const dx = endPos.x - targetPos.x;
            const dy = endPos.y - targetPos.y;
            const d2 = dx * dx + dy * dy;
            const bias = 1 / (1 + Math.sqrt(d2) / 200); // closer ends get higher weight
            base *= 1 + bias;
          }
        }
        return base;
      });

      const total = weights.reduce((s, w) => s + w, 0);
      let pick = Math.random() * total;
      let nextLane = candidateLanes[candidateLanes.length - 1];
      for (let i = 0; i < candidateLanes.length; i++) {
        pick -= weights[i];
        if (pick <= 0) {
          nextLane = candidateLanes[i];
          break;
        }
      }

      transitionPath.push(nextLane.id);
      lane = nextLane;
    }

    if (position > lane.length && lane.successors.length === 0) {
      console.log(` Vehicle ${vehicle.id} reached dead end at node (no outgoing edges), despawning`);
      this.removeVehicle(vehicle.id);
      return;
    }

    const newLaneId = lane.id;
    const newLanePosition = Math.min(lane.length, Math.max(0, position));
    const positionJump = oldLanePosition - newLanePosition;
    
    vehicle.laneId = newLaneId;
    vehicle.lanePosition = newLanePosition;
    
    if (transitionPath.length > 1) {
      console.log(` Vehicle ${vehicle.id} reached node and transitioned: ${oldLaneId} → ${newLaneId} (path: ${transitionPath.join(' → ')})`);
    } else {
      console.log(` Vehicle ${vehicle.id} reached end of lane ${oldLaneId} and moved to ${newLaneId}`);
    }
    
    if (Math.abs(positionJump) > 5) {
      console.warn(` Vehicle ${vehicle.id} had large position jump: ${positionJump.toFixed(2)}m during transition`);
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
    const points = Array.isArray(lane.centerline) ? lane.centerline : [];
    if (points.length === 0) {
      return { x: 0, y: 0 };
    }
    if (points.length === 1) {
      return points[0];
    }
    const n = points.length - 1;
    const segment = Math.min(Math.floor(t * n), n - 1);
    const localT = Math.min(1, Math.max(0, t * n - segment));
    
    const p0 = points[segment];
    const p1 = points[Math.min(segment + 1, n)];
    if (!p0 || !p1) {
      return points[0] ?? { x: 0, y: 0 };
    }
    
    return {
      x: p0.x + (p1.x - p0.x) * localT,
      y: p0.y + (p1.y - p0.y) * localT,
    };
  }

  private getLaneEndPosition(lane: Lane): Vector2D | null {
    const points = Array.isArray(lane.centerline) ? lane.centerline : [];
    if (points.length > 0) {
      return points[points.length - 1];
    }
    const edge = this.network.getEdge(lane.edgeId);
    if (edge) {
      const node = this.network.getNode(edge.toNode);
      if (node) return node.position;
    }
    return null;
  }

  private getVehicleTargetPosition(vehicle: VehicleState): Vector2D | null {
    if (vehicle.targetNodeId) {
      const node = this.network.getNode(vehicle.targetNodeId);
      if (node) return node.position;
    }
    if (vehicle.targetX !== undefined && vehicle.targetY !== undefined) {
      return { x: vehicle.targetX, y: vehicle.targetY };
    }
    return null;
  }
  
  private getLaneNormal(lane: Lane, t: number): Vector2D {
    // Get tangent direction
    const points = Array.isArray(lane.centerline) ? lane.centerline : [];
    if (points.length < 2) {
      return { x: 0, y: 0 };
    }

    const n = points.length - 1;
    const segment = Math.min(Math.floor(t * n), n - 1);
    
    const p0 = points[segment];
    const p1 = points[Math.min(segment + 1, n)];
    if (!p0 || !p1) {
      return { x: 0, y: 0 };
    }
    
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    
    // Normal is perpendicular to tangent
    return {
      x: -dy / len,
      y: dx / len,
    };
  }
  
  private getLaneHeading(lane: Lane, t: number): number {
    const points = Array.isArray(lane.centerline) ? lane.centerline : [];
    if (points.length < 2) return 0;

    const n = points.length - 1;
    const segment = Math.min(Math.floor(t * n), n - 1);
    
    const p0 = points[segment];
    const p1 = points[Math.min(segment + 1, n)];
    if (!p0 || !p1) return 0;
    
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
    // Use size from the vehicle type definition; fall back to a sensible default
    const typeDef = DEFAULT_VEHICLE_TYPES[vehicle.type];
    const width = typeDef?.physical.width ?? 2.0;
    const length = typeDef?.physical.length ?? 10.0;
    const halfWidth = width * 0.5;
    const halfLength = length * 0.5;
    
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
      console.log(` Vehicle ${id} despawned (reached end of road at lane ${vehicle.laneId})`);
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
