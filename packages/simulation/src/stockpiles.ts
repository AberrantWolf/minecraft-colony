import { key, permitted, type Colony, type Dwarf, type Inventory, type Stockpile, type Voxel, type WorldPort } from './types.ts';
import { inWorkRange, pathToWork, standable, type Reachable } from './navigation.ts';

export const CARRY_CAPACITY = 4;
export const inventorySize = (inventory: Inventory): number => inventory.wood + inventory.food;
export function storedResources(c: Colony): Inventory {
  return c.stockpiles.reduce((a, s) => ({ wood: a.wood + s.resources.wood, food: a.food + s.resources.food }), { wood: 0, food: 0 });
}
/** Resources in storage, hands, and prepared construction escrow; excludes consumed units. */
export function inventoryTotals(c: Colony): Inventory {
  const total = storedResources(c);
  for (const d of c.dwarves) { total.wood += d.carry.wood; total.food += d.carry.food; }
  total.wood += c.orders.filter(o => o.reserved).length;
  return total;
}
export function stockpileOccupies(c: Colony, at: Voxel): boolean {
  return c.stockpiles.some(s => s.at.x === at.x && s.at.z === at.z && at.y >= s.at.y - 1 && at.y <= s.at.y + 1);
}
/** A designated inventory zone, not a Minecraft chest. Never edits terrain. */
export function addStockpile(c: Colony, at: Voxel, capacity = 64, initial: Inventory = { wood: 0, food: 0 }): Stockpile {
  if (![at.x, at.y, at.z].every(Number.isSafeInteger) || !Number.isSafeInteger(capacity) || capacity < 1
    || ![initial.wood, initial.food].every(n => Number.isSafeInteger(n) && n >= 0) || inventorySize(initial) > capacity) throw new Error('invalid stockpile position, capacity, or inventory');
  if (!permitted(c, at)) throw new Error('stockpile must be in permitted territory');
  if (c.stockpiles.some(s => s.at.x === at.x && s.at.z === at.z && Math.abs(s.at.y - at.y) <= 2) || c.sources.some(s => s.at.x === at.x && s.at.z === at.z && Math.abs(s.at.y - at.y) <= 1)
    || c.orders.some(o => o.at.x === at.x && o.at.z === at.z && o.at.y >= at.y - 1 && o.at.y <= at.y + 1)
    || c.shelters.some(s => at.x >= s.origin.x && at.x <= s.origin.x + 2 && at.z >= s.origin.z && at.z <= s.origin.z + 2 && at.y >= s.origin.y - 1 && at.y <= s.origin.y + 3)) throw new Error('stockpile overlaps a reserved location');
  const pile: Stockpile = { id: `p${c.nextId++}`, at: { ...at }, capacity, resources: { ...initial }, enabled: true };
  c.stockpiles.push(pile); return pile;
}
export function stockpileAccessible(c: Colony, world: WorldPort, s: Stockpile): boolean {
  return s.enabled && permitted(c, s.at) && standable(world, s.at);
}
export function stockpileObserved(world: WorldPort, s: Stockpile): boolean {
  return [s.at.y - 1, s.at.y, s.at.y + 1].every(y => world.read({ ...s.at, y }) !== undefined);
}
function claimHaul(d: Dwarf, path: Voxel[]): void {
  d.path = path; d.moveTicks = 0; d.searchRetryAt = 0;
}
export function assignDeposit(c: Colony, d: Dwarf, world: WorldPort, search: Reachable): boolean {
  const cached = d.deliveryRoute;
  const destination = c.stockpiles.find(s => s.id === cached?.stockpileId);
  if (cached && destination && key(d.position) === key(cached.from) && stockpileAccessible(c, world, destination) && inventorySize(destination.resources) < destination.capacity) {
    d.haul = { kind: 'deposit', stockpileId: destination.id }; claimHaul(d, cached.path.map(p => ({ ...p })));
    delete d.deliveryRoute; return true;
  }
  const pile = c.stockpiles.find(s => stockpileAccessible(c, world, s) && inventorySize(s.resources) < s.capacity && pathToWork(search, s.at) !== undefined);
  if (!pile) return false;
  d.haul = { kind: 'deposit', stockpileId: pile.id }; claimHaul(d, pathToWork(search, pile.at)!); delete d.deliveryRoute; return true;
}
export function assignMeal(c: Colony, d: Dwarf, world: WorldPort, search: Reachable): boolean {
  const pile = c.stockpiles.find(s => stockpileAccessible(c, world, s) && s.resources.food > 0 && pathToWork(search, s.at) !== undefined);
  if (!pile || inventorySize(d.carry) >= CARRY_CAPACITY) return false;
  d.haul = { kind: 'meal', stockpileId: pile.id }; claimHaul(d, pathToWork(search, pile.at)!); return true;
}
/** Called once on site, on a work tick after travel. Serial transitions resolve contention. */
export function transferAtStockpile(c: Colony, d: Dwarf, world: WorldPort): boolean {
  const task = d.haul; const pile = c.stockpiles.find(s => s.id === task?.stockpileId);
  if (!task || !pile || !d.positionKnown || !standable(world, d.position) || !inWorkRange(d.position, pile.at)
    || c.tick < d.actionNotBeforeTick || !stockpileAccessible(c, world, pile)) return false;
  if (task.kind === 'deposit') {
    let room = Math.max(0, pile.capacity - inventorySize(pile.resources));
    for (const resource of ['food', 'wood'] as const) {
      const amount = Math.min(room, d.carry[resource]);
      pile.resources[resource] += amount; d.carry[resource] -= amount; room -= amount;
      if (amount) c.events.push(`tick ${c.tick}: ${d.name} delivered ${amount} ${resource} to ${pile.id}`);
    }
    d.deliveryRequired = inventorySize(d.carry) > 0;
  } else {
    const resource = task.kind === 'meal' ? 'food' : 'wood';
    if (pile.resources[resource] < 1 || inventorySize(d.carry) >= CARRY_CAPACITY) return false;
    if (task.kind === 'pickup' && !c.orders.some(o => o.id === task.orderId && o.status === 'pending' && o.owner === d.id)) return false;
    pile.resources[resource]--; d.carry[resource]++;
    c.events.push(`tick ${c.tick}: ${d.name} picked up 1 ${resource} from ${pile.id}`);
    d.deliveryRequired = false;
  }
  return true;
}
