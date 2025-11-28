// ============================================================================
// IDM (Intelligent Driver Model) Implementation
// ============================================================================

import {
  IDriverModel,
  DriverModelContext,
  VehicleDriverParams,
  VehicleState,
} from './traffic_sim_interfaces';

export class IDMModel implements IDriverModel {
  readonly modelName: string = 'IDM';
  readonly version: string = '1.0';
  
  private params: VehicleDriverParams;
  
  constructor(params: VehicleDriverParams) {
    this.params = { ...params };
  }
  
  calculateAcceleration(context: DriverModelContext): number {
    const { vehicle, leader, lane } = context;
    const v = Math.max(0, vehicle.velocity);
    const v0 = Math.max(0.1, Math.min(this.params.desiredSpeed, lane.speedLimit));
    const a = this.params.maxAccel;
    const b = this.params.comfortableDecel;
    const delta = this.params.accelExponent;

    // Free-flow term
    const freeFlow = 1 - Math.pow(v / v0, delta);

    if (!leader) {
      const accel = a * freeFlow;
      return this.clampAcceleration(accel);
    }

    // IDM desired gap
    const gap = Math.max(0.5, leader.lanePosition - vehicle.lanePosition);
    const dv = v - Math.max(0, leader.velocity);
    const sStar =
      this.params.minSpacing +
      v * this.params.timeHeadway +
      (v * dv) / (2 * Math.sqrt(Math.max(1e-3, a * b)));

    const accel = a * (freeFlow - Math.pow(sStar / gap, 2));
    return this.clampAcceleration(accel);
  }
  
  private calculateSpacing(vehicle: VehicleState, leader: VehicleState): number {
    // Net spacing (gap between vehicle fronts minus leader length)
    const gap = leader.lanePosition - vehicle.lanePosition;
    return Math.max(0.01, gap); // Avoid division by zero
  }
  
  private calculateDesiredSpacing(vehicle: VehicleState, leader: VehicleState): number {
    const v = vehicle.velocity;
    const deltaV = v - leader.velocity;
    const T = this.params.timeHeadway;
    const s0 = this.params.minSpacing;
    const a = this.params.maxAccel;
    const b = this.params.comfortableDecel;
    
    // IDM formula: s* = s0 + vT + (v * deltaV) / (2 * sqrt(a * b))
    const interactionTerm = (v * deltaV) / (2 * Math.sqrt(a * b));
    const sStar = s0 + Math.max(0, v * T + interactionTerm);
    
    return sStar;
  }
  
  getParameters(): Record<string, number> {
    return {
      maxAccel: this.params.maxAccel,
      maxDecel: this.params.maxDecel,
      desiredSpeed: this.params.desiredSpeed,
      timeHeadway: this.params.timeHeadway,
      minSpacing: this.params.minSpacing,
      comfortableDecel: this.params.comfortableDecel,
      accelExponent: this.params.accelExponent,
      reactionTime: this.params.reactionTime,
      politeness: this.params.politeness,
      laneChangeThreshold: this.params.laneChangeThreshold,
      safeDecel: this.params.safeDecel,
      rightBias: this.params.rightBias,
    };
  }
  
  setParameters(params: Partial<Record<string, number>>): void {
    Object.assign(this.params, params);
  }

  private clampAcceleration(accel: number): number {
    return Math.max(-this.params.maxDecel, Math.min(this.params.maxAccel, accel));
  }
}

// ============================================================================
// Enhanced IDM with Reaction Time
// ============================================================================

export class EnhancedIDMModel extends IDMModel {
  readonly modelName = 'Enhanced-IDM';
  readonly version = '1.1';
  
  private reactionTime: number;
  
  constructor(params: VehicleDriverParams) {
    super(params);
    this.reactionTime = params.reactionTime;
  }
  
  calculateAcceleration(context: DriverModelContext): number {
    const { vehicle, leader } = context;
    
    if (!leader) {
      return super.calculateAcceleration(context);
    }
    
    const params = this.getParameters();
    const v = Math.max(0, vehicle.velocity);
    const vL = Math.max(0, leader.velocity);
    const dv = v - vL;
    const v0 = Math.max(0.1, Math.min(params.desiredSpeed, context.lane.speedLimit));
    const a = params.maxAccel;
    const b = params.comfortableDecel;
    const s0 = params.minSpacing;
    const T = params.timeHeadway;
    
    const gap = Math.max(0.5, leader.lanePosition - vehicle.lanePosition);
    const sStar =
      s0 +
      v * (T + this.reactionTime) +
      (v * dv) / (2 * Math.sqrt(Math.max(1e-3, a * b)));
    
    const accel = a * (1 - Math.pow(v / v0, params.accelExponent) - Math.pow(sStar / gap, 2));
    return Math.max(-params.maxDecel, Math.min(params.maxAccel, accel));
  }
}

// ============================================================================
// MOBIL Lane Change Model
// ============================================================================

import {
  ILaneChangeModel,
  LaneChangeDecision,
  Lane,
  RoadNetwork,
  VehicleID,
} from './traffic_sim_interfaces';
import { DEFAULT_VEHICLE_TYPES } from './traffic_sim_interfaces';

export class MOBILModel implements ILaneChangeModel {
  readonly modelName = 'MOBIL';
  
  private politeness: number;
  private threshold: number;
  private safeDecel: number;
  private rightBias: number;
  private obstacleBypassLookahead: number = 60;
  private obstacleBypassBonus: number = 8;
  private obstacleClearDistance: number = 30;
  
  constructor(
    politeness: number = 0.3,
    threshold: number = 0.2,
    safeDecel: number = 4.0,
    rightBias: number = 0.3
  ) {
    this.politeness = politeness;
    this.threshold = threshold;
    this.safeDecel = safeDecel;
    this.rightBias = rightBias;
  }
  
  evaluateLaneChange(
    vehicle: VehicleState,
    currentLane: Lane,
    adjacentLanes: Lane[],
    vehicles: Map<VehicleID, VehicleState>,
    network: RoadNetwork
  ): LaneChangeDecision {
    let bestDecision: LaneChangeDecision = {
      shouldChange: false,
      utility: -Infinity,
      isSafe: false,
      reason: 'none',
    };

    for (const targetLane of adjacentLanes) {
      const decision = this.evaluateSingleLaneChange(
        vehicle,
        currentLane,
        targetLane,
        vehicles,
        network
      );

      if (decision.isSafe && decision.utility > bestDecision.utility) {
        bestDecision = decision;
      }
    }

    return bestDecision;
  }
  
  private leadsToDeadEnd(laneId: string, network: RoadNetwork, visited: Set<string> = new Set(), depth: number = 0): boolean {
    // Prevent infinite recursion
    if (visited.has(laneId) || depth > 10) return false;
    visited.add(laneId);
    
    const lane = network.getLane(laneId);
    if (!lane) return true;
    
    // If no successors, it's a dead end
    if (lane.successors.length === 0) return true;
    
    // Check if all successors lead to dead ends
    for (const successorId of lane.successors) {
      if (!this.leadsToDeadEnd(successorId, network, new Set(visited), depth + 1)) {
        return false; // At least one path continues
      }
    }
    
    return true; // All paths lead to dead ends
  }

  private evaluateSingleLaneChange(
    vehicle: VehicleState,
    currentLane: Lane,
    targetLane: Lane,
    vehicles: Map<VehicleID, VehicleState>,
    network: RoadNetwork
  ): LaneChangeDecision {
    const oldLeader = this.findLeaderInLane(vehicle, currentLane, vehicles);
    const oldFollower = this.findFollower(vehicle, currentLane, vehicles);
    const newLeader = this.findLeaderInLane(vehicle, targetLane, vehicles);
    const newFollower = this.findFollowerInLane(vehicle, targetLane, vehicles);

    const leaderIsObstacle = oldLeader?.kind === 'obstacle';
    const distanceToObstacle =
      leaderIsObstacle && oldLeader ? oldLeader.lanePosition - vehicle.lanePosition : Infinity;
    const approachingObstacle =
      leaderIsObstacle && distanceToObstacle < this.obstacleBypassLookahead;

    const targetBlockedByObstacle =
      newLeader?.kind === 'obstacle' &&
      newLeader.lanePosition - vehicle.lanePosition < this.obstacleClearDistance;

    const isSafe = this.checkSafety(vehicle, targetLane, newLeader, newFollower);
    if (targetBlockedByObstacle) {
      return { shouldChange: false, utility: -Infinity, isSafe: false, reason: 'none' };
    }
    if (!isSafe) {
      return { shouldChange: false, utility: -Infinity, isSafe: false, reason: 'none' };
    }

    const acBefore = this.estimateAcceleration(vehicle, oldLeader, currentLane);
    const acAfter = this.estimateAcceleration(vehicle, newLeader, targetLane);

    const aoBefore = oldFollower
      ? this.estimateAcceleration(oldFollower, vehicle, currentLane)
      : 0;
    const aoAfter = oldFollower
      ? this.estimateAcceleration(oldFollower, oldLeader, currentLane)
      : 0;

    const anBefore = newFollower
      ? this.estimateAcceleration(newFollower, newLeader, targetLane)
      : 0;
    const anAfter = newFollower
      ? this.estimateAcceleration(newFollower, vehicle, targetLane)
      : 0;

    let obstacleBonus = 0;
    if (approachingObstacle) {
      obstacleBonus = this.obstacleBypassBonus;
    }

    const incentive =
      (acAfter - acBefore) +
      this.politeness * ((aoAfter - aoBefore) + (anAfter - anBefore)) +
      obstacleBonus;

    const bias = targetLane.index < currentLane.index ? -this.rightBias : this.rightBias;
    
    // Penalize lanes that lead to dead ends
    const deadEndPenalty = this.leadsToDeadEnd(targetLane.id, network) ? -5.0 : 0;
    
    const utility = incentive + bias + deadEndPenalty;
    const shouldChange = approachingObstacle ? isSafe && !targetBlockedByObstacle : utility > this.threshold;

    return {
      shouldChange,
      targetLaneId: shouldChange ? targetLane.id : undefined,
      utility: shouldChange ? Math.max(utility, this.threshold + 1) : utility,
      isSafe,
      reason: shouldChange ? 'discretionary' : 'none',
    };
  }
  
  private checkSafety(
    vehicle: VehicleState,
    targetLane: Lane,
    newLeader: VehicleState | undefined,
    newFollower: VehicleState | undefined
  ): boolean {
    const params = DEFAULT_VEHICLE_TYPES[vehicle.type]?.driver;
    const followerParams = newFollower
      ? DEFAULT_VEHICLE_TYPES[newFollower.type]?.driver
      : undefined;

    if (newLeader?.kind === 'obstacle') {
      const gapAhead = newLeader.lanePosition - vehicle.lanePosition;
      if (gapAhead < this.obstacleClearDistance) {
        return false;
      }
    }

    const desiredAhead =
      (params?.minSpacing ?? 2) + Math.max(4, vehicle.velocity * (params?.timeHeadway ?? 1.2));
    const desiredBehind =
      (followerParams?.minSpacing ?? 2) +
      Math.max(3, (newFollower?.velocity ?? 0) * (followerParams?.timeHeadway ?? 1.5));

    if (newLeader) {
      const gapAhead = newLeader.lanePosition - vehicle.lanePosition;
      if (gapAhead < desiredAhead) return false;
    }

    if (newFollower) {
      const gapBehind = vehicle.lanePosition - newFollower.lanePosition;
      if (gapBehind < desiredBehind) return false;

      const followerAccel = this.estimateAcceleration(newFollower, vehicle, targetLane);
      const safe = followerParams?.safeDecel ?? params?.safeDecel ?? this.safeDecel;
      if (followerAccel < -safe) return false;
    }

    return true;
  }
  
  private checkMandatory(
    vehicle: VehicleState,
    currentLane: Lane,
    targetLane: Lane,
    network: RoadNetwork
  ): boolean {
    // Check if lane change is mandatory for upcoming turn or exit
    // This would integrate with route planning (simplified here)
    
    // Example: if vehicle needs to exit and current lane doesn't allow it
    const distanceToExit = 100; // meters (placeholder)
    const criticalDistance = 50; // meters
    
    if (distanceToExit < criticalDistance) {
      // Check if target lane allows required maneuver
      return true; // Simplified
    }
    
    return false;
  }
  
  private estimateAcceleration(
    vehicle: VehicleState,
    leader: VehicleState | undefined,
    lane: Lane
  ): number {
    const params = DEFAULT_VEHICLE_TYPES[vehicle.type]?.driver;
    const aMax = params?.maxAccel ?? 3.0;
    const b = params?.comfortableDecel ?? 3.0;
    const v0 = Math.max(0.1, Math.min(params?.desiredSpeed ?? 30, lane.speedLimit));
    const delta = params?.accelExponent ?? 4.0;

    const v = Math.max(0, vehicle.velocity);
    const free = aMax * (1 - Math.pow(v / v0, delta));

    if (!leader) return free;

    const gap = Math.max(0.5, leader.lanePosition - vehicle.lanePosition);
    const dv = v - Math.max(0, leader.velocity);
    const sStar =
      (params?.minSpacing ?? 2) +
      v * (params?.timeHeadway ?? 1.5) +
      (v * dv) / (2 * Math.sqrt(Math.max(1e-3, aMax * b)));

    const interact = -aMax * Math.pow(sStar / gap, 2);
    return free + interact;
  }
  
  private findFollower(
    vehicle: VehicleState,
    lane: Lane,
    vehicles: Map<VehicleID, VehicleState>
  ): VehicleState | undefined {
    let closestFollower: VehicleState | undefined;
    let minDistance = Infinity;
    
    for (const other of vehicles.values()) {
      if (other.id !== vehicle.id && other.laneId === lane.id) {
        if (other.lanePosition < vehicle.lanePosition) {
          const distance = vehicle.lanePosition - other.lanePosition;
          if (distance < minDistance) {
            minDistance = distance;
            closestFollower = other;
          }
        }
      }
    }
    
    return closestFollower;
  }
  
  private findLeaderInLane(
    vehicle: VehicleState,
    lane: Lane,
    vehicles: Map<VehicleID, VehicleState>
  ): VehicleState | undefined {
    let closestLeader: VehicleState | undefined;
    let minDistance = Infinity;
    
    for (const other of vehicles.values()) {
      if (other.id !== vehicle.id && other.laneId === lane.id) {
        if (other.lanePosition > vehicle.lanePosition) {
          const distance = other.lanePosition - vehicle.lanePosition;
          if (distance < minDistance) {
            minDistance = distance;
            closestLeader = other;
          }
        }
      }
    }
    
    return closestLeader;
  }
  
  private findFollowerInLane(
    vehicle: VehicleState,
    lane: Lane,
    vehicles: Map<VehicleID, VehicleState>
  ): VehicleState | undefined {
    return this.findFollower(vehicle, lane, vehicles);
  }
}

// ============================================================================
// Example: Adaptive Cruise Control (ACC) Model for Autonomous Vehicles
// ============================================================================

export class ACCModel implements IDriverModel {
  readonly modelName = 'ACC';
  readonly version = '1.0';
  
  private desiredSpeed: number;
  private timeGap: number;
  private minGap: number;
  private maxAccel: number;
  private maxDecel: number;
  
  constructor(
    desiredSpeed: number = 30,
    timeGap: number = 0.8,
    minGap: number = 1.5,
    maxAccel: number = 2.5,
    maxDecel: number = 5.0
  ) {
    this.desiredSpeed = desiredSpeed;
    this.timeGap = timeGap;
    this.minGap = minGap;
    this.maxAccel = maxAccel;
    this.maxDecel = maxDecel;
  }
  
  calculateAcceleration(context: DriverModelContext): number {
    const { vehicle, leader, lane } = context;
    const v = vehicle.velocity;
    const vDesired = Math.min(this.desiredSpeed, lane.speedLimit);
    
    if (!leader) {
      // Speed control mode
      const error = vDesired - v;
      const kp = 0.5; // Proportional gain
      return Math.max(-this.maxDecel, Math.min(this.maxAccel, kp * error));
    }
    
    // Gap control mode
    const actualGap = leader.lanePosition - vehicle.lanePosition;
    const desiredGap = this.minGap + this.timeGap * v;
    const gapError = actualGap - desiredGap;
    
    const vLeader = leader.velocity;
    const deltaV = v - vLeader;
    
    // PID-like controller
    const kp = 0.3;
    const kd = 0.5;
    
    const accel = kp * gapError - kd * deltaV;
    
    return Math.max(-this.maxDecel, Math.min(this.maxAccel, accel));
  }
  
  getParameters(): Record<string, number> {
    return {
      desiredSpeed: this.desiredSpeed,
      timeGap: this.timeGap,
      minGap: this.minGap,
      maxAccel: this.maxAccel,
      maxDecel: this.maxDecel,
    };
  }
  
  setParameters(params: Partial<Record<string, number>>): void {
    Object.assign(this, params);
  }
}
