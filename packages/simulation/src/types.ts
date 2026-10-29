/** Serializable simulation state; no platform dependencies. */
export type Voxel = { x: number; y: number; z: number };
export type Block = 'air' | 'dirt' | 'wood' | 'stone' | 'berries';
export type Resource = 'wood' | 'food';
export type ResourceSource = { at: Voxel; resource: Resource };
export type Activity = 'idle' | 'eating' | 'resting' | 'gathering' | 'building' | 'walking';
export type Territory = { min: Voxel; max: Voxel };
export type Change = { id: string; at: Voxel; expected: Block; next: Block; reason: string };
export type ChangeResult = { id: string; applied: boolean; actual?: Block; reason?: string };
export type MovementMode = 'headless' | 'adapter';
export type MovementCommand = {
  id: string; dwarfId: string; revision: number; issuedTick: number;
} & ({ kind: 'move'; from: Voxel; to: Voxel; durationTicks: number; blocksPerSecond: number }
  | { kind: 'stop'; at: Voxel; reason: string });
export type MovementFeedback = { dwarfId: string; revision: number; sequence: number } & (
  { kind: 'arrived' | 'corrected'; position: Voxel } | { kind: 'unavailable' }
);
export type PathSearch = { start: Voxel; positions: Voxel[]; parents: number[]; cursor: number; limit: number; done: boolean };
export interface WorldPort {
  /** undefined means unknown/unavailable, never air. */
  read(at: Voxel): Block | undefined;
  /** Atomically enforce protection, compare-and-set, and operation idempotency. */
  apply(change: Change): ChangeResult | undefined;
}
export type Dwarf = {
  id: string; name: string; hunger: number; tiredness: number; activity: Activity; resting: boolean; home?: string;
  position: Voxel; path: Voxel[]; task?: string; moveTicks: number;
  positionKnown: boolean; motionRevision: number; motion?: MovementCommand; lastMotionSequence: number; actionNotBeforeTick: number;
  search?: PathSearch; searchRetryAt: number;
};
export type Dwelling = { id: string; capacity: number; quality: number; occupied: string[] };
export type WorkOrder = {
  id: string; kind: 'place-block' | 'gather-block'; status: 'pending' | 'awaiting-world' | 'complete' | 'blocked' | 'cancelled';
  at: Voxel; expected: Block; block: Block; owner?: string; project?: string; reserved: boolean; yield?: Resource;
};
export type Shelter = { id: string; origin: Voxel; status: 'building' | 'suspended' | 'complete'; orders: string[] };
export type Colony = {
  version: 5; tick: number; nextId: number; rng: number;
  movementMode: MovementMode;
  pathfinding: { queue: string[]; starts: number; startedTick: number; expanded: number; totalExpanded: number; totalStarted: number };
  dwarves: Dwarf[]; dwellings: Dwelling[]; orders: WorkOrder[]; pending: Change[];
  shelters: Shelter[]; territory: Territory[]; sites: Voxel[];
  resources: { wood: number; food: number }; consumedWood: number;
  sources: ResourceSource[]; gathered: { wood: number; food: number }; consumedFood: number;
  reconciliationCursor: number; events: string[];
};
export const key = (v: Voxel): string => `${v.x},${v.y},${v.z}`;
export function permitted(c: Colony, at: Voxel): boolean {
  return c.territory.some(t => at.x >= t.min.x && at.x <= t.max.x && at.y >= t.min.y && at.y <= t.max.y && at.z >= t.min.z && at.z <= t.max.z);
}
