import { key, permitted, type Activity, type Colony, type Dwarf, type Resource, type Voxel, type WorldPort } from './types.ts';
import { pathToWork, supportsDwarf, type Reachable } from './navigation.ts';
import { TICKS_PER_SECOND } from './clock.ts';

export const NEEDS = { ticksPerNeedPoint: TICKS_PER_SECOND, ticksPerRestPoint: 2, hungry: 50, mealRelief: 40, tired: 60, rested: 20, restRelief: 1 } as const;
function activity(c: Colony, d: Dwarf, next: Activity): void {
  if (d.activity !== next) c.events.push(`tick ${c.tick}: ${d.name} ${next}`);
  d.activity = next;
}
/** Needs grow once per simulation second. Eating can interrupt sustained rest. */
export function meetNeeds(c: Colony, d: Dwarf): boolean {
  if (d.tiredness >= NEEDS.tired) d.resting = true;
  if (d.tiredness <= NEEDS.rested) d.resting = false;
  if (d.hunger >= NEEDS.hungry && c.resources.food > 0) {
    c.resources.food--; c.consumedFood++;
    d.hunger = Math.max(0, d.hunger - NEEDS.mealRelief);
    activity(c, d, 'eating'); return true;
  }
  if (d.resting) {
    if (c.tick % NEEDS.ticksPerRestPoint === 0) d.tiredness = Math.max(0, d.tiredness - NEEDS.restRelief);
    if (d.tiredness <= NEEDS.rested) d.resting = false;
    activity(c, d, 'resting'); return true;
  }
  return false;
}
/** Harvest permission is explicit and never inferred from a wood block's appearance. */
export function addResourceSource(c: Colony, at: Voxel, resource: Resource): void {
  if (![at.x, at.y, at.z].every(Number.isSafeInteger)) throw new Error('source coordinates must be safe integers');
  if (c.sources.some(s => key(s.at) === key(at))) throw new Error('duplicate resource source');
  c.sources.push({ at: { ...at }, resource });
}
function needed(c: Colony, resource: Resource): boolean {
  const incoming = c.orders.filter(o => o.kind === 'gather-block' && o.yield === resource && (o.status === 'pending' || o.status === 'awaiting-world')).length;
  const target = resource === 'food' ? c.dwarves.length * 2 : c.orders.filter(o => o.kind === 'place-block' && o.block === 'wood' && o.status === 'pending').length;
  return c.resources[resource] + incoming < target;
}
export function reservedForBuilding(c: Colony, at: Voxel): boolean {
  // Include interiors and foundations, not just proposed wall/roof blocks.
  return c.shelters.some(s => at.x >= s.origin.x && at.x <= s.origin.x + 2 && at.z >= s.origin.z && at.z <= s.origin.z + 2 && at.y >= s.origin.y - 1 && at.y <= s.origin.y + 2)
    || c.orders.some(o => o.kind === 'place-block' && key(o.at) === key(at));
}
export function hasGatherWork(c: Colony, world: WorldPort): boolean {
  return c.sources.some(s => needed(c, s.resource) && permitted(c, s.at) && !reservedForBuilding(c, s.at)
    && !c.orders.some(o => o.kind === 'gather-block' && o.status !== 'cancelled' && key(o.at) === key(s.at))
    && world.read(s.at) === (s.resource === 'food' ? 'berries' : 'wood'));
}
/** Stable source order and pending yields give deterministic, nonduplicated allocation. */
export function gather(c: Colony, d: Dwarf, world: WorldPort, search: Reachable): boolean {
  for (const resource of ['food', 'wood'] as const) {
    if (!needed(c, resource)) continue;
    const expected = resource === 'food' ? 'berries' : 'wood';
    const source = c.sources.find(s => s.resource === resource && permitted(c, s.at)
      && !reservedForBuilding(c, s.at) && !supportsDwarf(c, s.at)
      && !c.orders.some(o => o.kind === 'gather-block' && o.status !== 'cancelled' && key(o.at) === key(s.at))
      && world.read(s.at) === expected && pathToWork(search, s.at) !== undefined);
    if (!source) continue;
    const id = `o${c.nextId++}`;
    c.orders.push({ id, kind: 'gather-block', status: 'pending', at: { ...source.at }, expected, block: 'air', owner: d.id, reserved: false, yield: resource });
    d.task = id; d.path = pathToWork(search, source.at)!; d.moveTicks = 0; d.searchRetryAt = 0;
    return true;
  }
  return false;
}
