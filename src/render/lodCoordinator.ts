import { config } from '../config.js';
import { MapIndex } from '../utils/mapLoader.js';

export type RoadClass = 'major' | 'primary' | 'secondary' | 'all';

export function pickRoadClass(zoom: number): RoadClass {
  const { Z1, Z2 } = config.optimizations.lodZooms;
  if (zoom < Z1) return 'major';
  if (zoom < Z2) return 'primary';
  return 'all';
}

export function filterEdgesByLOD(
  mapIndex: MapIndex,
  edges: Array<{ id: string; roadType?: string; properties?: any }>,
  zoom: number
) {
  const clazz = pickRoadClass(zoom);
  if (clazz === 'all') return edges;
  return edges.filter(e => {
    const type = e.roadType || e.properties?.highway || '';
    if (clazz === 'major') {
      return /motorway|trunk|primary/i.test(type) || mapIndex.majorRoadIds.includes(e.id);
    }
    if (clazz === 'primary') {
      return /motorway|trunk|primary|secondary/i.test(type) || mapIndex.majorRoadIds.includes(e.id);
    }
    return true;
  });
}
