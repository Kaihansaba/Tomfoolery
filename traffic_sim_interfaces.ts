// ============================================================================
// CORE TYPE DEFINITIONS
// ============================================================================

export type VehicleID = string;
export type NodeID = string;
export type EdgeID = string;
export type LaneID = string;

export interface Vector2D {
  x: number;
  y: number;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// ============================================================================
// VEHICLE TYPES AND PARAMETERS
// ============================================================================

export enum VehicleCategory {
  CAR = 'car',
  TRUCK = 'truck',
  BUS = 'bus',
  MOTORCYCLE = 'motorcycle',
  AUTONOMOUS = 'autonomous',
}

export interface VehiclePhysicalParams {
  length: number;        // meters
  width: number;         // meters
  maxAccel: number;      // m/s^2
  maxDecel: number;      // m/s^2
  maxSpeed: number;      // m/s
}

export interface VehicleDriverParams {
  maxAccel: number;       // m/s^2
  maxDecel: number;       // m/s^2
  desiredSpeed: number;      // m/s (v0)
  timeHeadway: number;       // seconds (T)
  minSpacing: number;        // meters (s0)
  comfortableDecel: number;  // m/s^2 (b)
  accelExponent: number;     // typically 4
  reactionTime: number;      // seconds
  politeness: number;        // MOBIL p factor [0, 1]
  laneChangeThreshold: number; // m/s^2 (a_th)
  safeDecel: number;        // m/s^2 (b_safe)
  rightBias: number;        // m/s^2 (a_bias)
}

export interface VehicleTypeConfig {
  category: VehicleCategory;
  physical: VehiclePhysicalParams;
  driver: VehicleDriverParams;
  color?: string;
}

// Default vehicle type configurations
export const DEFAULT_VEHICLE_TYPES: Record<VehicleCategory, VehicleTypeConfig> = {
  [VehicleCategory.CAR]: {
    category: VehicleCategory.CAR,
    physical: {
      length: 4.5,
      width: 2.0,
      maxAccel: 3.0,
      maxDecel: 6.0,
      maxSpeed: 50.0, // ~180 km/h
    },
    driver: {
      maxAccel: 3.0,
      maxDecel: 6.0,
      desiredSpeed: 33.3, // 120 km/h
      timeHeadway: 1.5,
      minSpacing: 2.0,
      comfortableDecel: 3.0,
      accelExponent: 4.0,
      reactionTime: 0.8,
      politeness: 0.3,
      laneChangeThreshold: 0.2,
      safeDecel: 4.0,
      rightBias: 0.3,
    },
    color: '#3498db',
  },
  [VehicleCategory.TRUCK]: {
    category: VehicleCategory.TRUCK,
    physical: {
      length: 16.0,
      width: 2.5,
      maxAccel: 1.0,
      maxDecel: 3.5,
      maxSpeed: 30.0, // ~108 km/h
    },
    driver: {
      maxAccel: 1.0,
      maxDecel: 3.5,
      desiredSpeed: 25.0, // 90 km/h
      timeHeadway: 2.0,
      minSpacing: 3.0,
      comfortableDecel: 2.0,
      accelExponent: 4.0,
      reactionTime: 1.0,
      politeness: 0.5,
      laneChangeThreshold: 0.3,
      safeDecel: 3.0,
      rightBias: 0.5,
    },
    color: '#e74c3c',
  },
  [VehicleCategory.BUS]: {
    category: VehicleCategory.BUS,
    physical: {
      length: 12.0,
      width: 2.5,
      maxAccel: 1.5,
      maxDecel: 4.0,
      maxSpeed: 27.8, // ~100 km/h
    },
    driver: {
      maxAccel: 1.5,
      maxDecel: 4.0,
      desiredSpeed: 22.2, // 80 km/h
      timeHeadway: 2.0,
      minSpacing: 2.5,
      comfortableDecel: 2.5,
      accelExponent: 4.0,
      reactionTime: 0.9,
      politeness: 0.4,
      laneChangeThreshold: 0.3,
      safeDecel: 3.5,
      rightBias: 0.4,
    },
    color: '#f39c12',
  },
  [VehicleCategory.MOTORCYCLE]: {
    category: VehicleCategory.MOTORCYCLE,
    physical: {
      length: 2.2,
      width: 0.9,
      maxAccel: 4.0,
      maxDecel: 7.0,
      maxSpeed: 55.6, // ~200 km/h
    },
    driver: {
      maxAccel: 4.0,
      maxDecel: 7.0,
      desiredSpeed: 30.0, // 108 km/h
      timeHeadway: 1.0,
      minSpacing: 1.5,
      comfortableDecel: 4.0,
      accelExponent: 4.0,
      reactionTime: 0.6,
      politeness: 0.1,
      laneChangeThreshold: 0.15,
      safeDecel: 5.0,
      rightBias: 0.1,
    },
    color: '#9b59b6',
  },
  [VehicleCategory.AUTONOMOUS]: {
    category: VehicleCategory.AUTONOMOUS,
    physical: {
      length: 4.5,
      width: 2.0,
      maxAccel: 2.5,
      maxDecel: 5.0,
      maxSpeed: 38.9, // ~140 km/h
    },
    driver: {
      maxAccel: 2.5,
      maxDecel: 5.0,
      desiredSpeed: 33.3, // 120 km/h
      timeHeadway: 0.8,
      minSpacing: 1.5,
      comfortableDecel: 2.5,
      accelExponent: 4.0,
      reactionTime: 0.1, // Much faster reaction
      politeness: 0.8,   // More cooperative
      laneChangeThreshold: 0.1,
      safeDecel: 4.5,
      rightBias: 0.2,
    },
    color: '#2ecc71',
  },
};

// ============================================================================
// VEHICLE STATE
// ============================================================================

export interface VehicleState {
  id: VehicleID;
  type: VehicleCategory;
  
  // Position
  position: Vector2D;
  heading: number;       // radians
  
  // Lane-relative coordinates
  laneId: LaneID;
  lanePosition: number;  // arc length along lane (s)
  laneOffset: number;    // lateral offset (d)
  
  // Motion
  velocity: number;      // m/s
  acceleration: number;  // m/s^2
  
  // Rendering/metadata
  color?: string;
  
  // State
  isChangingLane: boolean;
  targetLaneId?: LaneID;
  laneChangeProgress?: number; // [0, 1]
  
  // References
  leaderId?: VehicleID;
  followerIds?: VehicleID[];
}

// ============================================================================
// DRIVER MODEL INTERFACE (Strategy Pattern)
// ============================================================================

export interface DriverModelContext {
  vehicle: VehicleState;
  leader?: VehicleState;
  follower?: VehicleState;
  lane: Lane;
  network: RoadNetwork;
  dt: number;
}

export interface IDriverModel {
  readonly modelName: string;
  readonly version: string;
  
  /**
   * Calculate desired acceleration for car-following
   */
  calculateAcceleration(context: DriverModelContext): number;
  
  /**
   * Get model-specific parameters
   */
  getParameters(): Record<string, number>;
  
  /**
   * Update parameters at runtime
   */
  setParameters(params: Partial<Record<string, number>>): void;
}

export interface ILaneChangeModel {
  readonly modelName: string;
  
  /**
   * Evaluate lane change desirability and safety
   * Returns: { desirable, safe, utility, targetLane }
   */
  evaluateLaneChange(
    vehicle: VehicleState,
    currentLane: Lane,
    adjacentLanes: Lane[],
    vehicles: Map<VehicleID, VehicleState>,
    network: RoadNetwork
  ): LaneChangeDecision;
}

export interface LaneChangeDecision {
  shouldChange: boolean;
  targetLaneId?: LaneID;
  utility: number;
  isSafe: boolean;
  reason?: 'discretionary' | 'mandatory' | 'none';
}

// ============================================================================
// ROAD NETWORK STRUCTURES
// ============================================================================

export interface Node {
  id: NodeID;
  position: Vector2D;
  type: 'junction' | 'endpoint' | 'waypoint';
  
  // Connected edges
  incomingEdges: EdgeID[];
  outgoingEdges: EdgeID[];
  
  // Junction properties
  isSignalized?: boolean;
  priority?: number;
  
  // Metadata
  metadata?: Record<string, any>;
}

export interface Lane {
  id: LaneID;
  edgeId: EdgeID;
  index: number;        // Lane index within edge (0 = rightmost)
  
  // Geometry
  centerline: Vector2D[]; // Polyline points
  width: number;
  length: number;         // Total arc length
  
  // Properties
  speedLimit: number;     // m/s
  laneType: 'driving' | 'bus' | 'bike' | 'parking' | 'shoulder';
  
  // Connectivity
  predecessors: LaneID[];
  successors: LaneID[];
  leftNeighbor?: LaneID;
  rightNeighbor?: LaneID;
  
  // Turn restrictions
  allowedTurns?: Set<'left' | 'straight' | 'right' | 'u-turn'>;
}

export interface Edge {
  id: EdgeID;
  fromNode: NodeID;
  toNode: NodeID;
  
  // Lanes
  lanes: Lane[];
  laneCount: number;
  
  // Geometry
  geometry: Vector2D[];   // Control points for curve generation
  
  // Properties
  roadType: 'highway' | 'arterial' | 'collector' | 'local' | 'ramp';
  oneWay: boolean;
  
  // Metadata
  name?: string;
  metadata?: Record<string, any>;
}

export interface Intersection {
  nodeId: NodeID;
  type: 'signalized' | 'stop' | 'yield' | 'roundabout' | 'uncontrolled';
  
  // Traffic control
  signalPhases?: SignalPhase[];
  currentPhase?: number;
  
  // Turn movements
  movements: TurnMovement[];
}

export interface SignalPhase {
  id: string;
  duration: number;       // seconds
  greenLanes: LaneID[];
  yellowLanes: LaneID[];
  redLanes: LaneID[];
}

export interface TurnMovement {
  fromLane: LaneID;
  toLane: LaneID;
  type: 'left' | 'straight' | 'right' | 'u-turn';
  conflict: boolean;      // Conflicts with other movements
  priority: number;
}

// ============================================================================
// ROAD NETWORK GRAPH
// ============================================================================

export interface RoadNetwork {
  nodes: Map<NodeID, Node>;
  edges: Map<EdgeID, Edge>;
  lanes: Map<LaneID, Lane>;
  intersections: Map<NodeID, Intersection>;
  
  // Spatial index for efficient queries
  spatialIndex?: ISpatialIndex;
  
  // Methods
  getNode(id: NodeID): Node | undefined;
  getEdge(id: EdgeID): Edge | undefined;
  getLane(id: LaneID): Lane | undefined;
  getIntersection(nodeId: NodeID): Intersection | undefined;
  
  // Pathfinding
  findRoute(fromLane: LaneID, toLane: LaneID): LaneID[];
  
  // Geometry queries
  getLaneAt(position: Vector2D): LaneID | undefined;
  getAdjacentLanes(laneId: LaneID): Lane[];
  
  // Serialization
  toJSON(): NetworkJSON;
}

// ============================================================================
// SPATIAL INDEX INTERFACE
// ============================================================================

export interface ISpatialIndex {
  insert(id: VehicleID, bounds: BoundingBox): void;
  remove(id: VehicleID): void;
  update(id: VehicleID, bounds: BoundingBox): void;
  query(bounds: BoundingBox): VehicleID[];
  queryRadius(center: Vector2D, radius: number): VehicleID[];
  clear(): void;
}

// ============================================================================
// SIMULATION ENGINE
// ============================================================================

export interface SimulationConfig {
  timeStep: number;           // seconds (e.g., 0.1)
  targetFPS: number;
  maxVehicles: number;
  enableCollisionDetection: boolean;
  spatialIndexType: 'quadtree' | 'rtree';
}

export interface SimulationEngine {
  // State
  currentTime: number;
  vehicles: Map<VehicleID, VehicleState>;
  network: RoadNetwork;
  
  // Model registry
  driverModels: Map<VehicleCategory, IDriverModel>;
  laneChangeModel: ILaneChangeModel;
  
  // Spatial index
  spatialIndex: ISpatialIndex;
  
  // Methods
  step(dt: number): void;
  addVehicle(vehicle: VehicleState): void;
  removeVehicle(id: VehicleID): void;
  getVehicle(id: VehicleID): VehicleState | undefined;
  
  // Model management
  registerDriverModel(category: VehicleCategory, model: IDriverModel): void;
  setLaneChangeModel(model: ILaneChangeModel): void;
  
  // Queries
  getVehiclesInLane(laneId: LaneID): VehicleState[];
  getLeader(vehicleId: VehicleID): VehicleState | undefined;
  getFollowers(vehicleId: VehicleID): VehicleState[];
  
  // Lifecycle
  reset(): void;
  getState(): SimulationSnapshot;
  setState(snapshot: SimulationSnapshot): void;
}

export interface SimulationSnapshot {
  time: number;
  vehicles: VehicleState[];
  networkState?: any;
}

// ============================================================================
// PLUGINS
// ============================================================================

export interface ISimulationPlugin {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  
  initialize(engine: SimulationEngine, network: RoadNetwork): void;
  update(dt: number, time: number): void;
  dispose(): void;
  getConfig(): Record<string, any>;
  setConfig(config: Record<string, any>): void;
}

// ============================================================================
// MODEL REGISTRY (Plugin System)
// ============================================================================

export interface ModelRegistryEntry {
  name: string;
  version: string;
  category: 'car-following' | 'lane-change' | 'intersection' | 'other';
  factory: () => IDriverModel | ILaneChangeModel;
  metadata?: {
    author?: string;
    description?: string;
    parameters?: Array<{
      name: string;
      type: string;
      default: number;
      min?: number;
      max?: number;
      description?: string;
    }>;
  };
}

export interface IModelRegistry {
  register(entry: ModelRegistryEntry): void;
  unregister(name: string): void;
  get(name: string): ModelRegistryEntry | undefined;
  list(category?: string): ModelRegistryEntry[];
  create(name: string): IDriverModel | ILaneChangeModel;
}

// ============================================================================
// SERIALIZATION FORMATS
// ============================================================================

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

// ============================================================================
// WORKER COMMUNICATION
// ============================================================================

export type WorkerMessageType = 
  | 'INIT'
  | 'STEP'
  | 'ADD_VEHICLE'
  | 'REMOVE_VEHICLE'
  | 'UPDATE_NETWORK'
  | 'SET_CONFIG'
  | 'GET_STATE'
  | 'RESET';

export interface WorkerMessage {
  type: WorkerMessageType;
  payload?: any;
  requestId?: string;
}

export interface WorkerResponse {
  type: 'SUCCESS' | 'ERROR' | 'STATE_UPDATE';
  payload?: any;
  requestId?: string;
  error?: string;
}

// ============================================================================
// VEHICLE FACTORY
// ============================================================================

export interface VehicleFactory {
  createVehicle(
    category: VehicleCategory,
    laneId: LaneID,
    lanePosition: number,
    velocity?: number,
    customParams?: Partial<VehicleDriverParams>
  ): VehicleState;
  
  createRandomVehicle(
    laneId: LaneID,
    lanePosition: number
  ): VehicleState;
}
