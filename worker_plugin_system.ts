/// <reference lib="WebWorker" />
// ============================================================================
// WEB WORKER - Simulation Worker Implementation
// ============================================================================
// File: simulation.worker.ts

import {
  WorkerMessage,
  WorkerResponse,
  SimulationConfig,
  SimulationSnapshot,
  VehicleState,
  NetworkJSON,
  DEFAULT_VEHICLE_TYPES,
  VehicleCategory,
  SimulationEngine,
  RoadNetwork,
  NodeID,
  ISimulationPlugin,
} from './traffic_sim_interfaces';
import { TrafficSimulationEngine } from './simulation_engine';
import { RoadNetworkImpl } from './road_network_impl';
import { IDMModel, MOBILModel } from './traffic_sim_models';

const workerScope: DedicatedWorkerGlobalScope | null =
  typeof self !== 'undefined' && typeof (self as any).importScripts === 'function'
    ? (self as unknown as DedicatedWorkerGlobalScope)
    : null;

if (workerScope) {
  let engine: TrafficSimulationEngine | null = null;
  let lastTimestamp = 0;

  workerScope.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const { type, payload, requestId } = event.data;
    
    try {
      switch (type) {
        case 'INIT':
          handleInit(payload);
          sendResponse('SUCCESS', { initialized: true }, requestId);
          break;
          
        case 'STEP':
          handleStep(payload);
          break;
          
        case 'ADD_VEHICLE':
          handleAddVehicle(payload);
          sendResponse('SUCCESS', { vehicleId: payload.id }, requestId);
          break;
          
        case 'REMOVE_VEHICLE':
          handleRemoveVehicle(payload);
          sendResponse('SUCCESS', {}, requestId);
          break;
          
        case 'UPDATE_NETWORK':
          handleUpdateNetwork(payload);
          sendResponse('SUCCESS', {}, requestId);
          break;
          
        case 'SET_CONFIG':
          handleSetConfig(payload);
          sendResponse('SUCCESS', {}, requestId);
          break;
          
        case 'GET_STATE':
          const state = engine?.getState();
          sendResponse('SUCCESS', state, requestId);
          break;
          
        case 'RESET':
          handleReset();
          sendResponse('SUCCESS', {}, requestId);
          break;
          
        default:
          throw new Error(`Unknown message type: ${type}`);
      }
    } catch (error) {
      sendResponse('ERROR', null, requestId, (error as Error).message);
    }
  };

  function handleInit(payload: { network: NetworkJSON; config: SimulationConfig }): void {
    const { network: networkJSON, config } = payload;
    
    const network = RoadNetworkImpl.fromJSON(networkJSON);
    engine = new TrafficSimulationEngine(network, config);
    
    for (const [category, typeConfig] of Object.entries(DEFAULT_VEHICLE_TYPES)) {
      const model = new IDMModel(typeConfig.driver);
      engine.registerDriverModel(category as VehicleCategory, model);
    }
    
    engine.setLaneChangeModel(new MOBILModel());
    lastTimestamp = performance.now();
  }

  function handleStep(payload: { timestamp?: number }): void {
    if (!engine) return;
    
    const currentTimestamp = payload.timestamp || performance.now();
    const dt = (currentTimestamp - lastTimestamp) / 1000;
    lastTimestamp = currentTimestamp;
    
    engine.step(dt);
    const state = engine.getState();
    sendStateUpdate(state);
  }

  function handleAddVehicle(vehicle: VehicleState): void {
    if (!engine) return;
    engine.addVehicle(vehicle);
  }

  function handleRemoveVehicle(payload: { vehicleId: string }): void {
    if (!engine) return;
    engine.removeVehicle(payload.vehicleId);
  }

  function handleUpdateNetwork(payload: { network: NetworkJSON }): void {
    if (!engine) return;
    const network = RoadNetworkImpl.fromJSON(payload.network);
    engine.network = network;
  }

  function handleSetConfig(payload: { config: Partial<SimulationConfig> }): void {
    // Placeholder: update config fields on the engine if exposed
  }

  function handleReset(): void {
    if (!engine) return;
    engine.reset();
    lastTimestamp = performance.now();
  }

  function sendResponse(
    type: 'SUCCESS' | 'ERROR',
    payload: any,
    requestId?: string,
    error?: string
  ): void {
    if (!workerScope) return;
    const response: WorkerResponse = {
      type,
      payload,
      requestId,
      error,
    };
    
    workerScope.postMessage(response);
  }

  function sendStateUpdate(state: any): void {
    if (!workerScope) return;
    const response: WorkerResponse = {
      type: 'STATE_UPDATE',
      payload: state,
    };
    
    workerScope.postMessage(response);
  }
}

// ============================================================================
// WORKER COMMUNICATION INTERFACE (Main Thread Side)
// ============================================================================
// File: WorkerInterface.ts

export class SimulationWorkerInterface {
  private worker: Worker;
  private requestId = 0;
  private pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  
  private onStateUpdate?: (state: SimulationSnapshot) => void;
  
  constructor(workerUrl: string) {
    this.worker = new Worker(workerUrl);
    this.worker.onmessage = this.handleMessage.bind(this);
  }
  
  private handleMessage(event: MessageEvent<WorkerResponse>): void {
    const { type, payload, requestId, error } = event.data;
    
    if (type === 'STATE_UPDATE') {
      if (this.onStateUpdate) {
        this.onStateUpdate(payload);
      }
      return;
    }
    
    if (!requestId) return;
    
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    
    this.pendingRequests.delete(requestId);
    
    if (type === 'ERROR') {
      pending.reject(new Error(error || 'Unknown error'));
    } else {
      pending.resolve(payload);
    }
  }
  
  private sendMessage<T>(type: WorkerMessage['type'], payload?: any): Promise<T> {
    const requestId = `req_${this.requestId++}`;
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      
      const message: WorkerMessage = {
        type,
        payload,
        requestId,
      };
      
      this.worker.postMessage(message);
      
      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 10000);
    });
  }
  
  // =========================================================================
  // PUBLIC API
  // =========================================================================
  
  async initialize(network: NetworkJSON, config: SimulationConfig): Promise<void> {
    await this.sendMessage('INIT', { network, config });
  }
  
  step(timestamp?: number): void {
    // Don't wait for response, fire and forget
    const message: WorkerMessage = {
      type: 'STEP',
      payload: { timestamp },
    };
    this.worker.postMessage(message);
  }
  
  async addVehicle(vehicle: VehicleState): Promise<{ vehicleId: string }> {
    return this.sendMessage('ADD_VEHICLE', vehicle);
  }
  
  async removeVehicle(vehicleId: string): Promise<void> {
    await this.sendMessage('REMOVE_VEHICLE', { vehicleId });
  }
  
  async updateNetwork(network: NetworkJSON): Promise<void> {
    await this.sendMessage('UPDATE_NETWORK', { network });
  }
  
  async setConfig(config: Partial<SimulationConfig>): Promise<void> {
    await this.sendMessage('SET_CONFIG', { config });
  }
  
  async getState(): Promise<SimulationSnapshot> {
    return this.sendMessage('GET_STATE');
  }
  
  async reset(): Promise<void> {
    await this.sendMessage('RESET');
  }
  
  setStateUpdateCallback(callback: (state: SimulationSnapshot) => void): void {
    this.onStateUpdate = callback;
  }
  
  terminate(): void {
    this.worker.terminate();
  }
}

// ============================================================================
// PLUGIN SYSTEM - Model Registry
// ============================================================================
// File: ModelRegistry.ts

import {
  IModelRegistry,
  ModelRegistryEntry,
  IDriverModel,
  ILaneChangeModel,
} from './traffic_sim_interfaces';

export class ModelRegistry implements IModelRegistry {
  private models = new Map<string, ModelRegistryEntry>();
  
  register(entry: ModelRegistryEntry): void {
    if (this.models.has(entry.name)) {
      throw new Error(`Model '${entry.name}' is already registered`);
    }
    
    this.models.set(entry.name, entry);
    console.log(`Registered model: ${entry.name} v${entry.version}`);
  }
  
  unregister(name: string): void {
    this.models.delete(name);
  }
  
  get(name: string): ModelRegistryEntry | undefined {
    return this.models.get(name);
  }
  
  list(category?: string): ModelRegistryEntry[] {
    const entries = Array.from(this.models.values());
    
    if (category) {
      return entries.filter(e => e.category === category);
    }
    
    return entries;
  }
  
  create(name: string): IDriverModel | ILaneChangeModel {
    const entry = this.models.get(name);
    
    if (!entry) {
      throw new Error(`Model '${name}' not found in registry`);
    }
    
    return entry.factory();
  }
}

// Global registry instance
export const globalModelRegistry = new ModelRegistry();

// ============================================================================
// EXAMPLE PLUGIN - Traffic Light Controller
// ============================================================================
// File: TrafficLightPlugin.ts

interface TrafficLightState {
  nodeId: NodeID;
  currentPhase: number;
  phaseTimer: number;
  phases: Array<{
    duration: number;
    greenLanes: string[];
  }>;
}

export class TrafficLightPlugin implements ISimulationPlugin {
  readonly name = 'TrafficLightController';
  readonly version = '1.0.0';
  readonly description = 'Manages traffic signal timing and phase transitions';
  
  private engine!: SimulationEngine;
  private network!: RoadNetwork;
  private lights = new Map<NodeID, TrafficLightState>();
  private config = {
    defaultGreenTime: 30,
    defaultYellowTime: 3,
    defaultRedTime: 2,
  };
  
  initialize(engine: SimulationEngine, network: RoadNetwork): void {
    this.engine = engine;
    this.network = network;
    
    // Initialize traffic lights at signalized intersections
    for (const [nodeId, intersection] of network.intersections.entries()) {
      if (intersection.type === 'signalized' && intersection.signalPhases) {
        this.lights.set(nodeId, {
          nodeId,
          currentPhase: 0,
          phaseTimer: 0,
          phases: intersection.signalPhases.map(phase => ({
            duration: phase.duration,
            greenLanes: phase.greenLanes,
          })),
        });
      }
    }
    
    console.log(`Initialized ${this.lights.size} traffic lights`);
  }
  
  update(dt: number, time: number): void {
    for (const light of this.lights.values()) {
      light.phaseTimer += dt;
      
      const currentPhase = light.phases[light.currentPhase];
      
      if (light.phaseTimer >= currentPhase.duration) {
        // Advance to next phase
        light.currentPhase = (light.currentPhase + 1) % light.phases.length;
        light.phaseTimer = 0;
        
        // Update intersection state in network
        const intersection = this.network.getIntersection(light.nodeId);
        if (intersection) {
          intersection.currentPhase = light.currentPhase;
        }
      }
    }
  }
  
  dispose(): void {
    this.lights.clear();
  }
  
  getConfig(): Record<string, any> {
    return { ...this.config };
  }
  
  setConfig(config: Record<string, any>): void {
    Object.assign(this.config, config);
  }
  
  // Plugin-specific methods
  
  setPhaseTimings(nodeId: NodeID, phaseDurations: number[]): void {
    const light = this.lights.get(nodeId);
    if (!light) return;
    
    phaseDurations.forEach((duration, index) => {
      if (light.phases[index]) {
        light.phases[index].duration = duration;
      }
    });
  }
  
  forcePhase(nodeId: NodeID, phaseIndex: number): void {
    const light = this.lights.get(nodeId);
    if (!light) return;
    
    light.currentPhase = phaseIndex % light.phases.length;
    light.phaseTimer = 0;
  }
}

// ============================================================================
// PLUGIN MANAGER
// ============================================================================
// File: PluginManager.ts

export class PluginManager {
  private plugins = new Map<string, ISimulationPlugin>();
  private engine: SimulationEngine;
  private network: RoadNetwork;
  
  constructor(engine: SimulationEngine, network: RoadNetwork) {
    this.engine = engine;
    this.network = network;
  }
  
  loadPlugin(plugin: ISimulationPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin '${plugin.name}' is already loaded`);
    }
    
    plugin.initialize(this.engine, this.network);
    this.plugins.set(plugin.name, plugin);
    
    console.log(`Loaded plugin: ${plugin.name} v${plugin.version}`);
  }
  
  unloadPlugin(name: string): void {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    
    plugin.dispose();
    this.plugins.delete(name);
    
    console.log(`Unloaded plugin: ${name}`);
  }
  
  getPlugin<T extends ISimulationPlugin>(name: string): T | undefined {
    return this.plugins.get(name) as T | undefined;
  }
  
  updateAll(dt: number, time: number): void {
    for (const plugin of this.plugins.values()) {
      plugin.update(dt, time);
    }
  }
  
  listPlugins(): Array<{ name: string; version: string; description: string }> {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.name,
      version: p.version,
      description: p.description,
    }));
  }
}

// ============================================================================
// USAGE EXAMPLE - Registering Custom Models
// ============================================================================

/*
// Example: Register a custom car-following model

import { globalModelRegistry } from './ModelRegistry';
import { IDriverModel, DriverModelContext } from './traffic_sim_interfaces';

class MyCustomModel implements IDriverModel {
  readonly modelName = 'MyCustomModel';
  readonly version = '1.0';
  
  private params = {
    gain: 0.5,
    dampening: 0.3,
  };
  
  calculateAcceleration(context: DriverModelContext): number {
    // Your custom logic here
    const { vehicle, leader } = context;
    
    if (!leader) {
      return this.params.gain * (30 - vehicle.velocity);
    }
    
    const gap = leader.lanePosition - vehicle.lanePosition;
    const desiredGap = 20;
    const error = gap - desiredGap;
    
    return this.params.gain * error - this.params.dampening * vehicle.velocity;
  }
  
  getParameters() {
    return { ...this.params };
  }
  
  setParameters(params: Partial<Record<string, number>>) {
    Object.assign(this.params, params);
  }
}

// Register the model
globalModelRegistry.register({
  name: 'MyCustomModel',
  version: '1.0',
  category: 'car-following',
  factory: () => new MyCustomModel(),
  metadata: {
    author: 'Your Name',
    description: 'A custom car-following model',
    parameters: [
      { name: 'gain', type: 'number', default: 0.5, min: 0, max: 2 },
      { name: 'dampening', type: 'number', default: 0.3, min: 0, max: 1 },
    ],
  },
});

// Use the model
const model = globalModelRegistry.create('MyCustomModel') as IDriverModel;
engine.registerDriverModel(VehicleCategory.CAR, model);
*/
