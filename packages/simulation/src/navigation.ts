import { key, type Colony, type Dwarf, type PathSearch, type Voxel, type WorldPort } from './types.ts';

import { TICKS_PER_SECOND } from './clock.ts';

export const MOVEMENT = { ticksPerSecond: TICKS_PER_SECOND, ticksPerBlock: 8, maxSearchNodes: 512 } as const;
export const PATHFINDING = { nodesPerTick: 64, jobsPerTick: 4, startsPerTick: 2, retryTicks: 40 } as const;
export function solid(block: ReturnType<WorldPort['read']>): boolean {
  return block === 'dirt' || block === 'wood' || block === 'stone';
}
export function standable(world: WorldPort, at: Voxel, forbidden: Set<string> = new Set()): boolean {
  if (forbidden.has(key(at)) || forbidden.has(key({ ...at, y: at.y + 1 }))) return false;
  return world.read(at) === 'air' && world.read({ ...at, y: at.y + 1 }) === 'air'
    && solid(world.read({ ...at, y: at.y - 1 }));
}
/** Cardinal walking and one-block steps, with clearance over the entire step. */
export function canMove(world: WorldPort, from: Voxel, to: Voxel, forbidden: Set<string> = new Set()): boolean {
  if (Math.abs(from.x - to.x) + Math.abs(from.z - to.z) !== 1 || Math.abs(from.y - to.y) > 1) return false;
  if (!standable(world, from) || !standable(world, to, forbidden)) return false;
  if (to.y > from.y && world.read({ ...from, y: from.y + 2 }) !== 'air') return false;
  if (to.y < from.y && world.read({ ...to, y: from.y + 1 }) !== 'air') return false;
  return true;
}
/** Work from a neighboring column, within two blocks above feet or one below. */
export function inWorkRange(position: Voxel, target: Voxel): boolean {
  return Math.abs(position.x - target.x) + Math.abs(position.z - target.z) === 1
    && target.y >= position.y - 1 && target.y <= position.y + 2;
}
export function occupied(c: Colony, at: Voxel): boolean {
  return c.dwarves.some(d => d.position.x === at.x && d.position.z === at.z
    && (d.position.y === at.y || d.position.y + 1 === at.y));
}
export function supportsDwarf(c: Colony, at: Voxel): boolean {
  return c.dwarves.some(d => d.position.x === at.x && d.position.z === at.z && d.position.y - 1 === at.y);
}
export type Reachable = { positions: Voxel[]; parents: Map<string, Voxel | undefined> };
export function startSearch(world: WorldPort, start: Voxel, limit: number = MOVEMENT.maxSearchNodes): PathSearch {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('search budget must be a positive safe integer');
  const valid = standable(world, start);
  return { start: { ...start }, positions: valid ? [{ ...start }] : [], parents: valid ? [-1] : [], cursor: 0, limit, done: !valid };
}
/** At most budget node expansions; all queued frontier state is serializable. */
export function advanceSearch(job: PathSearch, world: WorldPort, forbidden: Set<string>, budget: number): number {
  const visited = new Set(job.positions.map(key)); let expanded = 0;
  while (!job.done && expanded < budget) {
    if (job.cursor >= job.positions.length || job.positions.length >= job.limit) { job.done = true; break; }
    const parent = job.cursor++; const at = job.positions[parent]!; expanded++;
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      for (const dy of [0, 1, -1]) {
        const next = { x: at.x + dx, y: at.y + dy, z: at.z + dz };
        if (visited.has(key(next)) || !canMove(world, at, next, forbidden)) continue;
        visited.add(key(next)); job.positions.push(next); job.parents.push(parent);
        if (job.positions.length >= job.limit) break;
      }
      if (job.positions.length >= job.limit) break;
    }
    if (job.cursor >= job.positions.length || job.positions.length >= job.limit) job.done = true;
  }
  return expanded;
}
function searchResult(job: PathSearch): Reachable {
  return { positions: job.positions, parents: new Map(job.positions.map((p, i) => [key(p), job.parents[i]! < 0 ? undefined : job.positions[job.parents[i]!]!])) };
}
/** Synchronous spatial query for headless callers; the engine uses scheduled jobs. */
export function reachable(world: WorldPort, start: Voxel, budget: number = MOVEMENT.maxSearchNodes, forbidden: Set<string> = new Set()): Reachable {
  const job = startSearch(world, start, budget);
  advanceSearch(job, world, forbidden, budget);
  return searchResult(job);
}
/** Shared round-robin budget, including on chunk reload; never one full search per dwarf/frame. */
export function servicePathSearches(c: Colony, world: WorldPort, forbidden: Set<string>): number {
  c.pathfinding.starts = 0; c.pathfinding.startedTick = c.tick;
  const visits = Math.min(PATHFINDING.jobsPerTick, c.pathfinding.queue.length);
  let expanded = 0;
  for (let n = 0; n < visits; n++) {
    const id = c.pathfinding.queue.shift()!;
    const d = c.dwarves.find(d => d.id === id);
    if (!d?.search || d.search.done) continue;
    if (d.positionKnown && standable(world, d.position)) {
      expanded += advanceSearch(d.search, world, forbidden, PATHFINDING.nodesPerTick / PATHFINDING.jobsPerTick);
    }
    if (!d.search.done) c.pathfinding.queue.push(id);
  }
  c.pathfinding.expanded = expanded; c.pathfinding.totalExpanded += expanded;
  return expanded;
}
export function requestReachable(c: Colony, d: Dwarf, world: WorldPort): Reachable | undefined {
  if (d.search && key(d.search.start) !== key(d.position)) delete d.search;
  if (d.search?.done) {
    const result = searchResult(d.search); delete d.search;
    d.searchRetryAt = c.tick + PATHFINDING.retryTicks + c.dwarves.indexOf(d) % 20;
    return result;
  }
  if (!d.search && c.tick >= d.searchRetryAt && c.pathfinding.starts < PATHFINDING.startsPerTick) {
    d.search = startSearch(world, d.position); c.pathfinding.starts++; c.pathfinding.totalStarted++;
    if (!c.pathfinding.queue.includes(d.id)) c.pathfinding.queue.push(d.id);
  }
  return undefined;
}
export function navigationObstacles(c: Colony): Set<string> {
  const cells = new Set(c.orders.filter(o => o.kind === 'place-block' && (o.status === 'pending' || o.status === 'awaiting-world') && o.block !== 'air').map(o => key(o.at)));
  const harvested = new Set(c.orders.filter(o => o.kind === 'gather-block' && o.status === 'complete').map(o => key(o.at)));
  // Harvestable blocks are temporary footing. Route around them, never onto them.
  for (const s of c.sources) {
    if (harvested.has(key(s.at))) continue;
    cells.add(key(s.at)); cells.add(key({ ...s.at, y: s.at.y + 1 }));
  }
  return cells;
}
export function pathToWork(search: Reachable, target: Voxel): Voxel[] | undefined {
  let at = search.positions.find(p => inWorkRange(p, target));
  if (!at) return undefined;
  const reversed: Voxel[] = [];
  while (search.parents.get(key(at))) {
    reversed.push({ ...at }); at = search.parents.get(key(at))!;
  }
  return reversed.reverse();
}
