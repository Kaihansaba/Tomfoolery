import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, Plus, Minus, Zap, Info, Gauge } from 'lucide-react';
import { TrafficSimulationEngine } from './simulation_engine';
import { RoadNetworkImpl } from './road_network_impl';
import { IDMModel, MOBILModel } from './traffic_sim_models';
import {
  DEFAULT_VEHICLE_TYPES,
  Lane,
  NetworkJSON,
  SimulationConfig,
  VehicleCategory,
  VehicleState,
  Vector2D,
} from './traffic_sim_interfaces';
import exampleNetworks from './example_networks.json';
import heilbronnPerchance from './heilbronnperchance.json';
import testperchance from './testperchance.json';

const networks = {
  ...exampleNetworks,
  heilbronn_perchance: heilbronnPerchance as NetworkJSON,
  test_perchance: testperchance as NetworkJSON,
} satisfies Record<string, NetworkJSON>;

type ScenarioKey = keyof typeof networks;

interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface HudState {
  time: number;
  vehicles: number;
  avgSpeed: number;
  fps: number;
}

let vehicleCounter = 0;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3.0;

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function distance(a: Vector2D, b: Vector2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function projectAlongLane(lane: Lane, s: number): { position: Vector2D; heading: number } {
  const clamped = Math.max(0, Math.min(lane.length - 0.01, s));
  let remaining = clamped;

  for (let i = 0; i < lane.centerline.length - 1; i++) {
    const p0 = lane.centerline[i];
    const p1 = lane.centerline[i + 1];
    const segmentLength = distance(p0, p1);

    if (remaining <= segmentLength) {
      const t = segmentLength > 0 ? remaining / segmentLength : 0;
      return {
        position: {
          x: p0.x + (p1.x - p0.x) * t,
          y: p0.y + (p1.y - p0.y) * t,
        },
        heading: Math.atan2(p1.y - p0.y, p1.x - p0.x),
      };
    }

    remaining -= segmentLength;
  }

  const last = lane.centerline[lane.centerline.length - 1];
  const prev = lane.centerline[lane.centerline.length - 2] || last;
  return {
    position: last,
    heading: Math.atan2(last.y - prev.y, last.x - prev.x),
  };
}

function worldToScreen(view: ViewTransform, point: Vector2D): Vector2D {
  return {
    x: point.x * view.scale + view.offsetX,
    y: point.y * view.scale + view.offsetY,
  };
}

function computeView(network: RoadNetworkImpl, canvas: HTMLCanvasElement): ViewTransform {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const lane of network.lanes.values()) {
    for (const pt of lane.centerline) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
  }

  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
    minX = minY = 0;
    maxX = maxY = 100;
  }

  const padding = 40;
  const width = Math.max(20, maxX - minX);
  const height = Math.max(20, maxY - minY);
  const scale = Math.min(
    (canvas.width - padding * 2) / width,
    (canvas.height - padding * 2) / height
  );

  return {
    scale,
    offsetX: padding - minX * scale,
    offsetY: padding - minY * scale,
  };
}

function pickCategory(): VehicleCategory {
  const roll = Math.random();
  if (roll < 0.6) return VehicleCategory.CAR;
  if (roll < 0.78) return VehicleCategory.TRUCK;
  if (roll < 0.9) return VehicleCategory.BUS;
  if (roll < 0.97) return VehicleCategory.MOTORCYCLE;
  return VehicleCategory.AUTONOMOUS;
}

function createVehicleState(lane: Lane, position: number, category?: VehicleCategory): VehicleState {
  const type = category ?? pickCategory();
  const params = DEFAULT_VEHICLE_TYPES[type];
  const targetSpeed = Math.min(params.driver.desiredSpeed, lane.speedLimit);
  const speed = targetSpeed * (0.65 + Math.random() * 0.25);
  const { position: worldPos, heading } = projectAlongLane(lane, position);

  return {
    id: `veh_${vehicleCounter++}`,
    type,
    position: worldPos,
    heading,
    laneId: lane.id,
    lanePosition: position,
    laneOffset: 0,
    velocity: speed,
    acceleration: 0,
    isChangingLane: false,
    targetLaneId: undefined,
    laneChangeProgress: undefined,
    leaderId: undefined,
    followerIds: [],
    color: params.color,
  };
}

function seedVehicles(engine: TrafficSimulationEngine, scenario: ScenarioKey): void {
  const drivingLanes = Array.from(engine.network.lanes.values()).filter(
    lane => lane.laneType === 'driving'
  );

  const baseDensity =
    scenario === 'urban_intersection' ? 3 : scenario === 'roundabout' ? 2 : 8;

  for (const lane of drivingLanes) {
    const segmentCount = Math.max(
      1,
      Math.min(baseDensity, Math.floor(lane.length / 30))
    );

    for (let i = 0; i < segmentCount; i++) {
      const spacing = lane.length / segmentCount;
      const pos = 5 + i * spacing + Math.random() * Math.min(spacing * 0.35, 10);
      if (pos >= lane.length - 5) continue;
      const vehicle = createVehicleState(lane, pos);
      engine.addVehicle(vehicle);
    }
  }
}

function drawLane(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  lane: Lane,
  index: number
): void {
  const coords = lane.centerline.map(pt => worldToScreen(view, pt));
  const laneWidth = clamp(lane.width * view.scale, 1, 12);

  ctx.strokeStyle = index % 2 === 0 ? '#394d6d' : '#2f3d56';
  ctx.lineWidth = laneWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(coords[0].x, coords[0].y);
  for (let i = 1; i < coords.length; i++) {
    ctx.lineTo(coords[i].x, coords[i].y);
  }
  ctx.stroke();

  ctx.strokeStyle = '#a5b4fc';
  ctx.setLineDash([10, 12]);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(coords[0].x, coords[0].y);
  for (let i = 1; i < coords.length; i++) {
    ctx.lineTo(coords[i].x, coords[i].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawVehicle(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  vehicle: VehicleState
): void {
  const base = DEFAULT_VEHICLE_TYPES[vehicle.type];
  const width = clamp(base.physical.width * view.scale, 3, 14);
  const length = clamp(base.physical.length * view.scale, 6, 32);
  const pos = worldToScreen(view, vehicle.position);

  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(vehicle.heading);
  ctx.fillStyle = vehicle.color || base.color || '#6ee7b7';
  ctx.strokeStyle = '#0b0f1a';
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.rect(-length / 2, -width / 2, length, width);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(length / 2 - 2, -width / 2 + 1, 2, 2);
  ctx.fillRect(length / 2 - 2, width / 2 - 3, 2, 2);
  ctx.restore();
}

function drawScene(
  canvas: HTMLCanvasElement,
  engine: TrafficSimulationEngine,
  view: ViewTransform
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0a0f1f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let laneIndex = 0;
  for (const lane of engine.network.lanes.values()) {
    drawLane(ctx, view, lane, laneIndex++);
  }

  for (const vehicle of engine.vehicles.values()) {
    drawVehicle(ctx, view, vehicle);
  }
}

export default function TrafficSimulationApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const runtimeRef = useRef<{
    engine: TrafficSimulationEngine;
    network: RoadNetworkImpl;
  } | null>(null);
  const viewRef = useRef<ViewTransform | null>(null);
  const rafRef = useRef<number>();
  const lastFrameRef = useRef<number>(0);
  const lastDrawRef = useRef<number>(0);
  const hudAccumulatorRef = useRef<number>(0);

  const [scenario, setScenario] = useState<ScenarioKey>('simple_highway');
  const [isRunning, setIsRunning] = useState(true);
  const [timeScale, setTimeScale] = useState(1);
  const [hud, setHud] = useState<HudState>({
    time: 0,
    vehicles: 0,
    avgSpeed: 0,
    fps: 0,
  });
  const [showHud, setShowHud] = useState(true);

  const initialize = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const networkJSON = networks[scenario];
    const network = RoadNetworkImpl.fromJSON(networkJSON);
    const config: SimulationConfig = {
      timeStep: 1 / 60,
      targetFPS: 60,
      maxVehicles: 600,
      enableCollisionDetection: false,
      spatialIndexType: 'quadtree',
    };

    const engine = new TrafficSimulationEngine(network, config);
    Object.entries(DEFAULT_VEHICLE_TYPES).forEach(([key, typeConfig]) => {
      engine.registerDriverModel(key as VehicleCategory, new IDMModel(typeConfig.driver));
    });
    engine.setLaneChangeModel(new MOBILModel());
    seedVehicles(engine, scenario);

    runtimeRef.current = { engine, network };
    viewRef.current = computeView(network, canvas);
    lastFrameRef.current = performance.now();
    lastDrawRef.current = performance.now();
    hudAccumulatorRef.current = 0;

    drawScene(canvas, engine, viewRef.current);
    setHud({
      time: 0,
      vehicles: engine.vehicles.size,
      avgSpeed: 0,
      fps: 0,
    });
  };

  const attachCanvasRef = useCallback((node: HTMLCanvasElement | null) => {
    canvasRef.current = node;
    if (node) {
      setCanvasReady(true);
    }
  }, []);

  useEffect(() => {
    if (!canvasReady) return;
    initialize();
  }, [canvasReady, scenario]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      const prevView = viewRef.current;
      const prevWidth = canvas.width;
      const prevHeight = canvas.height;
      canvas.width = rect.width;
      canvas.height = rect.height;
      const runtime = runtimeRef.current;
      if (runtime) {
        if (prevView && prevWidth > 0 && prevHeight > 0) {
          const centerWorld = {
            x: (prevWidth / 2 - prevView.offsetX) / prevView.scale,
            y: (prevHeight / 2 - prevView.offsetY) / prevView.scale,
          };
          viewRef.current = {
            scale: prevView.scale,
            offsetX: canvas.width / 2 - centerWorld.x * prevView.scale,
            offsetY: canvas.height / 2 - centerWorld.y * prevView.scale,
          };
        } else {
          viewRef.current = computeView(runtime.network, canvas);
        }
        drawScene(canvas, runtime.engine, viewRef.current);
      }
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    if (!isRunning) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    const tick = (timestamp: number) => {
      const runtime = runtimeRef.current;
      const canvas = canvasRef.current;
      const view = viewRef.current;
      if (!runtime || !canvas || !view) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const delta = Math.min((timestamp - lastFrameRef.current) / 1000, 0.25);
      lastFrameRef.current = timestamp;
      runtime.engine.step(delta * timeScale);
      drawScene(canvas, runtime.engine, view);

      hudAccumulatorRef.current += delta;
      const drawDelta = timestamp - lastDrawRef.current;
      if (hudAccumulatorRef.current >= 0.25) {
        const vehicles = Array.from(runtime.engine.vehicles.values());
        const avgSpeed =
          vehicles.length > 0
            ? vehicles.reduce((sum, v) => sum + v.velocity, 0) / vehicles.length
            : 0;

        setHud({
          time: runtime.engine.currentTime,
          vehicles: vehicles.length,
          avgSpeed,
          fps: drawDelta > 0 ? 1000 / drawDelta : 60,
        });

        hudAccumulatorRef.current = 0;
        lastDrawRef.current = timestamp;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isRunning, timeScale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (event: WheelEvent) => {
      const runtime = runtimeRef.current;
      const view = viewRef.current;
      if (!runtime || !view) return;
      event.preventDefault();

      const rect = canvas.getBoundingClientRect();
      const cursor = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      const worldBefore = {
        x: (cursor.x - view.offsetX) / view.scale,
        y: (cursor.y - view.offsetY) / view.scale,
      };

      const zoomFactor = Math.exp(-event.deltaY * 0.001);
      const newScale = clamp(view.scale * zoomFactor, MIN_ZOOM, MAX_ZOOM);

      viewRef.current = {
        scale: newScale,
        offsetX: cursor.x - worldBefore.x * newScale,
        offsetY: cursor.y - worldBefore.y * newScale,
      };

      drawScene(canvas, runtime.engine, viewRef.current);
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [canvasReady]);

  const handleAddVehicle = () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const lanes = Array.from(runtime.network.lanes.values()).filter(
      l => l.laneType === 'driving'
    );
    if (lanes.length === 0) return;

    const bestLane = lanes.reduce(
      (best, lane) => {
        const count = runtime.engine.getVehiclesInLane(lane.id).length;
        if (count < best.count) {
          return { lane, count };
        }
        return best;
      },
      { lane: lanes[0], count: runtime.engine.getVehiclesInLane(lanes[0].id).length }
    ).lane;

    const pos = Math.min(bestLane.length - 5, 5 + Math.random() * bestLane.length * 0.6);
    const vehicle = createVehicleState(bestLane, pos);
    runtime.engine.addVehicle(vehicle);
  };

  const handleReset = () => {
    setIsRunning(false);
    initialize();
    setIsRunning(true);
  };

  const renderStat = (label: string, value: string) => (
    <div className="flex justify-between text-sm text-slate-200">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );

  return (
    <div className="w-full h-screen bg-slate-900 text-white grid grid-cols-[320px_1fr]">
      <div className="border-r border-slate-800 bg-slate-950/70 p-4 space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded bg-gradient-to-br from-emerald-400/30 to-cyan-400/20">
            <Zap className="text-emerald-300" size={24} />
          </div>
          <div>
            <div className="text-lg font-semibold">Traffic Simulation</div>
            <div className="text-xs text-slate-400">IDM + MOBIL - 60 FPS renderer</div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm uppercase tracking-wide text-slate-400">Scenario</div>
          <select
            value={scenario}
            onChange={e => setScenario(e.target.value as ScenarioKey)}
            className="w-full rounded bg-slate-800 border border-slate-700 px-3 py-2"
          >
            <option value="simple_highway">Highway with ramps</option>
            <option value="urban_intersection">Signalized intersection</option>
            <option value="roundabout">Four-arm roundabout</option>
            <option value="heilbronn_perchance">Heilbronn Perchance (full)</option>
            <option value="test_perchance">Test Perchance (full)</option>
          </select>
        </div>

        <div className="space-y-3">
          <div className="text-sm uppercase tracking-wide text-slate-400">Simulation</div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setIsRunning(prev => !prev)}
              className="flex items-center justify-center gap-2 rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-2"
            >
              {isRunning ? <Pause size={16} /> : <Play size={16} />}
              {isRunning ? 'Pause' : 'Resume'}
            </button>
            <button
              onClick={handleReset}
              className="flex items-center justify-center gap-2 rounded bg-slate-800 hover:bg-slate-700 px-3 py-2"
            >
              <RotateCcw size={16} /> Reset
            </button>
            <button
              onClick={handleAddVehicle}
              className="flex items-center justify-center gap-2 rounded bg-cyan-600 hover:bg-cyan-500 px-3 py-2 col-span-2"
            >
              <Plus size={16} /> Inject vehicle
            </button>
          </div>

          <div className="flex items-center gap-3">
            <div className="p-2 rounded bg-slate-800">
              <Gauge size={18} />
            </div>
            <div className="flex-1">
              <div className="flex justify-between text-xs text-slate-400">
                <span>Time scale</span>
                <span className="font-mono text-white">{timeScale.toFixed(1)}x</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <button
                  onClick={() => setTimeScale(v => Math.max(0.25, v - 0.25))}
                  className="p-2 rounded bg-slate-800 hover:bg-slate-700"
                >
                  <Minus size={14} />
                </button>
                <div className="flex-1 h-1 rounded bg-slate-800">
                  <div
                    className="h-full rounded bg-emerald-400"
                    style={{ width: `${(Math.min(timeScale, 3) / 3) * 100}%` }}
                  />
                </div>
                <button
                  onClick={() => setTimeScale(v => Math.min(4, v + 0.25))}
                  className="p-2 rounded bg-slate-800 hover:bg-slate-700"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm uppercase tracking-wide text-slate-400">Telemetry</div>
          <div className="rounded border border-slate-800 bg-slate-900 p-3 space-y-2">
            {renderStat('Sim time', `${hud.time.toFixed(1)} s`)}
            {renderStat('Vehicles', `${hud.vehicles}`)}
            {renderStat('Avg speed', `${(hud.avgSpeed * 3.6).toFixed(1)} km/h`)}
            {renderStat('Render FPS', `${hud.fps.toFixed(0)} fps`)}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm uppercase tracking-wide text-slate-400">Legend</div>
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-300">
            {Object.values(DEFAULT_VEHICLE_TYPES).map(type => (
              <div key={type.category} className="flex items-center gap-2">
                <span
                  className="w-4 h-4 rounded-sm border border-slate-800"
                  style={{ backgroundColor: type.color }}
                />
                <span className="capitalize">{type.category.toLowerCase()}</span>
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={() => setShowHud(v => !v)}
          className="flex items-center gap-2 text-sm text-slate-300 hover:text-white"
        >
          <Info size={14} />
          {showHud ? 'Hide' : 'Show'} on-canvas stats
        </button>
      </div>

      <div className="relative bg-slate-950">
        <canvas ref={attachCanvasRef} className="w-full h-full" />
        {showHud && (
          <div className="absolute top-4 right-4 bg-slate-900/80 backdrop-blur rounded border border-slate-800 px-4 py-3 text-sm space-y-1">
            <div className="flex justify-between gap-6">
              <span className="text-slate-400">t</span>
              <span className="font-mono">{hud.time.toFixed(1)} s</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-slate-400">n</span>
              <span className="font-mono">{hud.vehicles}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-slate-400">v_avg</span>
              <span className="font-mono">{(hud.avgSpeed * 3.6).toFixed(1)} km/h</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-slate-400">fps</span>
              <span className="font-mono">{hud.fps.toFixed(0)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
