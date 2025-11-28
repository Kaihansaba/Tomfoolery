import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  Plus,
  Minus,
  Zap,
  ChevronUp,
  Search,
  Sparkles,
  MapPin,
  Shield,
  Eraser,
  GitBranchPlus,
  TrafficCone,
} from 'lucide-react';
import { TrafficSimulationEngine } from './simulation_engine';
import { RoadNetworkImpl } from './road_network_impl';
import { IDMModel, MOBILModel } from './traffic_sim_models';
import {
  DEFAULT_VEHICLE_TYPES,
  Lane,
  Edge,
  NetworkJSON,
  SimulationConfig,
  VehicleCategory,
  VehicleKind,
  VehicleState,
  Vector2D,
  BackdropConfig,
  GeoReference,
} from './traffic_sim_interfaces';
import exampleNetworks from './example_networks.json';
import heilbronnPerchance from './heilbronnperchance.json';
import testperchance from './testperchance.json';
import { fastIndexLoad } from './src/utils/mapLoader';
import { config as appConfig } from './src/config';

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

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type Selection =
  | { type: 'node'; id: string }
  | { type: 'edge'; id: string; direction: 'forward' | 'backward' };

function polylineBounds(points: Vector2D[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

interface HudState {
  time: number;
  vehicles: number;
  avgSpeed: number;
  fps: number;
}

type StatMode = 'basic' | 'extended' | 'advanced';

type TrafficLightState = 'green' | 'red';
type TrafficLight = {
  id: string;
  position: Vector2D;
  heading: number;
  laneId: string;
  lanePosition: number;
  state: TrafficLightState;
  timerSeconds: number; // 0 for manual
  nextSwitchTime: number; // simulation time when to toggle, if timer > 0
};

type BackdropContext = {
  network: RoadNetworkImpl;
  tileCache: Map<string, HTMLImageElement>;
  pendingTiles: Map<string, Promise<HTMLImageElement>>;
  requestRedraw: () => void;
  enabled: boolean;
  theme?: BackdropConfig;
};

let vehicleCounter = 0;
const MIN_ZOOM = 0.00005;
const MAX_ZOOM = 4;
let obstacleCounter = 50000;
const MIN_ZOOM_SLIDER = MIN_ZOOM;
const MAX_ZOOM_SLIDER = MAX_ZOOM;
const LOD_HIDE_ROADS = 0.7;
const LOD_FADE_START = 0.9;
const LOD_FULL = 1.3;
const HEATMAP_CELL_SIZE = 40; // world units
const CHUNK_WORLD_SIZE = 800; // meters in projected space for dynamic loading
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const VEHICLE_TARGETS = {
  off: 0,
  low: 120,
  mid: 500,
  high: 1000,
} as const;

type OSMNode = {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
};

type OSMWay = {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
};

type OSMElement = OSMNode | OSMWay | { type?: string; [key: string]: any };
type OSMResponse = { elements: OSMElement[] };

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function findClosestNode(
  view: ViewTransform,
  screenX: number,
  screenY: number,
  network: RoadNetworkImpl,
  requireOutgoingEdges: boolean = false
): string | undefined {
  let closestId: string | undefined;
  let minDist = Infinity;

  for (const node of network.nodes.values()) {
    // Skip nodes without outgoing edges if required
    if (requireOutgoingEdges && node.outgoingEdges.length === 0) continue;
    
    const screenPos = worldToScreen(view, node.position);
    const dx = screenPos.x - screenX;
    const dy = screenPos.y - screenY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < minDist) {
      minDist = dist;
      closestId = node.id;
    }
  }

  return closestId;
}

function getValidSpawnNodes(network: RoadNetworkImpl): string[] {
  const validNodes: string[] = [];
  for (const node of network.nodes.values()) {
    if (node.outgoingEdges.length > 0) {
      validNodes.push(node.id);
    }
  }
  return validNodes;
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

function screenToWorld(view: ViewTransform, screen: Vector2D): Vector2D {
  return {
    x: (screen.x - view.offsetX) / view.scale,
    y: (screen.y - view.offsetY) / view.scale,
  };
}

function getViewBounds(view: ViewTransform, canvas: HTMLCanvasElement, marginPx = 80): Bounds {
  const marginWorld = marginPx / view.scale;
  return {
    minX: (0 - view.offsetX) / view.scale - marginWorld,
    maxX: (canvas.width - view.offsetX) / view.scale + marginWorld,
    minY: (0 - view.offsetY) / view.scale - marginWorld,
    maxY: (canvas.height - view.offsetY) / view.scale + marginWorld,
  };
}

function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

function polylineLength(points: Vector2D[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += distance(points[i - 1], points[i]);
  }
  return len;
}

function getEdgePolyline(network: RoadNetworkImpl, edgeId: string): Vector2D[] | undefined {
  const edge = network.getEdge(edgeId);
  if (!edge) return undefined;
  const laneCandidate = edge.lanes.find(l => l.laneType === 'driving') || edge.lanes[0];
  if (laneCandidate?.centerline?.length) return laneCandidate.centerline;
  if ((edge as any).geometry?.length) return (edge as any).geometry as Vector2D[];
  return undefined;
}

function computeEdgeDirection(edge: any): 'forward' | 'backward' {
  const dir = edge?.metadata?.direction ?? edge?.properties?.direction;
  if (dir === 'backward') return 'backward';
  return 'forward';
}

function computeEdgeStats(network: RoadNetworkImpl, edgeId: string) {
  const edge = network.getEdge(edgeId);
  if (!edge) return undefined;
  const polyline = getEdgePolyline(network, edgeId);
  if (!polyline) return undefined;
  const length = polylineLength(polyline);
  const speedLimit =
    (edge as any).speedLimit ??
    (edge as any).metadata?.speed_limit ??
    (edge as any).properties?.speed_limit ??
    undefined;
  const speedVal = typeof speedLimit === 'number' ? speedLimit : undefined;
  const travelMinutes = speedVal && speedVal > 0 ? (length / speedVal) / 60 : undefined;
  const lanes = edge.lanes?.length;
  return { length, speedLimit: speedVal, travelMinutes, lanes };
}

function parseMaxspeed(tags: Record<string, string | undefined> = {}): number | undefined {
  const raw =
    tags['maxspeed:forward'] ||
    tags['maxspeed:backward'] ||
    tags['maxspeed'];
  if (!raw) return undefined;

  const val = raw.trim().toLowerCase();
  // Common textual values we ignore for now
  if (!val || ['signals', 'variable', 'none', 'national', 'unlimited'].includes(val)) {
    return undefined;
  }

  // Handle mph or km/h suffix
  const mphMatch = val.match(/^(\d+)\s*mph$/);
  if (mphMatch) {
    const mph = Number(mphMatch[1]);
    return isFinite(mph) ? mph * 0.44704 : undefined; // convert to m/s
  }

  const kmhMatch = val.match(/^(\d+)\s*(km\/h)?$/);
  if (kmhMatch) {
    const kmh = Number(kmhMatch[1]);
    return isFinite(kmh) ? (kmh / 3.6) : undefined; // convert to m/s
  }

  const numeric = Number(val);
  if (isFinite(numeric)) {
    // Assume km/h if no unit
    return numeric / 3.6;
  }

  return undefined;
}

function downloadJSON(filename: string, data: any) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyJSON(data: any) {
  try {
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn('Clipboard unavailable', err);
  }
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

const laneBoundsCache = new WeakMap<Lane, Bounds>();

function getLaneBounds(lane: Lane): Bounds {
  const cached = laneBoundsCache.get(lane);
  if (cached) return cached;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const pt of lane.centerline) {
    minX = Math.min(minX, pt.x);
    minY = Math.min(minY, pt.y);
    maxX = Math.max(maxX, pt.x);
    maxY = Math.max(maxY, pt.y);
  }

  const halfWidth = lane.width * 0.5 + 2; // include stroke and a small buffer
  const bounds: Bounds = {
    minX: minX - halfWidth,
    minY: minY - halfWidth,
    maxX: maxX + halfWidth,
    maxY: maxY + halfWidth,
  };

  laneBoundsCache.set(lane, bounds);
  return bounds;
}

// ---------------------------------------------------------------------------
// Tile helpers (Web Mercator)
// ---------------------------------------------------------------------------

const DEFAULT_BACKDROP: BackdropConfig = {
  type: 'rasterTile',
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  minZoom: 0,
  maxZoom: 19,
  tileSize: 256,
};

const BACKDROP_THEMES: Record<string, BackdropConfig> = {
  osm: DEFAULT_BACKDROP,
  light: {
    ...DEFAULT_BACKDROP,
    tileUrl: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
  },
  dark: {
    ...DEFAULT_BACKDROP,
    tileUrl: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  },
};

function lonToTile(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 2 ** zoom;
}

function latToTile(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom;
}

function tileToLon(x: number, zoom: number): number {
  return (x / 2 ** zoom) * 360 - 180;
}

function tileToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** zoom;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function worldToGeo(pt: Vector2D, geoRef: GeoReference): { lat: number; lon: number } {
  if (geoRef.projection === 'mercator' && geoRef.originMercatorX !== undefined && geoRef.originMercatorY !== undefined) {
    const R = 6378137;
    const mx = pt.x + geoRef.originMercatorX;
    const myLocal = geoRef.flipY ? -pt.y : pt.y;
    const my = myLocal + geoRef.originMercatorY;
    const lon = (mx / R) * (180 / Math.PI);
    const lat = (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * (180 / Math.PI);
    return { lat, lon };
  }
  return {
    lon: geoRef.originLon + pt.x / geoRef.metersPerDegLon,
    lat: geoRef.originLat + pt.y / geoRef.metersPerDegLat,
  };
}

function geoToWorld(lat: number, lon: number, geoRef: GeoReference): Vector2D {
  if (geoRef.projection === 'mercator' && geoRef.originMercatorX !== undefined && geoRef.originMercatorY !== undefined) {
    const R = 6378137;
    const lonRad = (lon * Math.PI) / 180;
    const latRad = (lat * Math.PI) / 180;
    const mx = R * lonRad - geoRef.originMercatorX;
    const my = R * Math.log(Math.tan(Math.PI / 4 + latRad / 2)) - geoRef.originMercatorY;
    return { x: mx, y: geoRef.flipY ? -my : my };
  }
  return {
    x: (lon - geoRef.originLon) * geoRef.metersPerDegLon,
    y: (lat - geoRef.originLat) * geoRef.metersPerDegLat,
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

function generateUniqueObstacleId(): string {
  return `obs_${obstacleCounter++}`;
}

function createVehicleState(lane: Lane, position: number, category?: VehicleCategory): VehicleState {
  const type = category ?? pickCategory();
  const params = DEFAULT_VEHICLE_TYPES[type];
  const targetSpeed = Math.min(params.driver.desiredSpeed, lane.speedLimit);
  const speed = targetSpeed * (0.65 + Math.random() * 0.25);
  const { position: worldPos, heading } = projectAlongLane(lane, position);

  const vehicleId = `veh_${vehicleCounter++}`;
  
  console.log(`✨ Vehicle ${vehicleId} spawned: ${type} on lane ${lane.id} at position ${position.toFixed(1)}m`);

  return {
    id: vehicleId,
    type,
    kind: 'normal',
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

function createObstacleVehicle(lane: Lane, position: number): VehicleState {
  const clamped = Math.max(0, Math.min(lane.length, position));
  const { position: worldPos, heading } = projectAlongLane(lane, clamped);

  return {
    id: generateUniqueObstacleId(),
    type: VehicleCategory.CAR,
    kind: 'obstacle',
    position: worldPos,
    heading,
    laneId: lane.id,
    lanePosition: clamped,
    laneOffset: 0,
    velocity: 0,
    acceleration: 0,
    isChangingLane: false,
    targetLaneId: undefined,
    laneChangeProgress: undefined,
    leaderId: undefined,
    followerIds: [],
    color: '#f97316',
  };
}

function addObstacleToLane(engine: TrafficSimulationEngine, lane: Lane, position: number): void {
  const obstacle = createObstacleVehicle(lane, position);
  engine.addVehicle(obstacle);
}

function removeObstacleAt(
  engine: TrafficSimulationEngine,
  lane: Lane,
  position: number,
  tolerance: number = 5
): boolean {
  let targetId: string | undefined;
  let minGap = Infinity;
  for (const v of engine.vehicles.values()) {
    if (v.kind !== 'obstacle') continue;
    if (v.laneId !== lane.id) continue;
    const gap = Math.abs(v.lanePosition - position);
    if (gap <= tolerance && gap < minGap) {
      minGap = gap;
      targetId = v.id;
    }
  }

  if (targetId) {
    engine.removeVehicle(targetId);
    return true;
  }
  return false;
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

function drawObstacle(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  vehicle: VehicleState
): void {
  const pos = worldToScreen(view, vehicle.position);
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(vehicle.heading);
  ctx.fillStyle = '#f97316';
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = 2;
  ctx.fillRect(-6, -3.5, 12, 7);
  ctx.strokeRect(-6, -3.5, 12, 7);

  ctx.strokeStyle = '#fff7ed';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-5, -3.5);
  ctx.lineTo(5, 3.5);
  ctx.moveTo(-5, 3.5);
  ctx.lineTo(5, -3.5);
  ctx.stroke();
  ctx.restore();
}

function drawVehicle(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  vehicle: VehicleState
): void {
  if (vehicle.kind === 'obstacle') {
    drawObstacle(ctx, view, vehicle);
    return;
  }

  const base = DEFAULT_VEHICLE_TYPES[vehicle.type];
  const width = clamp(base.physical.width * view.scale, 3, 14);
  const length = clamp(base.physical.length * view.scale, 6, 32);
  const pos = worldToScreen(view, vehicle.position);

  ctx.save();
  
  // Apply fade-out for vehicles marked for removal (dead end or idle)
  if (vehicle.fadeOutProgress !== undefined) {
    ctx.globalAlpha = 1 - vehicle.fadeOutProgress;
  }
  
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

function drawHeatmap(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  vehicles: Iterable<VehicleState>,
  visibleBounds: Bounds
): void {
  const grid = new Map<string, number>();
  const cell = HEATMAP_CELL_SIZE;
  let maxCount = 0;

  for (const v of vehicles) {
    if (
      v.position.x < visibleBounds.minX ||
      v.position.x > visibleBounds.maxX ||
      v.position.y < visibleBounds.minY ||
      v.position.y > visibleBounds.maxY
    ) {
      continue;
    }
    const gx = Math.floor(v.position.x / cell);
    const gy = Math.floor(v.position.y / cell);
    const key = `${gx}:${gy}`;
    const next = (grid.get(key) ?? 0) + 1;
    grid.set(key, next);
    if (next > maxCount) maxCount = next;
  }

  if (maxCount === 0) return;

  for (const [key, count] of grid.entries()) {
    const [gxStr, gyStr] = key.split(':');
    const gx = Number(gxStr);
    const gy = Number(gyStr);
    const alpha = clamp(count / (maxCount * 1.1), 0.15, 0.85);
    const intensity = Math.floor(160 + alpha * 95);
    ctx.fillStyle = `rgba(${intensity}, 64, 80, ${alpha})`;

    const worldMin = { x: gx * cell, y: gy * cell };
    const worldMax = { x: (gx + 1) * cell, y: (gy + 1) * cell };
    const pMin = worldToScreen(view, worldMin);
    const pMax = worldToScreen(view, worldMax);
    ctx.fillRect(pMin.x, pMax.y, pMax.x - pMin.x, pMin.y - pMax.y);
  }
}

function pickClosestNode(
  view: ViewTransform,
  network: RoadNetworkImpl,
  screen: Vector2D,
  thresholdPx = 10
): { id: string; dist: number } | undefined {
  let best: { id: string; dist: number } | undefined;
  for (const node of network.nodes.values()) {
    const pt = worldToScreen(view, node.position);
    const dx = pt.x - screen.x;
    const dy = pt.y - screen.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < thresholdPx && (!best || dist < best.dist)) {
      best = { id: node.id, dist };
    }
  }
  return best;
}

function distancePointToSegment(p: Vector2D, a: Vector2D, b: Vector2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: a.x + t * dx, y: a.y + t * dy };
  return distance(p, proj);
}

function pickClosestEdge(
  view: ViewTransform,
  network: RoadNetworkImpl,
  screen: Vector2D,
  thresholdPx = 8
): { id: string; dist: number; direction: 'forward' | 'backward' } | undefined {
  let best: { id: string; dist: number; direction: 'forward' | 'backward' } | undefined;
  for (const edge of network.edges.values()) {
    const polyline = getEdgePolyline(network, edge.id);
    if (!polyline || polyline.length < 2) continue;
    const screenPts = polyline.map(pt => worldToScreen(view, pt));
    for (let i = 1; i < screenPts.length; i++) {
      const d = distancePointToSegment(screen, screenPts[i - 1], screenPts[i]);
      if (d < thresholdPx && (!best || d < best.dist)) {
        best = { id: edge.id, dist: d, direction: computeEdgeDirection(edge) };
      }
    }
  }
  return best;
}

function findClosestLaneAndPosition(
  view: ViewTransform,
  network: RoadNetworkImpl,
  screen: Vector2D
): { lane: Lane; s: number } | null {
  const world = screenToWorld(view, screen);
  let bestLane: Lane | null = null;
  let bestS = 0;
  let bestDistSq = Infinity;
  const maxDistSq = 25 * 25;

  for (const lane of network.lanes.values()) {
    if (lane.laneType !== 'driving' || lane.centerline.length < 2) continue;

    let accumulated = 0;
    for (let i = 0; i < lane.centerline.length - 1; i++) {
      const p0 = lane.centerline[i];
      const p1 = lane.centerline[i + 1];
      const segLen = distance(p0, p1);
      if (segLen < 1e-6) continue;

      const t =
        ((world.x - p0.x) * (p1.x - p0.x) + (world.y - p0.y) * (p1.y - p0.y)) /
        (segLen * segLen);
      const clamped = Math.max(0, Math.min(1, t));
      const proj = { x: p0.x + (p1.x - p0.x) * clamped, y: p0.y + (p1.y - p0.y) * clamped };
      const dx = world.x - proj.x;
      const dy = world.y - proj.y;
      const distSq = dx * dx + dy * dy;
      const s = accumulated + clamped * segLen;

      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestLane = lane;
        bestS = s;
      }

      accumulated += segLen;
    }
  }

  if (!bestLane || bestDistSq > maxDistSq) return null;
  return { lane: bestLane, s: Math.max(0, Math.min(bestLane.length, bestS)) };
}

function drawDirectionArrow(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  polyline: Vector2D[],
  direction: 'forward' | 'backward'
): void {
  if (polyline.length < 2) return;
  const target = polylineLength(polyline) / 2;
  let traversed = 0;
  let anchor: Vector2D | null = null;
  let heading = 0;
  const pts = direction === 'backward' ? [...polyline].reverse() : polyline;

  for (let i = 1; i < pts.length; i++) {
    const segLen = distance(pts[i - 1], pts[i]);
    if (traversed + segLen >= target) {
      const t = (target - traversed) / segLen;
      anchor = {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
      };
      heading = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
      break;
    }
    traversed += segLen;
  }
  if (!anchor) return;
  const screen = worldToScreen(view, anchor);
  const size = 10;
  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.rotate(heading);
  ctx.fillStyle = '#fbbf24';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, size / 2);
  ctx.lineTo(-size, -size / 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  view: ViewTransform,
  network: RoadNetworkImpl,
  theme: BackdropConfig | undefined,
  visibleBounds: Bounds,
  tileCache: Map<string, HTMLImageElement>,
  pending: Map<string, Promise<HTMLImageElement>>,
  requestRedraw: () => void
): void {
  const geoRef = network.geoReference;
  if (!geoRef) return;

  const backdrop = theme ?? network.backdrop ?? DEFAULT_BACKDROP;
  if (backdrop.type !== 'rasterTile') return;

  const tileSize = backdrop.tileSize ?? 256;
  const lat0 = geoRef.originLat;
  const cosLat = Math.max(0.2, Math.cos((lat0 * Math.PI) / 180));
  const desiredMetersPerPixel = 1 / view.scale;
  const metersPerPixelZoom0 = 156543.03392 * cosLat;
  const rawZoom = Math.log2(metersPerPixelZoom0 / desiredMetersPerPixel);
  const zoom = clamp(
    Math.round(rawZoom),
    backdrop.minZoom ?? 0,
    backdrop.maxZoom ?? 19
  );

  const worldToGeoFn = (pt: Vector2D) => worldToGeo(pt, geoRef);
  const minGeo = worldToGeoFn({ x: visibleBounds.minX, y: visibleBounds.minY });
  const maxGeo = worldToGeoFn({ x: visibleBounds.maxX, y: visibleBounds.maxY });
  const minLat = Math.min(minGeo.lat, maxGeo.lat);
  const maxLat = Math.max(minGeo.lat, maxGeo.lat);
  const minLon = Math.min(minGeo.lon, maxGeo.lon);
  const maxLon = Math.max(minGeo.lon, maxGeo.lon);

  const epsilon = 1e-9;
  const tileX0 = Math.floor(lonToTile(minLon - epsilon, zoom));
  const tileX1 = Math.floor(lonToTile(maxLon + epsilon, zoom));
  const tileY0 = Math.floor(latToTile(maxLat + epsilon, zoom));
  const tileY1 = Math.floor(latToTile(minLat - epsilon, zoom));
  const numTiles = 2 ** zoom;

  for (let x = tileX0; x <= tileX1; x++) {
    for (let y = tileY0; y <= tileY1; y++) {
      const wrappedX = ((x % numTiles) + numTiles) % numTiles;
      const tileUrl = (backdrop.tileUrl || DEFAULT_BACKDROP.tileUrl)
        .replace('{z}', String(zoom))
        .replace('{x}', String(wrappedX))
        .replace('{y}', String(y));
      const key = `${tileUrl}-${zoom}-${wrappedX}-${y}`;

      const lonLeft = tileToLon(x, zoom);
      const lonRight = tileToLon(x + 1, zoom);
      const latTop = tileToLat(y, zoom);
      const latBottom = tileToLat(y + 1, zoom);

      const worldSW = geoToWorld(latBottom, lonLeft, geoRef);
      const worldNE = geoToWorld(latTop, lonRight, geoRef);
      const tileBounds: Bounds = {
        minX: Math.min(worldSW.x, worldNE.x),
        maxX: Math.max(worldSW.x, worldNE.x),
        minY: Math.min(worldSW.y, worldNE.y),
        maxY: Math.max(worldSW.y, worldNE.y),
      };

      if (!boundsIntersect(tileBounds, visibleBounds)) continue;

      let img = tileCache.get(key);
      if (img && img.complete && img.naturalWidth > 0) {
        const pA = worldToScreen(view, worldSW);
        const pB = worldToScreen(view, worldNE);
        const minX = Math.min(pA.x, pB.x);
        const maxX = Math.max(pA.x, pB.x);
        const minY = Math.min(pA.y, pB.y);
        const maxY = Math.max(pA.y, pB.y);
        const width = maxX - minX;
        const height = maxY - minY;
        ctx.drawImage(img, minX, minY, width, height);
        continue;
      }

      if (!pending.has(key)) {
        const promise = new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image(tileSize, tileSize);
          image.crossOrigin = 'anonymous';
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = tileUrl;
        })
          .then(image => {
            tileCache.set(key, image);
            pending.delete(key);
            requestRedraw();
            return image;
          })
          .catch(err => {
            pending.delete(key);
            throw err;
          });
        pending.set(key, promise);
      }
    }
  }
}

function drawScene(
  canvas: HTMLCanvasElement,
  engine: TrafficSimulationEngine,
  view: ViewTransform,
  backdropContext?: BackdropContext,
  spawnPoints: string[] = [],
  network?: RoadNetworkImpl,
  selection?: Selection,
  highlightSpawnNodes: boolean = false,
  showRoadEdges: boolean = true,
  trafficLights: TrafficLight[] = []
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const visibleBounds = getViewBounds(view, canvas, 120);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0a0f1f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (backdropContext?.enabled) {
    drawBackdrop(
      ctx,
      canvas,
      view,
      backdropContext.network,
      backdropContext.theme,
      visibleBounds,
      backdropContext.tileCache,
      backdropContext.pendingTiles,
      backdropContext.requestRedraw
    );
  }

  const lodScale = view.scale;
  const hideRoads = lodScale < LOD_HIDE_ROADS;
  const fadeAlpha =
    lodScale <= LOD_FADE_START
      ? 0
      : clamp((lodScale - LOD_FADE_START) / (LOD_FULL - LOD_FADE_START), 0, 1);

  if (!hideRoads && showRoadEdges) {
    let laneIndex = 0;
    for (const lane of engine.network.lanes.values()) {
      const laneBounds = getLaneBounds(lane);
      if (!boundsIntersect(laneBounds, visibleBounds)) continue;
      ctx.save();
      ctx.globalAlpha = fadeAlpha < 1 ? fadeAlpha : 1;
      drawLane(ctx, view, lane, laneIndex++);
      ctx.restore();
    }
  }

  if (hideRoads) {
    drawHeatmap(ctx, view, engine.vehicles.values(), visibleBounds);
  }

  // Highlight valid spawn nodes when in placement mode
  if (highlightSpawnNodes && network) {
    const validNodes = getValidSpawnNodes(network);
    for (const nodeId of validNodes) {
      const node = network.getNode(nodeId);
      if (!node) continue;
      const nodeBounds = {
        minX: node.position.x - 20,
        maxX: node.position.x + 20,
        minY: node.position.y - 20,
        maxY: node.position.y + 20,
      };
      if (!boundsIntersect(nodeBounds, visibleBounds)) continue;
      
      const screen = worldToScreen(view, node.position);
      ctx.save();
      ctx.fillStyle = 'rgba(34, 211, 238, 0.3)'; // Cyan with transparency
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  if (network && spawnPoints.length > 0) {
    ctx.fillStyle = '#10b981';
    for (const id of spawnPoints) {
      const node = network.getNode(id);
      if (!node) continue;
      const screen = worldToScreen(view, node.position);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Traffic lights (only show when roads are shown)
  if (!hideRoads) {
    for (const tl of trafficLights) {
      const screen = worldToScreen(view, tl.position);
      ctx.save();
      ctx.translate(screen.x, screen.y);
      ctx.rotate(tl.heading);
      ctx.fillStyle = tl.state === 'green' ? '#22c55e' : '#ef4444';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(-6, -10, 12, 20);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  if (selection && network) {
    if (selection.type === 'edge') {
      const polyline = getEdgePolyline(network, selection.id);
      if (polyline && polyline.length > 1) {
        const pts = polyline.map(pt => worldToScreen(view, pt));
        ctx.save();
        ctx.strokeStyle = '#f97316';
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        ctx.restore();
        drawDirectionArrow(ctx, view, polyline, selection.direction);
      }
    } else if (selection.type === 'node') {
      const node = network.getNode(selection.id);
      if (node) {
        const screen = worldToScreen(view, node.position);
        ctx.save();
        ctx.strokeStyle = '#22d3ee';
        ctx.fillStyle = 'rgba(34,211,238,0.25)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        // Highlight connected edges
        for (const edge of network.edges.values()) {
          if (edge.fromNode !== node.id && edge.toNode !== node.id) continue;
          const polyline = getEdgePolyline(network, edge.id);
          if (!polyline || polyline.length < 2) continue;
          const pts = polyline.map(pt => worldToScreen(view, pt));
          ctx.save();
          ctx.strokeStyle = '#22d3ee';
          ctx.lineWidth = 5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.stroke();
          ctx.restore();
        }
      }
    }
  }

  for (const vehicle of engine.vehicles.values()) {
    if (hideRoads) continue;
    const vehicleBounds: Bounds = {
      minX: vehicle.position.x - 6,
      maxX: vehicle.position.x + 6,
      minY: vehicle.position.y - 6,
      maxY: vehicle.position.y + 6,
    };
    if (!boundsIntersect(vehicleBounds, visibleBounds)) continue;
    drawVehicle(ctx, view, vehicle);
  }
}

function overpassToNetworkJSON(
  osm: OSMResponse,
  geoRef: GeoReference,
  chunkKey: string
): NetworkJSON {
  const nodeMap = new Map<number, OSMNode>();
  for (const el of osm.elements) {
    if (el.type === 'node') {
      nodeMap.set(el.id, el as OSMNode);
    }
  }

  const nodes: NetworkJSON['nodes'] = [];
  const edges: NetworkJSON['edges'] = [];
  const intersections: NonNullable<NetworkJSON['intersections']> = [];
  const nodeUseCount: Record<number, number> = {};

  for (const el of osm.elements) {
    if (el.type !== 'way') continue;
    const way = el as OSMWay;
    const tags = (way as OSMWay).tags || {};
    if (!tags.highway) continue;

    way.nodes.forEach(id => {
      nodeUseCount[id] = (nodeUseCount[id] || 0) + 1;
    });

    const geometry = way.nodes
      .map(id => nodeMap.get(id))
      .filter((n): n is OSMNode => Boolean(n))
      .map(n => {
        const world = geoToWorld(n.lat, n.lon, geoRef);
        return { x: world.x, y: world.y };
      });

    if (geometry.length < 2) continue;

    const laneCount = Math.max(1, parseInt(tags.lanes ?? '1', 10));
    const speedLimit = parseMaxspeed(tags);
    const edgeId = `chunk_${chunkKey}_way_${way.id}`;

    edges.push({
      id: edgeId,
      from: `chunk_${chunkKey}_node_${way.nodes[0]}`,
      to: `chunk_${chunkKey}_node_${way.nodes[way.nodes.length - 1]}`,
      lanes: laneCount,
      geometry,
      speedLimit,
      roadType: tags.highway,
      properties: tags,
    });
  }

  for (const node of nodeMap.values()) {
    const pos = geoToWorld(node.lat, node.lon, geoRef);
    nodes.push({
      id: `chunk_${chunkKey}_node_${node.id}`,
      x: pos.x,
      y: pos.y,
      type: nodeUseCount[node.id] > 1 ? 'junction' : 'waypoint',
      properties: node.tags,
    });
  }

  Object.entries(nodeUseCount)
    .filter(([, count]) => count > 1)
    .forEach(([id]) => {
      intersections.push({
        nodeId: `chunk_${chunkKey}_node_${id}`,
        type: 'uncontrolled',
        signalPhases: [],
      });
    });

  return {
    version: '1.0',
    geoReference: geoRef,
    nodes,
    edges,
    intersections,
  };
}

function mergeNetworkFromJSON(target: RoadNetworkImpl, fragmentJSON: NetworkJSON): void {
  for (const nodeData of fragmentJSON.nodes) {
    if (!target.nodes.has(nodeData.id)) {
      target.addNode({
        id: nodeData.id,
        position: { x: nodeData.x, y: nodeData.y },
        type: nodeData.type as any,
        incomingEdges: [],
        outgoingEdges: [],
        metadata: nodeData.properties,
      });
    }
  }

  for (const edgeData of fragmentJSON.edges) {
    if (target.edges.has(edgeData.id)) continue;
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
    if (edge.geometry.length === 0) {
      const from = target.getNode(edge.fromNode);
      const to = target.getNode(edge.toNode);
      if (from && to) {
        edge.geometry = [from.position, to.position];
      }
    }
    target.addEdge(edge);
      if (edgeData.speedLimit) {
        for (const lane of edge.lanes) {
          lane.speedLimit = edgeData.speedLimit;
          (lane as any).metadata = { ...(lane as any).metadata, speed_limit: edgeData.speedLimit };
        }
      }
    }

  target.rebuildLaneConnectivity();
}

function updateTrafficLightTimers(
  lights: TrafficLight[],
  currentTime: number,
  setLights: (next: TrafficLight[]) => void,
  lightsRef: React.MutableRefObject<TrafficLight[]>
) {
  let changed = false;
  const nextLights = lights.map(tl => {
    if (tl.timerSeconds > 0 && currentTime >= tl.nextSwitchTime) {
      changed = true;
      const newState: TrafficLightState = tl.state === 'green' ? 'red' : 'green';
      return {
        ...tl,
        state: newState,
        nextSwitchTime: currentTime + tl.timerSeconds,
      };
    }
    return tl;
  });
  if (changed) {
    lightsRef.current = nextLights;
    setLights(nextLights);
  }
}

function enforceTrafficLights(engine: TrafficSimulationEngine, lights: TrafficLight[]) {
  for (const vehicle of engine.vehicles.values()) {
    if (!vehicle.laneId) continue;
    const redAhead = lights.find(
      tl =>
        tl.state === 'red' &&
        tl.laneId === vehicle.laneId &&
        tl.lanePosition > vehicle.lanePosition &&
        tl.lanePosition - vehicle.lanePosition < 20
    );
    if (redAhead) {
      vehicle.velocity = 0;
      vehicle.acceleration = 0;
      vehicle.lanePosition = Math.min(vehicle.lanePosition, redAhead.lanePosition - 3);
    }
  }
}

function findNearestLaneAt(
  network: RoadNetworkImpl,
  world: Vector2D,
  maxDist = 40
): { lane: Lane; s: number; heading: number } | null {
  let best: { lane: Lane; s: number; heading: number; distSq: number } | null = null;

  for (const lane of network.lanes.values()) {
    if (lane.laneType !== 'driving' || lane.centerline.length < 2) continue;
    let accumulated = 0;
    for (let i = 0; i < lane.centerline.length - 1; i++) {
      const p0 = lane.centerline[i];
      const p1 = lane.centerline[i + 1];
      const segLen = distance(p0, p1);
      if (segLen < 1e-6) continue;

      const t =
        ((world.x - p0.x) * (p1.x - p0.x) + (world.y - p0.y) * (p1.y - p0.y)) /
        (segLen * segLen);
      const clamped = Math.max(0, Math.min(1, t));
      const proj = { x: p0.x + (p1.x - p0.x) * clamped, y: p0.y + (p1.y - p0.y) * clamped };
      const dx = world.x - proj.x;
      const dy = world.y - proj.y;
      const distSq = dx * dx + dy * dy;
      const s = accumulated + clamped * segLen;
      if (!best || distSq < best.distSq) {
        const heading = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        best = { lane, s, heading, distSq };
      }
      accumulated += segLen;
    }
  }

  if (best && best.distSq <= maxDist * maxDist) {
    return { lane: best.lane, s: best.s, heading: best.heading };
  }
  return null;
}

function extractTrafficLightsFromOSM(
  osm: OSMResponse,
  geoRef: GeoReference,
  network: RoadNetworkImpl,
  chunkKey: string
): TrafficLight[] {
  const lights: TrafficLight[] = [];
  for (const el of osm.elements) {
    if (el.type !== 'node') continue;
    const n = el as OSMNode;
    if (n.tags?.highway !== 'traffic_signals') continue;
    const world = geoToWorld(n.lat, n.lon, geoRef);
    const snapped = findNearestLaneAt(network, world, 40);
    if (!snapped) continue;
    lights.push({
      id: `tl_${chunkKey}_${n.id}`,
      position: projectAlongLane(snapped.lane, snapped.s).position,
      heading: snapped.heading,
      laneId: snapped.lane.id,
      lanePosition: snapped.s,
      state: 'green',
      timerSeconds: 0,
      nextSwitchTime: Infinity,
    });
  }
  return lights;
}

async function fetchChunkAndMerge(
  chunkKey: string,
  cx: number,
  cy: number,
  runtime: { network: RoadNetworkImpl; engine: TrafficSimulationEngine },
  chunkCache: Set<string>,
  pendingChunks: Set<string>,
  onRedraw: () => void,
  addTrafficLights?: (lights: TrafficLight[]) => void
) {
  const geoRef = runtime.network.geoReference;
  if (!geoRef) return;

  const padding = 50;
  const worldMin = { x: cx * CHUNK_WORLD_SIZE - padding, y: cy * CHUNK_WORLD_SIZE - padding };
  const worldMax = {
    x: (cx + 1) * CHUNK_WORLD_SIZE + padding,
    y: (cy + 1) * CHUNK_WORLD_SIZE + padding,
  };
  const geo1 = worldToGeo(worldMin, geoRef);
  const geo2 = worldToGeo(worldMax, geoRef);
  const south = Math.min(geo1.lat, geo2.lat);
  const north = Math.max(geo1.lat, geo2.lat);
  const west = Math.min(geo1.lon, geo2.lon);
  const east = Math.max(geo1.lon, geo2.lon);

  const query = `[out:json][timeout:25];
  (
    way["highway"](${south},${west},${north},${east});
    node["highway"="traffic_signals"](${south},${west},${north},${east});
    >;
  );
  out;`;

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: query,
      headers: { 'Content-Type': 'text/plain' },
    });
    if (!res.ok) {
      throw new Error(`Overpass error ${res.status}`);
    }
    const data = (await res.json()) as OSMResponse;
    const fragmentJSON = overpassToNetworkJSON(data, geoRef, chunkKey);
    mergeNetworkFromJSON(runtime.network, fragmentJSON);
    runtime.engine.network = runtime.network;
    if (addTrafficLights) {
      const extracted = extractTrafficLightsFromOSM(data, geoRef, runtime.network, chunkKey);
      if (extracted.length > 0) addTrafficLights(extracted);
    }
    chunkCache.add(chunkKey);
    onRedraw();
  } catch (err) {
    console.error('Chunk fetch failed', err);
  } finally {
    pendingChunks.delete(chunkKey);
  }
}


export default function TrafficSimulationApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const runtimeRef = useRef<{
    engine: TrafficSimulationEngine;
    network: RoadNetworkImpl;
  } | null>(null);
  const hasInitializedRef = useRef(false);
  const lastInitSeedRef = useRef(false); // keep map empty by default
  const viewRef = useRef<ViewTransform | null>(null);
  const rafRef = useRef<number>();
  const lastFrameRef = useRef<number>(0);
  const hudAccumulatorRef = useRef<number>(0);
  const frameCountRef = useRef<number>(0);
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(
    null
  );
  const tileCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const pendingTileRef = useRef<Map<string, Promise<HTMLImageElement>>>(new Map());
  const backdropContextRef = useRef<BackdropContext | null>(null);
  const spawnPointsRef = useRef<string[]>([]);
  const dynamicChunksRef = useRef<Set<string>>(new Set());
  const chunkCacheRef = useRef<Set<string>>(new Set());
  const pendingChunkFetchRef = useRef<Set<string>>(new Set());
  const baseNetworkJSONRef = useRef<NetworkJSON | null>(null);
  const dynamicActiveRef = useRef(false);
  const [showBackdrop, setShowBackdrop] = useState(true);
  const [backdropTheme, setBackdropTheme] = useState<keyof typeof BACKDROP_THEMES>('osm');
  const [zoomLevel, setZoomLevel] = useState(1);
  const [bulkCount, setBulkCount] = useState(10);
  const [inputMode, setInputMode] = useState<'mouse' | 'trackpad'>('trackpad');
  const requestRedrawRef = useRef<{ fn: () => void }>({ fn: () => {} });
  const redrawRafIdRef = useRef<number | undefined>(undefined);

  const [scenario, setScenario] = useState<ScenarioKey>('simple_highway');
  const [isRunning, setIsRunning] = useState(true);
  const [timeScale, setTimeScale] = useState(1);
  const [hud, setHud] = useState<HudState>({
    time: 0,
    vehicles: 0,
    avgSpeed: 0,
    fps: 0,
  });
  const statModes: StatMode[] = ['basic', 'extended', 'advanced'];
  const [statModeIndex, setStatModeIndex] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [showHud, setShowHud] = useState(true);
  const [showRoadEdges, setShowRoadEdges] = useState(true);
  const [spawnPoints, setSpawnPoints] = useState<string[]>([]);
  const [spawnPointPlacementMode, setSpawnPointPlacementMode] = useState(false);
  const [obstaclePlacementMode, setObstaclePlacementMode] = useState(false);
  const [obstacleRemovalMode, setObstacleRemovalMode] = useState(false);
  const [speedSignPlacementMode, setSpeedSignPlacementMode] = useState<SpeedLimitValue | null>(null);
  const [trafficLightPlacementMode, setTrafficLightPlacementMode] = useState(false);
  const [trafficLightTimer, setTrafficLightTimer] = useState(0);
  const [trafficLights, setTrafficLights] = useState<TrafficLight[]>([]);
  const trafficLightsRef = useRef<TrafficLight[]>([]);
  const vehicleTargetRef = useRef<number>(VEHICLE_TARGETS.off);
  const [vehicleTarget, setVehicleTarget] = useState<number>(VEHICLE_TARGETS.off);
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  const [streetQuery, setStreetQuery] = useState('');
  const [streetSuggestions, setStreetSuggestions] = useState<string[]>([]);
  const selectionRef = useRef<Selection | undefined>(undefined);
  const isRunningRef = useRef(true);
  const lastSuggestionUpdateRef = useRef(0);
  const swipeStartRef = useRef<number | null>(null);
  const pendingIndexRef = useRef<Promise<any> | null>(null);
  const applySelection = useCallback((sel?: Selection) => {
    selectionRef.current = sel;
    setSelection(sel);
    const runtime = runtimeRef.current;
    const canvas = canvasRef.current;
    const view = viewRef.current;
    if (runtime && canvas && view) {
      drawScene(
        canvas,
        runtime.engine,
        view,
        backdropContextRef.current || undefined,
        spawnPointsRef.current,
        runtime.network,
        selectionRef.current,
        spawnPointPlacementMode,
        showRoadEdges,
        trafficLightsRef.current
      );
    }
  }, [spawnPointPlacementMode, showRoadEdges]);

  const updateStreetSuggestions = useCallback(() => {
    const runtime = runtimeRef.current;
    const canvas = canvasRef.current;
    const view = viewRef.current;
    if (!runtime || !canvas || !view) return;
    const now = performance.now();
    if (now - lastSuggestionUpdateRef.current < 150) return;
    lastSuggestionUpdateRef.current = now;

    const bounds = getViewBounds(view, canvas, 0);
    const names = new Set<string>();
    for (const edge of runtime.network.edges.values()) {
      const name =
        edge.name ||
        (edge.metadata as any)?.name ||
        (edge.metadata as any)?.ref ||
        (edge as any)?.properties?.name;
      if (!name) continue;
      const polyline = getEdgePolyline(runtime.network, edge.id);
      if (!polyline) continue;
      if (!boundsIntersect(polylineBounds(polyline), bounds)) continue;
      names.add(String(name));
    }
    setStreetSuggestions(Array.from(names).sort());
  }, []);


  useEffect(() => {
    if (backdropContextRef.current) {
      backdropContextRef.current.enabled = showBackdrop;
    }
  }, [showBackdrop]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        applySelection(undefined);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [applySelection]);
  const updateDynamicChunks = useCallback(
    (view: ViewTransform) => {
      const canvas = canvasRef.current;
      const runtime = runtimeRef.current;
      if (!canvas || !runtime?.network.geoReference) return;

      const centerWorld = {
        x: (canvas.width / 2 - view.offsetX) / view.scale,
        y: (canvas.height / 2 - view.offsetY) / view.scale,
      };
      const cx = Math.floor(centerWorld.x / CHUNK_WORLD_SIZE);
      const cy = Math.floor(centerWorld.y / CHUNK_WORLD_SIZE);
      const key = `${cx}:${cy}`;
      if (!dynamicChunksRef.current.has(key)) {
        dynamicChunksRef.current.add(key);
        if (!dynamicActiveRef.current) {
          baseNetworkJSONRef.current = runtime.network.toJSON();
          dynamicActiveRef.current = true;
        }
        if (!chunkCacheRef.current.has(key) && !pendingChunkFetchRef.current.has(key)) {
          pendingChunkFetchRef.current.add(key);
          fetchChunkAndMerge(
            key,
            cx,
            cy,
            runtime,
            chunkCacheRef.current,
            pendingChunkFetchRef.current,
            requestRedrawRef.current.fn,
            newLights => {
              if (newLights.length === 0) return;
              setTrafficLights(prev => {
                const existing = new Set(prev.map(tl => tl.id));
                const merged = [...prev];
                for (const tl of newLights) {
                  if (!existing.has(tl.id)) {
                    merged.push(tl);
                    existing.add(tl.id);
                  }
                }
                trafficLightsRef.current = merged;
                return merged;
              });
            }
          );
        }
        // Placeholder for future fetch/merge of road data for this chunk.
      }
    },
    [scenario, showBackdrop]
  );

  const requestRedraw = useCallback(() => {
    // Use requestAnimationFrame to break potential infinite loops
    // Cancel any pending redraw to avoid stacking
    if (redrawRafIdRef.current !== undefined) {
      cancelAnimationFrame(redrawRafIdRef.current);
    }
    
    redrawRafIdRef.current = requestAnimationFrame(() => {
      redrawRafIdRef.current = undefined;
      const runtime = runtimeRef.current;
      const canvas = canvasRef.current;
      const view = viewRef.current;
      const backdropCtx = backdropContextRef.current || undefined;
      if (runtime && canvas && view) {
        drawScene(
          canvas,
          runtime.engine,
          view,
          backdropCtx,
          spawnPointsRef.current,
          runtime.network,
          selectionRef.current,
          spawnPointPlacementMode,
          showRoadEdges
        );
        updateStreetSuggestions();
        updateDynamicChunks(view);
      }
    });
  }, [spawnPointPlacementMode, showRoadEdges, updateStreetSuggestions, updateDynamicChunks]);

  // Keep the ref in sync immediately after requestRedraw is defined
  requestRedrawRef.current.fn = requestRedraw;

  useEffect(() => {
    if (backdropContextRef.current) {
      backdropContextRef.current.theme = BACKDROP_THEMES[backdropTheme] || DEFAULT_BACKDROP;
    }
    // flush caches so old tiles aren't reused across themes
    tileCacheRef.current.clear();
    pendingTileRef.current.clear();
    requestRedraw();
  }, [backdropTheme, requestRedraw]);

  useEffect(() => {
    trafficLightsRef.current = trafficLights;
  }, [trafficLights]);

  useEffect(() => {
    requestRedraw();
  }, [showBackdrop, requestRedraw]);

  useEffect(() => {
    vehicleTargetRef.current = vehicleTarget;
  }, [vehicleTarget]);

  const applyZoom = useCallback(
    (newScale: number, anchor?: { x: number; y: number }) => {
      const canvas = canvasRef.current;
      const view = viewRef.current;
      if (!canvas || !view) return;
      const clamped = clamp(newScale, MIN_ZOOM_SLIDER, MAX_ZOOM_SLIDER);
      const anchorPoint = anchor ?? { x: canvas.width / 2, y: canvas.height / 2 };
      const worldBefore = {
        x: (anchorPoint.x - view.offsetX) / view.scale,
        y: (anchorPoint.y - view.offsetY) / view.scale,
      };
      viewRef.current = {
        scale: clamped,
        offsetX: anchorPoint.x - worldBefore.x * clamped,
        offsetY: anchorPoint.y - worldBefore.y * clamped,
      };
      setZoomLevel(clamped);
      const runtime = runtimeRef.current;
      if (runtime && canvas) {
        drawScene(
          canvas,
          runtime.engine,
          viewRef.current,
          backdropContextRef.current || undefined,
          spawnPointsRef.current,
          runtime.network,
          selectionRef.current,
          spawnPointPlacementMode,
          showRoadEdges,
          trafficLightsRef.current
        );
        updateStreetSuggestions();
        updateDynamicChunks(viewRef.current);
      }
    },
    [updateStreetSuggestions, updateDynamicChunks]
  );

  const initialize = (options?: { seedVehicles?: boolean }) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setSpawnPointPlacementMode(false);
    setObstaclePlacementMode(false);
    setObstacleRemovalMode(false);
    setTrafficLightPlacementMode(false);
    setSpawnPoints([]);
    spawnPointsRef.current = [];
    setTrafficLights([]);
    trafficLightsRef.current = [];
    vehicleTargetRef.current = vehicleTarget;

    const shouldSeedVehicles = options?.seedVehicles ?? lastInitSeedRef.current;

    tileCacheRef.current.clear();
    pendingTileRef.current.clear();
    chunkCacheRef.current.clear();
    pendingChunkFetchRef.current.clear();
    dynamicChunksRef.current.clear();
    dynamicActiveRef.current = false;
    baseNetworkJSONRef.current = null;

    const networkJSON = networks[scenario];

    if (appConfig.optimizations.chunkedIndex) {
      const urlMap: Partial<Record<ScenarioKey, string>> = {
        heilbronn_perchance: '/heilbronnperchance.json',
        test_perchance: '/testperchance.json',
      };
      const url = urlMap[scenario];
      if (url && !pendingIndexRef.current) {
        pendingIndexRef.current = fastIndexLoad(url).catch(err =>
          console.warn('Chunked index load failed', err)
        );
      }
    }
    const network = RoadNetworkImpl.fromJSON(networkJSON);
    const simConfig: SimulationConfig = {
      timeStep: 1 / 60,
      targetFPS: 60,
      maxVehicles: 600,
      enableCollisionDetection: false,
      spatialIndexType: 'quadtree',
    };

    const engine = new TrafficSimulationEngine(network, simConfig);
    Object.entries(DEFAULT_VEHICLE_TYPES).forEach(([key, typeConfig]) => {
      engine.registerDriverModel(key as VehicleCategory, new IDMModel(typeConfig.driver));
    });
    engine.setLaneChangeModel(new MOBILModel());
    runtimeRef.current = { engine, network };
    backdropContextRef.current = {
      network,
      tileCache: tileCacheRef.current,
      pendingTiles: pendingTileRef.current,
      requestRedraw,
      enabled: showBackdrop,
      theme: BACKDROP_THEMES[backdropTheme] || DEFAULT_BACKDROP,
    };
    viewRef.current = computeView(network, canvas);
    lastFrameRef.current = performance.now();
    hudAccumulatorRef.current = 0;
    frameCountRef.current = 0;
    lastInitSeedRef.current = shouldSeedVehicles;
    drawScene(
      canvas,
      engine,
      viewRef.current,
      backdropContextRef.current || undefined,
      spawnPointsRef.current,
      network,
      selectionRef.current,
      spawnPointPlacementMode,
      showRoadEdges,
      trafficLightsRef.current
    );
    updateStreetSuggestions();
    updateDynamicChunks(viewRef.current);
    setHud({
      time: 0,
      vehicles: engine.vehicles.size,
      avgSpeed: 0,
      fps: 0,
    });

    if (shouldSeedVehicles) {
      setTimeout(() => {
        seedVehicles(engine, scenario);
        drawScene(
          canvas,
          engine,
          viewRef.current as ViewTransform,
          backdropContextRef.current || undefined,
          spawnPointsRef.current,
          network,
          selectionRef.current,
          spawnPointPlacementMode,
          showRoadEdges,
          trafficLightsRef.current
        );
        updateStreetSuggestions();
        updateDynamicChunks(viewRef.current as ViewTransform);
        setHud(h => ({ ...h, vehicles: engine.vehicles.size }));
      }, 0);
    }
  };

  const attachCanvasRef = useCallback((node: HTMLCanvasElement | null) => {
    canvasRef.current = node;
    if (node) {
      setCanvasReady(true);
    }
  }, []);

  const fitViewToBounds = useCallback(
    (bounds: Bounds) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const padding = 60;
      const width = Math.max(1, bounds.maxX - bounds.minX);
      const height = Math.max(1, bounds.maxY - bounds.minY);
      const scale = clamp(
        Math.min(
          canvas.width / (width * 1.1 + padding),
          canvas.height / (height * 1.1 + padding)
        ),
        MIN_ZOOM_SLIDER,
        MAX_ZOOM_SLIDER
      );
      const center = {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
      };
      viewRef.current = {
        scale,
        offsetX: canvas.width / 2 - center.x * scale,
        offsetY: canvas.height / 2 - center.y * scale,
      };
      setZoomLevel(scale);
    },
    []
  );

  const searchStreetInView = useCallback(() => {
    const runtime = runtimeRef.current;
    const canvas = canvasRef.current;
    const view = viewRef.current;
    if (!runtime || !canvas || !view) return;
    const query = streetQuery.trim().toLowerCase();
    if (!query) return;

    const visible = getViewBounds(view, canvas, 0);
    let match: { edgeId: string; dir: 'forward' | 'backward'; bounds: Bounds } | undefined;

    for (const edge of runtime.network.edges.values()) {
      const name =
        edge.name ||
        (edge.metadata as any)?.name ||
        (edge.metadata as any)?.ref ||
        (edge as any)?.properties?.name;
      if (!name || !String(name).toLowerCase().includes(query)) continue;
      const polyline = getEdgePolyline(runtime.network, edge.id);
      if (!polyline) continue;
      const pb = polylineBounds(polyline);
      if (!boundsIntersect(pb, visible)) continue;
      match = { edgeId: edge.id, dir: computeEdgeDirection(edge), bounds: pb };
      break;
    }

    if (match) {
      fitViewToBounds(match.bounds);
      applySelection({ type: 'edge', id: match.edgeId, direction: match.dir });
    }
  }, [streetQuery, applySelection, fitViewToBounds]);

  useEffect(() => {
    if (!canvasReady) return;
    const shouldSeed = false;
    initialize({ seedVehicles: shouldSeed });
    hasInitializedRef.current = true;
    if (viewRef.current) setZoomLevel(viewRef.current.scale);
  }, [canvasReady, scenario]);

  useEffect(() => {
    spawnPointsRef.current = spawnPoints;
    const runtime = runtimeRef.current;
    const canvas = canvasRef.current;
    const view = viewRef.current;
    if (runtime && canvas && view) {
      drawScene(
        canvas,
        runtime.engine,
        view,
        backdropContextRef.current || undefined,
        spawnPointsRef.current,
        runtime.network,
        selectionRef.current,
        spawnPointPlacementMode,
        showRoadEdges,
        trafficLightsRef.current
      );
      updateDynamicChunks(view);
    }
  }, [spawnPoints, spawnPointPlacementMode, showRoadEdges]);

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
        drawScene(
          canvas,
          runtime.engine,
          viewRef.current,
          backdropContextRef.current || undefined,
          spawnPointsRef.current,
          runtime.network,
          selectionRef.current,
          spawnPointPlacementMode,
          showRoadEdges
        );
        setZoomLevel(viewRef.current.scale);
        updateDynamicChunks(viewRef.current);
      }
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    isRunningRef.current = isRunning;
    if (!isRunning) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    const tick = (timestamp: number) => {
      if (!isRunningRef.current) return;

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
      updateTrafficLightTimers(
        trafficLightsRef.current,
        runtime.engine.currentTime,
        setTrafficLights,
        trafficLightsRef
      );
      enforceTrafficLights(runtime.engine, trafficLightsRef.current);
      drawScene(
        canvas,
        runtime.engine,
        view,
        backdropContextRef.current || undefined,
        spawnPointsRef.current,
        runtime.network,
        selectionRef.current,
        spawnPointPlacementMode,
        showRoadEdges,
        trafficLightsRef.current
      );

      hudAccumulatorRef.current += delta;
      frameCountRef.current += 1;
      if (hudAccumulatorRef.current >= 0.25) {
        const vehicles = Array.from(runtime.engine.vehicles.values());
        const avgSpeed =
          vehicles.length > 0
            ? vehicles.reduce((sum, v) => sum + v.velocity, 0) / vehicles.length
            : 0;
        const fps =
          hudAccumulatorRef.current > 0
            ? frameCountRef.current / hudAccumulatorRef.current
            : 0;

        setHud({
          time: runtime.engine.currentTime,
          vehicles: vehicles.length,
          avgSpeed,
          fps,
        });

        hudAccumulatorRef.current = 0;
        frameCountRef.current = 0;
      }

      // Passive population controller: top up to target if below
      const target = vehicleTargetRef.current;
      const deficit = Math.max(0, target - runtime.engine.vehicles.size);
      if (deficit > 0) {
        const attempts = Math.min(deficit, 8);
        for (let i = 0; i < attempts; i++) {
          spawnVehicle();
        }
      }

      if (!isRunningRef.current) return;
      rafRef.current = requestAnimationFrame(tick);
    };

    lastFrameRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      isRunningRef.current = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isRunning, timeScale, spawnPointPlacementMode, showRoadEdges]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (event: WheelEvent) => {
      const runtime = runtimeRef.current;
      const view = viewRef.current;
      if (!runtime || !view) return;
      event.preventDefault();

      const absDeltaY = Math.abs(event.deltaY);
      const absDeltaX = Math.abs(event.deltaX);
      const isTrackpadLike =
        event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && absDeltaX < 50 && absDeltaY < 50;
      const wantsZoom =
        event.ctrlKey ||
        event.metaKey ||
        inputMode === 'trackpad' ||
        (!isTrackpadLike && absDeltaY > absDeltaX);

      const zoomStep = inputMode === 'trackpad' ? 0.0025 : 0.001;
      const panScale = inputMode === 'trackpad' ? 1.8 : 1;

      if (wantsZoom) {
        const rect = canvas.getBoundingClientRect();
        const cursor = {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        };
        const worldBefore = {
          x: (cursor.x - view.offsetX) / view.scale,
          y: (cursor.y - view.offsetY) / view.scale,
        };

        const zoomFactor = Math.exp(-event.deltaY * zoomStep);
        const newScale = clamp(view.scale * zoomFactor, MIN_ZOOM_SLIDER, MAX_ZOOM_SLIDER);

        viewRef.current = {
          scale: newScale,
          offsetX: cursor.x - worldBefore.x * newScale,
          offsetY: cursor.y - worldBefore.y * newScale,
        };
        setZoomLevel(newScale);
      } else {
        viewRef.current = {
          ...view,
          offsetX: view.offsetX - event.deltaX * panScale,
          offsetY: view.offsetY - event.deltaY * panScale,
        };
      }

      drawScene(
        canvas,
        runtime.engine,
        viewRef.current,
        backdropContextRef.current || undefined,
        spawnPointsRef.current,
        runtime.network,
        selectionRef.current,
        spawnPointPlacementMode,
        showRoadEdges,
        trafficLightsRef.current
      );
      updateStreetSuggestions();
      updateDynamicChunks(viewRef.current);
      setZoomLevel(viewRef.current.scale);
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [canvasReady, inputMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.cursor = 'grab';

    const beginPan = (event: PointerEvent) => {
      if (
        spawnPointPlacementMode ||
        obstaclePlacementMode ||
        obstacleRemovalMode ||
        trafficLightPlacementMode
      )
        return;
      if (event.button !== 0 && event.button !== 1) return;
      const view = viewRef.current;
      if (!view) return;
      isPanningRef.current = true;
      panStartRef.current = {
        x: event.clientX,
        y: event.clientY,
        offsetX: view.offsetX,
        offsetY: view.offsetY,
      };
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = 'grabbing';
    };

    const movePan = (event: PointerEvent) => {
      if (!isPanningRef.current) return;
      const start = panStartRef.current;
      const view = viewRef.current;
      const runtime = runtimeRef.current;
      const canvasEl = canvasRef.current;
      if (!start || !view || !runtime || !canvasEl) return;

      viewRef.current = {
        ...view,
        offsetX: start.offsetX + (event.clientX - start.x),
        offsetY: start.offsetY + (event.clientY - start.y),
      };
      drawScene(
        canvasEl,
        runtime.engine,
        viewRef.current,
        backdropContextRef.current || undefined,
        spawnPointsRef.current,
        runtime.network,
        selectionRef.current,
        spawnPointPlacementMode,
        showRoadEdges,
        trafficLightsRef.current
      );
      updateStreetSuggestions();
      updateDynamicChunks(viewRef.current);
    };

    const endPan = (event: PointerEvent) => {
      if (!isPanningRef.current) return;
      isPanningRef.current = false;
      panStartRef.current = null;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      canvas.style.cursor = 'grab';
    };

    canvas.addEventListener('pointerdown', beginPan);
    canvas.addEventListener('pointermove', movePan);
    canvas.addEventListener('pointerup', endPan);
    canvas.addEventListener('pointerleave', endPan);
    canvas.addEventListener('pointercancel', endPan);

    return () => {
      canvas.style.cursor = 'default';
      canvas.removeEventListener('pointerdown', beginPan);
      canvas.removeEventListener('pointermove', movePan);
      canvas.removeEventListener('pointerup', endPan);
      canvas.removeEventListener('pointerleave', endPan);
      canvas.removeEventListener('pointercancel', endPan);
    };
  }, [canvasReady, spawnPointPlacementMode, obstaclePlacementMode, obstacleRemovalMode, trafficLightPlacementMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleClick = (event: MouseEvent) => {
      const runtime = runtimeRef.current;
      const view = viewRef.current;
      if (!runtime || !view) {
        setSpawnPointPlacementMode(false);
        setObstaclePlacementMode(false);
        setObstacleRemovalMode(false);
        setTrafficLightPlacementMode(false);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      if (trafficLightPlacementMode) {
        const laneHit = findClosestLaneAndPosition(view, runtime.network, { x, y });
        setSpawnPointPlacementMode(false);
        if (!laneHit) {
          setTrafficLightPlacementMode(false);
          console.warn('No lane found near click for traffic light');
          return;
        }
        const proj = projectAlongLane(laneHit.lane, laneHit.s);
        const tl: TrafficLight = {
          id: `tl_${Date.now()}`,
          position: proj.position,
          heading: proj.heading,
          laneId: laneHit.lane.id,
          lanePosition: laneHit.s,
          state: 'green',
          timerSeconds: trafficLightTimer,
          nextSwitchTime:
            trafficLightTimer > 0 && runtime.engine ? runtime.engine.currentTime + trafficLightTimer : Infinity,
        };
        setTrafficLights(prev => {
          const next = [...prev, tl];
          trafficLightsRef.current = next;
          return next;
        });
        setTrafficLightPlacementMode(false);
        requestRedrawRef.current.fn();
        return;
      }

      if (obstaclePlacementMode || obstacleRemovalMode) {
        const laneHit = findClosestLaneAndPosition(view, runtime.network, { x, y });
        setSpawnPointPlacementMode(false);
        if (!laneHit) {
          setObstaclePlacementMode(false);
          setObstacleRemovalMode(false);
          console.warn('No lane found near click for obstacle action');
          return;
        }

        if (obstaclePlacementMode) {
          addObstacleToLane(runtime.engine, laneHit.lane, laneHit.s);
          setObstaclePlacementMode(false);
          setObstacleRemovalMode(false);
          requestRedrawRef.current.fn();
          return;
        }

        if (obstacleRemovalMode) {
          // First try to remove a nearby traffic light
          const viewLocal = viewRef.current;
          if (viewLocal && trafficLightsRef.current.length > 0) {
            const hitLightIndex = trafficLightsRef.current.findIndex(tl => {
              const screenTL = worldToScreen(viewLocal, tl.position);
              const dx = screenTL.x - x;
              const dy = screenTL.y - y;
              return dx * dx + dy * dy < 14 * 14;
            });
            if (hitLightIndex >= 0) {
              const next = trafficLightsRef.current.slice();
              next.splice(hitLightIndex, 1);
              trafficLightsRef.current = next;
              setTrafficLights(next);
              setObstacleRemovalMode(false);
              requestRedrawRef.current.fn();
              return;
            }
          }

          const removed = removeObstacleAt(runtime.engine, laneHit.lane, laneHit.s);
          setObstacleRemovalMode(false);
          requestRedrawRef.current.fn();
          if (!removed) {
            console.warn('No obstacle found to remove near click');
          }
          return;
        }
      }

      // Toggle traffic light if clicked
      const clickedLight = (() => {
        const viewLocal = viewRef.current;
        if (!viewLocal) return undefined;
        let nearest: TrafficLight | undefined;
        let bestDist = Infinity;
        for (const tl of trafficLightsRef.current) {
          const screen = worldToScreen(viewLocal, tl.position);
          const dx = screen.x - x;
          const dy = screen.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestDist && d2 < 12 * 12) {
            bestDist = d2;
            nearest = tl;
          }
        }
        return nearest;
      })();

      if (clickedLight && runtime) {
        setTrafficLights(prev => {
          const next: TrafficLight[] = prev.map(tl =>
            tl.id === clickedLight.id
              ? {
                  ...tl,
                  state: (tl.state === 'green' ? 'red' : 'green') as TrafficLightState,
                  nextSwitchTime:
                    tl.timerSeconds > 0 ? runtime.engine.currentTime + tl.timerSeconds : Infinity,
                }
              : tl
          );
          trafficLightsRef.current = next;
          return next;
        });
        requestRedrawRef.current.fn();
        return;
      }

      if (spawnPointPlacementMode) {
        // Only allow nodes with outgoing edges
        const closest = findClosestNode(view, x, y, runtime.network, true);
        setSpawnPointPlacementMode(false);
        if (!closest) {
          // Show feedback that node is invalid
          console.log('⚠️ Cannot place spawn point: node has no outgoing edges');
          return;
        }
        setSpawnPoints(prev => {
          if (prev.includes(closest)) return prev;
          const next = [...prev, closest];
          spawnPointsRef.current = next;
          return next;
        });
        applySelection(undefined);
        return;
      }

      const nodeHit = pickClosestNode(view, runtime.network, { x, y });
      if (nodeHit) {
        applySelection({ type: 'node', id: nodeHit.id });
        return;
      }

      const edgeHit = pickClosestEdge(view, runtime.network, { x, y });
      if (edgeHit) {
        applySelection({ type: 'edge', id: edgeHit.id, direction: edgeHit.direction });
        return;
      }

      applySelection(undefined);
    };

    canvas.addEventListener('click', handleClick);
    return () => {
      canvas.removeEventListener('click', handleClick);
    };
  }, [spawnPointPlacementMode, obstaclePlacementMode, obstacleRemovalMode, trafficLightPlacementMode, applySelection]);

  const spawnVehicle = () => {
    const runtime = runtimeRef.current;
    const canvas = canvasRef.current;
    const view = viewRef.current;
    if (!runtime || !canvas || !view) return;

    // Get visible bounds to filter spawn points
    const visibleBounds = getViewBounds(view, canvas, 0);

    const pickLaneFromNode = (nodeId: string): Lane | undefined => {
      const candidateLanes: Lane[] = [];
      for (const edge of runtime.network.edges.values()) {
        if (edge.fromNode === nodeId) {
          candidateLanes.push(...edge.lanes);
        }
      }
      if (candidateLanes.length === 0) {
        for (const edge of runtime.network.edges.values()) {
          if (edge.toNode === nodeId) {
            candidateLanes.push(...edge.lanes);
          }
        }
      }
      const driving = candidateLanes.filter(l => l.laneType === 'driving');
      if (driving.length === 0) return undefined;
      return driving.sort(
        (a, b) =>
          runtime.engine.getVehiclesInLane(a.id).length -
          runtime.engine.getVehiclesInLane(b.id).length
      )[0];
    };

    const trySpawnInLane = (lane: Lane): boolean => {
      const laneVehicles = runtime.engine.getVehiclesInLane(lane.id);
      const pos = Math.min(
        lane.length - 5,
        Math.max(1, 5 + Math.random() * Math.min(20, lane.length * 0.4))
      );
      const hasSpace = laneVehicles.every(v => Math.abs(v.lanePosition - pos) > 6);
      if (!hasSpace) return false;
      const vehicle = createVehicleState(lane, pos);
      runtime.engine.addVehicle(vehicle);
      return true;
    };

    if (spawnPointsRef.current.length > 0) {
      // Filter spawn points to only those in visible area
      const visibleSpawnPoints = spawnPointsRef.current.filter(nodeId => {
        const node = runtime.network.getNode(nodeId);
        if (!node) return false;
        return (
          node.position.x >= visibleBounds.minX &&
          node.position.x <= visibleBounds.maxX &&
          node.position.y >= visibleBounds.minY &&
          node.position.y <= visibleBounds.maxY
        );
      });
      
      if (visibleSpawnPoints.length > 0) {
        const choice = visibleSpawnPoints[Math.floor(Math.random() * visibleSpawnPoints.length)];
        const lane = pickLaneFromNode(choice);
        if (lane && trySpawnInLane(lane)) {
          return;
        }
      }
      // If no visible spawn points, fall through to default behavior
    }

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

    trySpawnInLane(bestLane);
  };

  const runtimeForSelection = runtimeRef.current;
  const selectedNode =
    selection?.type === 'node' ? runtimeForSelection?.network.getNode(selection.id) : undefined;
  const selectedEdge =
    selection?.type === 'edge' ? runtimeForSelection?.network.getEdge(selection.id) : undefined;
  const selectedStats =
    selection?.type === 'edge' && runtimeForSelection
      ? computeEdgeStats(runtimeForSelection.network, selection.id)
      : undefined;
  const selectedJSON = selection
    ? JSON.stringify(selection.type === 'node' ? selectedNode : selectedEdge, null, 2)
    : '';

  const handleAddVehicle = () => {
    spawnVehicle();
  };

  const handleAddVehiclesBulk = (count = 10) => {
    for (let i = 0; i < count; i++) {
      spawnVehicle();
    }
  };

  const handleReset = () => {
    setIsRunning(false);
    setSpawnPoints([]);
    spawnPointsRef.current = [];
    setSpawnPointPlacementMode(false);
    setObstaclePlacementMode(false);
    setObstacleRemovalMode(false);
    initialize({ seedVehicles: lastInitSeedRef.current });
    setIsRunning(true);
  };

  const networkSnapshot = runtimeRef.current
    ? {
        nodes: runtimeRef.current.network.nodes.size,
        edges: runtimeRef.current.network.edges.size,
        lanes: runtimeRef.current.network.lanes.size,
      }
    : { nodes: 0, edges: 0, lanes: 0 };

  const statCollections: Record<
    StatMode,
    { label: string; value: string; accent?: boolean }[]
  > = {
    basic: [
      { label: 'Sim time', value: `${hud.time.toFixed(1)} s` },
      { label: 'Vehicles', value: `${hud.vehicles}` },
      { label: 'Render FPS', value: `${hud.fps.toFixed(0)}` },
    ],
    extended: [
      { label: 'Avg speed', value: `${(hud.avgSpeed * 3.6).toFixed(1)} km/h` },
      { label: 'Zoom', value: `${zoomLevel.toFixed(2)}x` },
      { label: 'Spawn points', value: `${spawnPointsRef.current.length}` },
      { label: 'Time scale', value: `${timeScale.toFixed(2)}x` },
    ],
    advanced: [
      { label: 'Nodes', value: `${networkSnapshot.nodes}` },
      { label: 'Edges', value: `${networkSnapshot.edges}` },
      { label: 'Lanes', value: `${networkSnapshot.lanes}` },
      { label: 'Chunks', value: `${dynamicChunksRef.current.size}` },
    ],
  };

  const statsForMode = statCollections[statModes[statModeIndex]];

  const handleModeCycle = () => {
    setStatModeIndex(i => (i + 1) % statModes.length);
  };

  const handlePanelPress = (clientY: number) => {
    swipeStartRef.current = clientY;
  };

  const handlePanelRelease = (clientY: number) => {
    if (swipeStartRef.current === null) return;
    const delta = swipeStartRef.current - clientY;
    if (delta > 24) {
      setPanelOpen(true);
    } else if (delta < -24) {
      setPanelOpen(false);
    } else {
      setPanelOpen(open => !open);
    }
    swipeStartRef.current = null;
  };

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[#050505] text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(255,121,48,0.08),transparent_35%),radial-gradient(circle_at_80%_10%,rgba(255,121,48,0.06),transparent_30%),linear-gradient(135deg,rgba(255,121,48,0.04),transparent)]" />
        <div className="absolute top-10 right-10 w-40 h-40 bg-orange-500/10 blur-3xl" />
        <div className="absolute bottom-0 left-0 w-72 h-72 bg-orange-500/10 blur-3xl" />
      </div>

      <canvas ref={attachCanvasRef} className="w-full h-full" />

      <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20 max-w-[320px]">
        <div className="rounded-3xl bg-black/75 backdrop-blur-xl border border-orange-500/25 shadow-[0_20px_50px_rgba(0,0,0,0.45)] px-4 py-3 space-y-2">
          <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.25em] text-orange-200/80">
            <span>Stats</span>
            <span className="text-white">{statModes[statModeIndex]}</span>
          </div>
          <div className="space-y-1 transition-all duration-300">
            {statsForMode.map(item => (
              <div key={item.label} className="flex justify-between text-sm">
                <span className="text-orange-100/70">{item.label}</span>
                <span className="font-mono text-white">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="absolute top-6 right-6 flex flex-col items-end gap-3 z-30">
        <button
          onClick={handleModeCycle}
          className="w-14 h-14 rounded-full bg-gradient-to-br from-orange-500 to-orange-600 shadow-[0_10px_30px_rgba(255,121,48,0.35)] flex items-center justify-center border border-orange-400/40 hover:scale-[1.04] active:scale-[0.98] transition"
          aria-label="Cycle stat modes"
        >
          <Sparkles className="text-black drop-shadow" size={22} />
        </button>

        <div className="relative">
          <button
            onClick={() => setToolsOpen(open => !open)}
            className="w-14 h-14 rounded-full bg-black/80 border border-orange-500/40 shadow-[0_10px_30px_rgba(0,0,0,0.45)] flex items-center justify-center hover:border-orange-400 hover:text-orange-200 transition"
            aria-label="Toggle tools drawer"
          >
            <Zap size={20} className="text-orange-300" />
          </button>
          <div
            className={`absolute right-0 mt-3 origin-top-right transition-all duration-300 ${
              toolsOpen
                ? 'opacity-100 scale-100 translate-y-0'
                : 'opacity-0 scale-95 -translate-y-1 pointer-events-none'
            }`}
          >
            <div className="rounded-3xl bg-black/85 backdrop-blur-xl border border-orange-500/30 shadow-[0_20px_50px_rgba(0,0,0,0.55)] overflow-hidden">
              {[
                {
                  key: 'spawn',
                  label: 'Spawn Point',
                  icon: MapPin,
              action: () => {
                setPanelOpen(true);
                setSpawnPointPlacementMode(true);
                setObstaclePlacementMode(false);
                setObstacleRemovalMode(false);
                setTrafficLightPlacementMode(false);
              },
            },
            {
              key: 'place',
              label: 'Place Obstacle',
              icon: Shield,
              action: () => {
                setPanelOpen(true);
                setSpawnPointPlacementMode(false);
                setObstacleRemovalMode(false);
                setObstaclePlacementMode(true);
                setTrafficLightPlacementMode(false);
              },
            },
            {
              key: 'remove',
              label: 'Remove Obstacle',
              icon: Eraser,
              action: () => {
                setPanelOpen(true);
                setSpawnPointPlacementMode(false);
                setObstaclePlacementMode(false);
                setObstacleRemovalMode(true);
                setTrafficLightPlacementMode(false);
              },
            },
            {
              key: 'light',
              label: 'Traffic Light',
              icon: TrafficCone,
              action: () => {
                setPanelOpen(true);
                setSpawnPointPlacementMode(false);
                setObstaclePlacementMode(false);
                setObstacleRemovalMode(false);
                setTrafficLightPlacementMode(true);
              },
            },
            {
              key: 'roads',
              label: 'Add New Roads',
                  icon: GitBranchPlus,
                  action: () => setShowBackdrop(true),
                },
              ].map((tool, idx) => {
                const Icon = tool.icon;
                return (
                  <button
                    key={tool.key}
                    onClick={() => {
                      tool.action();
                      setToolsOpen(false);
                    }}
                    className={`flex items-center gap-3 px-4 py-3 w-full text-left text-sm hover:bg-orange-500/10 transition ${
                      idx !== 0 ? 'border-t border-orange-500/15' : ''
                    }`}
                  >
                    <div className="w-9 h-9 rounded-2xl bg-orange-500/10 border border-orange-500/25 flex items-center justify-center">
                      <Icon size={16} className="text-orange-200" />
                    </div>
                    <span className="text-white">{tool.label}</span>
                  </button>
                );
              })}
              <div className="border-t border-orange-500/15 bg-black/70 px-4 py-3 text-xs text-orange-100/80 flex items-center gap-2">
                <span>Light timer (s)</span>
                <input
                  type="number"
                  min={0}
                  max={300}
                  value={trafficLightTimer}
                  onChange={e =>
                    setTrafficLightTimer(
                      Math.max(0, Math.min(300, Number(e.target.value) || 0))
                    )
                  }
                  className="w-16 rounded bg-slate-900 border border-orange-500/40 px-2 py-1 text-right text-white"
                />
                <span className="text-orange-300 text-[10px]">(0 = manual)</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute left-6 right-6 sm:right-auto sm:w-[460px] max-w-[560px] bottom-6 z-30">
        <div
          className={`relative overflow-hidden rounded-[24px] border border-orange-500/25 bg-black/80 backdrop-blur-2xl shadow-[0_25px_60px_rgba(0,0,0,0.55)] transition-all duration-500 ${
            panelOpen ? 'max-h-[82vh]' : 'max-h-[240px]'
          }`}
        >
          <div className="absolute inset-0 bg-gradient-to-br from-orange-500/12 via-black/40 to-black/80 pointer-events-none" />
          <div className="relative p-4 pt-6 min-h-[200px]">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl border border-orange-500/40 bg-gradient-to-br from-orange-500/30 to-orange-500/10 flex items-center justify-center shadow-[0_10px_40px_rgba(255,121,48,0.25)]">
                  <span className="text-lg font-semibold text-white tracking-wide">TF</span>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-[0.24em] text-orange-200/70">
                    Simulation Suite
                  </div>
                  {panelOpen ? (
                    <div className="text-2xl font-semibold leading-tight">
                      <span className="text-white">Tra</span>
                      <span className="text-orange-400">Fixed</span>
                    </div>
                  ) : (
                    <div className="text-xl font-semibold text-white leading-tight">
                      Traffic Simulation
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={() => setPanelOpen(open => !open)}
                className="w-11 h-11 rounded-2xl border border-orange-500/30 bg-orange-500/15 text-orange-200 flex items-center justify-center hover:bg-orange-500/25 transition"
                aria-label="Toggle controls"
              >
                <ChevronUp
                  className={`transition-transform duration-300 ${panelOpen ? 'rotate-180' : ''}`}
                />
              </button>
            </div>

            <div
              className={`absolute left-4 right-4 transition-all duration-500 ${
                panelOpen ? 'top-[80px]' : 'bottom-4'
              }`}
            >
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-2xl bg-white/5 border border-orange-500/20 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-wide text-orange-200/70">
                      Cars
                    </div>
                    <div className="text-lg font-semibold">{hud.vehicles}</div>
                  </div>
                  <div className="rounded-2xl bg-white/5 border border-orange-500/20 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-wide text-orange-200/70">
                      FPS
                    </div>
                    <div className="text-lg font-semibold">{hud.fps.toFixed(0)}</div>
                  </div>
                  <div className="rounded-2xl bg-white/5 border border-orange-500/20 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-wide text-orange-200/70">
                      Speed
                    </div>
                    <div className="text-lg font-semibold">
                      {(hud.avgSpeed * 3.6).toFixed(1)} km/h
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 rounded-2xl bg-[#0b0b0f] border border-orange-500/30 px-3 py-2 shadow-inner">
                  <Search size={16} className="text-orange-300" />
                  <input
                    value={streetQuery}
                    onChange={e => setStreetQuery(e.target.value)}
                    list="street-suggestions"
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        searchStreetInView();
                      }
                    }}
                    placeholder="Search visible streets"
                    className="flex-1 bg-transparent outline-none text-sm placeholder:text-orange-100/50"
                  />
                  <button
                    onClick={() => setIsRunning(prev => !prev)}
                    className="flex items-center gap-1 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 px-3 py-2 text-sm font-medium shadow-[0_10px_30px_rgba(255,121,48,0.35)] hover:translate-y-[-1px] transition"
                  >
                    {isRunning ? <Pause size={14} /> : <Play size={14} />}
                    <span>{isRunning ? 'Pause' : 'Play'}</span>
                  </button>
                </div>
                <datalist id="street-suggestions">
                  {streetSuggestions.map(name => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </div>
            </div>

            <div
              className={`transition-all duration-500 ${
                panelOpen
                  ? 'opacity-100 translate-y-0 pt-36 space-y-4'
                  : 'opacity-0 -translate-y-2 pointer-events-none h-0 overflow-hidden'
              }`}
            >
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="bg-white/5 border border-orange-500/20 rounded-2xl px-3 py-3 space-y-2">
                  <div className="text-xs uppercase tracking-wide text-orange-200/80">Scenario</div>
                  <select
                    value={scenario}
                    onChange={e => setScenario(e.target.value as ScenarioKey)}
                    className="w-full rounded-xl bg-black/60 border border-orange-500/30 px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                  >
                    <option value="simple_highway">Highway with ramps</option>
                    <option value="urban_intersection">Signalized intersection</option>
                    <option value="roundabout">Four-arm roundabout</option>
                    <option value="heilbronn_perchance">Heilbronn Perchance (full)</option>
                    <option value="test_perchance">Test Perchance (full)</option>
                  </select>
                  <p className="text-[11px] text-orange-100/70">
                    Swiping up reveals advanced tuning without leaving the viewport.
                  </p>
                </div>
                <div className="bg-white/5 border border-orange-500/20 rounded-2xl px-3 py-3 space-y-3">
                  <div className="flex items-center justify-between text-xs uppercase tracking-wide text-orange-200/80">
                    <span>Time scale</span>
                    <span className="font-mono text-white">{timeScale.toFixed(1)}x</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setTimeScale(v => Math.max(0.25, v - 0.25))}
                      className="p-2 rounded-xl bg-black/70 border border-orange-500/30 hover:border-orange-400 transition"
                    >
                      <Minus size={14} />
                    </button>
                    <input
                      type="range"
                      min={0.25}
                      max={4}
                      step={0.05}
                      value={timeScale}
                      onChange={e => setTimeScale(parseFloat(e.target.value))}
                      className="flex-1 accent-orange-500"
                    />
                    <button
                      onClick={() => setTimeScale(v => Math.min(4, v + 0.25))}
                      className="p-2 rounded-xl bg-black/70 border border-orange-500/30 hover:border-orange-400 transition"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between text-xs text-orange-100/80">
                    <span>Input</span>
                    <button
                      onClick={() => setInputMode(m => (m === 'mouse' ? 'trackpad' : 'mouse'))}
                      className="px-3 py-2 rounded-xl bg-orange-500/15 border border-orange-500/30 text-sm hover:border-orange-400 transition"
                    >
                      {inputMode === 'trackpad' ? 'Trackpad' : 'Mouse'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="bg-white/5 border border-orange-500/20 rounded-2xl px-3 py-3 space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={handleReset}
                      className="flex-1 min-w-[140px] rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 px-3 py-2 text-sm font-semibold shadow-[0_10px_30px_rgba(255,121,48,0.35)] hover:translate-y-[-1px] transition"
                    >
                      Reset
                    </button>
                    <button
                      onClick={handleAddVehicle}
                      className="flex-1 min-w-[140px] rounded-xl bg-black/70 border border-orange-500/30 px-3 py-2 text-sm hover:border-orange-400 transition"
                    >
                      + Inject 1
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={bulkCount}
                      onChange={e =>
                        setBulkCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))
                      }
                      className="w-20 rounded-xl bg-black/60 border border-orange-500/30 px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                    />
                    <button
                      onClick={() => handleAddVehiclesBulk(bulkCount)}
                      className="flex-1 rounded-xl bg-black/70 border border-orange-500/30 px-3 py-2 text-sm hover:border-orange-400 transition"
                    >
                      Inject {bulkCount}
                    </button>
                  </div>
                </div>

                <div className="bg-white/5 border border-orange-500/20 rounded-2xl px-3 py-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <button
                      onClick={() => {
                        setSpawnPointPlacementMode(true);
                        setObstaclePlacementMode(false);
                        setObstacleRemovalMode(false);
                      }}
                      className={`rounded-xl px-3 py-2 border transition ${
                        spawnPointPlacementMode
                          ? 'border-orange-400 bg-orange-500/20'
                          : 'border-orange-500/25 bg-black/60 hover:border-orange-400'
                      }`}
                    >
                      Spawn point
                    </button>
                    <button
                      onClick={() => {
                        setSpawnPointPlacementMode(false);
                        setObstacleRemovalMode(false);
                        setObstaclePlacementMode(true);
                      }}
                      className={`rounded-xl px-3 py-2 border transition ${
                        obstaclePlacementMode
                          ? 'border-orange-400 bg-orange-500/20'
                          : 'border-orange-500/25 bg-black/60 hover:border-orange-400'
                      }`}
                    >
                      Place obstacle
                    </button>
                    <button
                      onClick={() => {
                        setSpawnPointPlacementMode(false);
                        setObstaclePlacementMode(false);
                        setObstacleRemovalMode(true);
                      }}
                      className={`rounded-xl px-3 py-2 border transition ${
                        obstacleRemovalMode
                          ? 'border-orange-400 bg-orange-500/20'
                          : 'border-orange-500/25 bg-black/60 hover:border-orange-400'
                      }`}
                    >
                      Remove obstacle
                    </button>
                <button
                  onClick={() => setShowRoadEdges(v => !v)}
                  className="rounded-xl px-3 py-2 border border-orange-500/25 bg-black/60 hover:border-orange-400 transition"
                >
                  {showRoadEdges ? 'Hide edges' : 'Show edges'}
                </button>
                <div className="grid grid-cols-4 gap-2 text-sm">
                  {([
                    { key: 'off', label: 'Off', value: VEHICLE_TARGETS.off },
                    { key: 'low', label: 'Low', value: VEHICLE_TARGETS.low },
                    { key: 'mid', label: 'Mid', value: VEHICLE_TARGETS.mid },
                    { key: 'high', label: 'High', value: VEHICLE_TARGETS.high },
                  ] as const).map(option => (
                    <button
                      key={option.key}
                      onClick={() => setVehicleTarget(option.value)}
                      className={`rounded-xl px-2 py-2 border transition ${
                        vehicleTarget === option.value
                          ? 'border-orange-400 bg-orange-500/20'
                          : 'border-orange-500/25 bg-black/60 hover:border-orange-400'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setShowHud(v => !v)}
                  className={`rounded-full px-4 py-2 text-sm border transition ${
                    showHud
                      ? 'border-orange-400 bg-orange-500/20'
                      : 'border-orange-500/25 bg-black/60 hover:border-orange-400'
                  }`}
                >
                  {showHud ? 'Hide HUD' : 'Show HUD'}
                </button>
                <button
                  onClick={() => setShowBackdrop(v => !v)}
                  className={`rounded-full px-4 py-2 text-sm border transition ${
                    showBackdrop
                      ? 'border-orange-400 bg-orange-500/20'
                      : 'border-orange-500/25 bg-black/60 hover:border-orange-400'
                  }`}
                >
                  {showBackdrop ? 'Hide map detail' : 'Show map detail'}
                </button>
                <select
                  value={backdropTheme}
                  onChange={e => setBackdropTheme(e.target.value as keyof typeof BACKDROP_THEMES)}
                  className="rounded-full px-3 py-2 text-sm border border-orange-500/25 bg-black/70 hover:border-orange-400 transition text-orange-100"
                >
                  <option value="osm">OSM Standard</option>
                  <option value="light">Light (Carto)</option>
                  <option value="dark">Dark (Carto)</option>
                </select>
                <button
                  onClick={() => applyZoom(1)}
                  className="rounded-full px-4 py-2 text-sm border border-orange-500/25 bg-black/60 hover:border-orange-400 transition"
                >
                  Reset zoom
                </button>
              </div>
            </div>
          </div>

          <div className="relative px-4 pb-3">
            <button
              className="w-full flex items-center justify-center gap-3 text-xs uppercase tracking-[0.25em] text-orange-200/80 py-2"
              onPointerDown={e => handlePanelPress(e.clientY)}
              onPointerUp={e => handlePanelRelease(e.clientY)}
              onPointerCancel={() => (swipeStartRef.current = null)}
              onTouchStart={e => handlePanelPress(e.touches[0].clientY)}
              onTouchEnd={e => handlePanelRelease(e.changedTouches[0].clientY)}
              aria-label="Swipe handle"
            >
              <span className="h-1.5 w-16 rounded-full bg-orange-400/60" />
            </button>
          </div>
        </div>
      </div>

      {showHud && (
        <div className="absolute top-5 right-24 bg-black/70 backdrop-blur-xl border border-orange-500/25 rounded-3xl px-4 py-3 text-sm space-y-1 shadow-[0_15px_40px_rgba(0,0,0,0.45)]">
          <div className="flex justify-between gap-6">
            <span className="text-orange-100/70">t</span>
            <span className="font-mono">{hud.time.toFixed(1)} s</span>
          </div>
          <div className="flex justify-between gap-6">
            <span className="text-orange-100/70">n</span>
            <span className="font-mono">{hud.vehicles}</span>
          </div>
          <div className="flex justify-between gap-6">
            <span className="text-orange-100/70">v_avg</span>
            <span className="font-mono">{(hud.avgSpeed * 3.6).toFixed(1)} km/h</span>
          </div>
          <div className="flex justify-between gap-6">
            <span className="text-orange-100/70">fps</span>
            <span className="font-mono">{hud.fps.toFixed(0)}</span>
          </div>
        </div>
      )}

      {selection && (selectedNode || selectedEdge) && (
        <div className="absolute bottom-4 right-4 w-80 max-h-[70vh] overflow-hidden rounded-3xl border border-orange-500/25 bg-black/85 backdrop-blur-xl p-4 shadow-[0_20px_50px_rgba(0,0,0,0.55)] text-sm text-orange-50 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wide text-orange-200/80">
                Selected type: {selection.type === 'node' ? 'Node' : 'Edge'}
              </div>
              <div className="font-mono text-orange-50 text-xs break-all">{selection.id}</div>
            </div>
            <button
              className="text-xs text-orange-100 hover:text-white"
              onClick={() => applySelection(undefined)}
            >
              Clear
            </button>
          </div>

          {selection.type === 'edge' && selectedStats && (
            <div className="space-y-1 text-xs text-orange-100/90">
              <div className="flex justify-between">
                <span>Length</span>
                <span className="font-mono text-white">{selectedStats.length.toFixed(1)} m</span>
              </div>
              {selectedStats.speedLimit && (
                <div className="flex justify-between">
                  <span>Speed limit</span>
                  <span className="font-mono text-white">
                    {(selectedStats.speedLimit * 3.6).toFixed(0)} km/h
                  </span>
                </div>
              )}
              {selectedStats.travelMinutes && (
                <div className="flex justify-between">
                  <span>Est. travel time</span>
                  <span className="font-mono text-white">
                    {selectedStats.travelMinutes.toFixed(1)} min
                  </span>
                </div>
              )}
              {selectedStats.lanes && (
                <div className="flex justify-between">
                  <span>Lanes</span>
                  <span className="font-mono text-white">{selectedStats.lanes}</span>
                </div>
              )}
              <div className="flex justify-between items-center">
                <span>Direction</span>
                <span className="font-mono text-white">
                  {selection.direction === 'forward' ? '→ forward' : '← backward'}
                </span>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() =>
                selection && copyJSON(selection.type === 'node' ? selectedNode : selectedEdge)
              }
              className="flex-1 rounded-xl bg-white/5 hover:bg-orange-500/10 px-2 py-2 text-xs text-orange-50 border border-orange-500/25 transition"
            >
              Copy JSON
            </button>
            <button
              onClick={() => {
                if (!selection) return;
                const data = selection.type === 'node' ? selectedNode : selectedEdge;
                if (!data) return;
                const filename = `${selection.type}_${selection.id}.json`;
                downloadJSON(filename, data);
              }}
              className="flex-1 rounded-xl bg-white/5 hover:bg-orange-500/10 px-2 py-2 text-xs text-orange-50 border border-orange-500/25 transition"
            >
              Download JSON
            </button>
          </div>

          <div className="rounded-2xl bg-black/70 border border-orange-500/20 p-2 text-xs text-orange-100 max-h-48 overflow-auto">
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-snug">
              {selectedJSON}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
