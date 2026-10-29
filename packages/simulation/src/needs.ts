import { key, permitted, type Activity, type Colony, type Dwarf, type Resource, type Voxel, type WorldPort } from './types.ts';
import { pathToWork, supportsDwarf, type Reachable } from './navigation.ts';
import { CARRY_CAPACITY, inventorySize, inventoryTotals, stockpileAccessible, stockpileOccupies } from './stockpiles.ts';
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
  if (d.hunger >= NEEDS.hungry && d.carry.food > 0) {
    d.carry.food--;
    if (inventorySize(d.carry) === 0) {
      d.deliveryRequired = false;
      // Keep the known return journey even if the harvest was eaten on site.
      if (!d.haul && d.deliveryRoute && key(d.position) === key(d.deliveryRoute.from)) {
        d.haul = { kind: 'deposit', stockpileId: d.deliveryRoute.stockpileId };
        d.path = d.deliveryRoute.path; delete d.deliveryRoute; delete d.search; d.searchRetryAt = 0;
      }
    }
    c.consumedFood++;
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
  if (stockpileOccupies(c, at)) throw new Error('resource source overlaps stockpile');
  c.sources.push({ at: { ...at }, resource });
}
function needed(c: Colony, resource: Resource): boolean {
  const incoming = c.orders.filter(o => o.kind === 'gather-block' && o.yield === resource && (o.status === 'pending' || o.status === 'awaiting-world')).length;
  const target = resource === 'food' ? c.dwarves.length * 2 : c.orders.filter(o => o.kind === 'place-block' && o.block === 'wood' && o.status === 'pending').length;
  const total = inventoryTotals(c);
  if (resource === 'wood') total.wood -= c.orders.filter(o => o.reserved).length;
  return total[resource] + incoming < target;
}
export function reservedForBuilding(c: Colony, at: Voxel): boolean {
  // Include interiors and foundations, not just proposed wall/roof blocks.
  return stockpileOccupies(c, at) || c.shelters.some(s => at.x >= s.origin.x && at.x <= s.origin.x + 2 && at.z >= s.origin.z && at.z <= s.origin.z + 2 && at.y >= s.origin.y - 1 && at.y <= s.origin.y + 2)
    || c.orders.some(o => o.kind === 'place-block' && key(o.at) === key(at));
}
export function hasGatherWork(c: Colony, world: WorldPort): boolean {
  const demand = { wood: needed(c, 'wood'), food: needed(c, 'food') };
  const claimed = new Set(c.orders.filter(o => o.kind === 'gather-block' && o.status !== 'cancelled').map(o => key(o.at)));
  return c.sources.some(s => demand[s.resource] && !claimed.has(key(s.at)) && permitted(c, s.at) && !reservedForBuilding(c, s.at)
    && world.read(s.at) === (s.resource === 'food' ? 'berries' : 'wood'));
}
/** Stable source order and pending yields give deterministic, nonduplicated allocation. */
export function gather(c: Colony, d: Dwarf, world: WorldPort, search: Reachable): boolean {
  if (inventorySize(d.carry) >= CARRY_CAPACITY) return false;
  const claimed = new Set(c.orders.filter(o => o.kind === 'gather-block' && o.status !== 'cancelled').map(o => key(o.at)));
  for (const resource of ['food', 'wood'] as const) {
    if (!needed(c, resource)) continue;
    const expected = resource === 'food' ? 'berries' : 'wood';
    const source = c.sources.find(s => s.resource === resource && !claimed.has(key(s.at)) && permitted(c, s.at)
      && !reservedForBuilding(c, s.at) && !supportsDwarf(c, s.at)
      && world.read(s.at) === expected && pathToWork(search, s.at) !== undefined);
    if (!source) continue;
    const id = `o${c.nextId++}`;
    c.orders.push({ id, kind: 'gather-block', status: 'pending', at: { ...source.at }, expected, block: 'air', owner: d.id, reserved: false, yield: resource });
    d.task = id; d.path = pathToWork(search, source.at)!; d.moveTicks = 0; d.searchRetryAt = 0;
    delete d.deliveryRoute;
    const destination = c.stockpiles.find(s => stockpileAccessible(c, world, s) && inventorySize(s.resources) < s.capacity && pathToWork(search, s.at) !== undefined);
    if (destination) {
      const reverse = d.path.length ? [...d.path.slice(0, -1).reverse(), d.position] : [];
      d.deliveryRoute = { stockpileId: destination.id, from: { ...(d.path.at(-1) ?? d.position) },
        path: [...reverse, ...pathToWork(search, destination.at)!].map(p => ({ ...p })) };
    }
    return true;
  }
  return false;
}
