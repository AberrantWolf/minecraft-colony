import { key, permitted, type Colony, type Dwarf, type Voxel, type Block, type WorkOrder, type WorldPort, type Change, type ChangeResult, type MovementMode } from './types.ts';
import { gather, hasGatherWork, meetNeeds, NEEDS, reservedForBuilding } from './needs.ts';
import { canMove, navigationObstacles, inWorkRange, MOVEMENT, occupied, pathToWork, requestReachable, servicePathSearches, solid, standable, supportsDwarf, type Reachable } from './navigation.ts';

import { assignDeposit, assignMeal, inventorySize, stockpileAccessible, stockpileObserved, stockpileOccupies, transferAtStockpile } from './stockpiles.ts';
import { beginMovement, stopMovement } from './movement.ts';

export function createColony(seed = 1, movementMode: MovementMode = 'headless'): Colony {
  return { version: 6, movementMode, pathfinding: { queue: [], starts: 0, startedTick: 0, expanded: 0, totalExpanded: 0, totalStarted: 0 }, tick: 0, nextId: 1, rng: seed >>> 0, dwarves: [], dwellings: [], orders: [], pending: [], shelters: [], territory: [], sites: [], stockpiles: [], consumedWood: 0, sources: [], gathered: { wood: 0, food: 0 }, consumedFood: 0, reconciliationCursor: 0, events: [] };
}
const log = (c: Colony, message: string): void => { c.events.push(`tick ${c.tick}: ${message}`); };
export function addDwarf(c: Colony, name: string, position: Voxel = { x: 0, y: 1, z: -1 }): Dwarf {
  if (![position.x, position.y, position.z].every(Number.isSafeInteger)) throw new Error('spawn coordinates must be safe integers');
  const dwarf: Dwarf = { id: `d${c.nextId++}`, name, hunger: 0, tiredness: 0, activity: 'idle', resting: false, position: { ...position }, path: [], moveTicks: 0, positionKnown: true, motionRevision: 0, lastMotionSequence: 0, actionNotBeforeTick: 0, searchRetryAt: 0, carry: { wood: 0, food: 0 }, deliveryRequired: false };
  c.dwarves.push(dwarf); return dwarf;
}
export function queueBlock(c: Colony, at: Voxel, expected: Block, block: Block, project?: string): WorkOrder {
  const order: WorkOrder = { id: `o${c.nextId++}`, kind: 'place-block', status: 'pending', at: { ...at }, expected, block, reserved: false, ...(project ? { project } : {}) };
  c.orders.push(order); return order;
}
/** 3x3 hut: two-high perimeter, a doorway, and roof; capacity two. */
export function shelterPlan(origin: Voxel): Voxel[] {
  const blocks: Voxel[] = [];
  for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) {
    if (y < 2 && (x === 1 && z === 1 || x === 1 && z === 0)) continue;
    blocks.push({ x: origin.x + x, y: origin.y + y, z: origin.z + z });
  }
  return blocks;
}
function random(c: Colony): number {
  c.rng = (Math.imul(c.rng, 1664525) + 1013904223) >>> 0; return c.rng;
}
/** Planning requires an explicit current observation, including support and interior. */
function planShelters(c: Colony, world: WorldPort): void {
  const capacity = c.shelters.filter(s => s.status !== 'suspended').length * 2;
  if (capacity >= c.dwarves.length) return;
  const reserved = new Set(c.shelters.flatMap(s => shelterPlan(s.origin).map(key)));
  const candidates = c.sites.filter(site => {
    if (c.stockpiles.some(s => s.at.x >= site.x && s.at.x <= site.x + 2 && s.at.z >= site.z && s.at.z <= site.z + 2 && s.at.y >= site.y - 1 && s.at.y <= site.y + 3)) return false;
    if (c.orders.some(o => o.kind === 'gather-block' && (o.status === 'pending' || o.status === 'awaiting-world')
      && o.at.x >= site.x && o.at.x <= site.x + 2 && o.at.z >= site.z && o.at.z <= site.z + 2
      && o.at.y >= site.y - 1 && o.at.y <= site.y + 2)) return false;
    const plan = shelterPlan(site);
    if (plan.some(at => !permitted(c, at) || reserved.has(key(at)) || stockpileOccupies(c, at))) return false;
    for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) {
      const support = world.read({ x: site.x + x, y: site.y - 1, z: site.z + z });
      if (support === undefined || support === 'air') return false;
      for (let y = 0; y < 3; y++) if (world.read({ x: site.x + x, y: site.y + y, z: site.z + z }) !== 'air') return false;
    }
    return true;
  });
  if (!candidates.length) return;
  const origin = { ...candidates[random(c) % candidates.length]! };
  const id = `s${c.nextId++}`;
  const orders = shelterPlan(origin).map(at => queueBlock(c, at, 'air', 'wood', id).id);
  c.shelters.push({ id, origin, orders, status: 'building' });
  log(c, `colony needs shelter; planned rough hut ${id}`);
}
function updateShelters(c: Colony): void {
  for (const s of c.shelters) {
    if (s.status !== 'building') continue;
    if (!s.orders.every(id => c.orders.find(o => o.id === id)?.status === 'complete')) continue;
    s.status = 'complete';
    const occupied = c.dwarves.filter(d => !d.home).slice(0, 2);
    for (const dwarf of occupied) dwarf.home = s.id;
    c.dwellings.push({ id: s.id, capacity: 2, quality: 1, occupied: occupied.map(d => d.id) });
    log(c, `hut ${s.id} confirmed; housed ${occupied.map(d => d.name).join(', ')}`);
  }
}
function releaseTask(c: Colony, dwarf: Dwarf): void {
  const order = c.orders.find(o => o.id === dwarf.task && o.status === 'pending');
  if (order) {
    if (order.kind === 'gather-block') order.status = 'cancelled';
    delete order.owner;
  }
  if (dwarf.task && inventorySize(dwarf.carry) > 0) dwarf.deliveryRequired = true;
  delete dwarf.haul; delete dwarf.task; dwarf.path = []; stopMovement(c, dwarf, 'task released');
}
function assignWork(c: Colony, dwarf: Dwarf, world: WorldPort, search: Reachable): boolean {
  if (dwarf.deliveryRequired && inventorySize(dwarf.carry) > 0) return assignDeposit(c, dwarf, world, search);
  if (dwarf.hunger >= NEEDS.hungry && dwarf.carry.food === 0 && assignMeal(c, dwarf, world, search)) return true;
  if (gather(c, dwarf, world, search)) return true;
  for (const order of c.orders) {
    if (order.kind !== 'place-block' || order.status !== 'pending' || order.owner || !permitted(c, order.at)
      || stockpileOccupies(c, order.at) || occupied(c, order.at) || world.read(order.at) === undefined) continue;
    const workPath = pathToWork(search, order.at);
    if (!workPath) continue;
    if (order.block === 'wood' && dwarf.carry.wood === 0) {
      const pile = c.stockpiles.find(s => stockpileAccessible(c, world, s) && s.resources.wood > 0 && pathToWork(search, s.at) !== undefined);
      if (!pile) continue;
      dwarf.path = pathToWork(search, pile.at)!;
      dwarf.haul = { kind: 'pickup', stockpileId: pile.id, orderId: order.id, ...(dwarf.path.length === 0 ? { workPath } : {}) };
    } else dwarf.path = workPath;
    dwarf.searchRetryAt = 0; order.owner = dwarf.id; dwarf.task = order.id;
    return true;
  }
  return false;
}
/** One worker chooses one action per tick. Physical work remains provisional. */
export function step(c: Colony, world?: WorldPort): Change[] {
  if (!Number.isSafeInteger(c.tick + 1)) throw new Error('simulation clock overflow');
  c.tick++;
  if (c.tick % NEEDS.ticksPerNeedPoint === 0) {
    for (const d of c.dwarves) { d.hunger = Math.min(100, d.hunger + 1); d.tiredness = Math.min(100, d.tiredness + 1); }
  }
  if (world) planShelters(c, world);
  const forbidden = navigationObstacles(c);
  if (world) servicePathSearches(c, world, forbidden);
  else { c.pathfinding.expanded = 0; c.pathfinding.starts = 0; c.pathfinding.startedTick = c.tick; }
  for (const dwarf of c.dwarves) {
    const canStand = dwarf.positionKnown && world !== undefined && standable(world, dwarf.position);
    if (!canStand) stopMovement(c, dwarf, 'terrain or position unavailable');
    if (meetNeeds(c, dwarf)) { stopMovement(c, dwarf, 'needs'); continue; }
    dwarf.activity = 'idle';
    if (!world || !canStand || c.tick < dwarf.actionNotBeforeTick) continue;
    // One outstanding physical contribution per worker reserves space for its yield/refund.
    if (c.orders.some(o => o.owner === dwarf.id && o.status === 'awaiting-world')) continue;
    let order = c.orders.find(o => o.id === dwarf.task && o.status === 'pending');
    if (dwarf.task && !order) releaseTask(c, dwarf);
    if (order && (!permitted(c, order.at) || stockpileOccupies(c, order.at) || order.kind === 'gather-block' && reservedForBuilding(c, order.at))) {
      order.status = 'awaiting-world';
      acknowledge(c, { id: order.id, applied: false, reason: 'permission or reserved location changed' });
      releaseTask(c, dwarf); order = undefined;
    }
    if (dwarf.haul) {
      const pile = c.stockpiles.find(s => s.id === dwarf.haul!.stockpileId);
      if (pile && pile.enabled && permitted(c, pile.at) && !stockpileObserved(world, pile)) {
        stopMovement(c, dwarf, 'stockpile unavailable'); continue;
      }
      if (!pile || !stockpileAccessible(c, world, pile)
        || dwarf.haul.kind === 'pickup' && pile.resources.wood === 0
        || dwarf.haul.kind === 'meal' && pile.resources.food === 0
        || dwarf.haul.kind === 'deposit' && inventorySize(dwarf.carry) > 0 && inventorySize(pile.resources) >= pile.capacity) {
        releaseTask(c, dwarf); order = undefined;
      }
    }
    if (order && order.block === 'wood' && dwarf.carry.wood === 0 && dwarf.haul?.kind !== 'pickup') { releaseTask(c, dwarf); order = undefined; }
    if (!order && !dwarf.haul) {
      releaseTask(c, dwarf);
      const supplies = c.stockpiles.some(s => stockpileAccessible(c, world, s)
        && (s.resources.food > 0 && dwarf.hunger >= NEEDS.hungry || s.resources.wood > 0 && c.orders.some(o => o.kind === 'place-block' && o.block === 'wood' && o.status === 'pending' && !o.owner && permitted(c, o.at))));
      if (!dwarf.deliveryRequired && !hasGatherWork(c, world) && !supplies && !c.orders.some(o => o.kind === 'place-block' && o.status === 'pending' && !o.owner
        && permitted(c, o.at) && (o.block !== 'wood' || dwarf.carry.wood > 0))) continue;
      const local: Reachable = { positions: [dwarf.position], parents: new Map([[key(dwarf.position), undefined]]) };
      if (assignWork(c, dwarf, world, local)) delete dwarf.search;
      else {
        const search = requestReachable(c, dwarf, world);
        if (!search) continue;
        assignWork(c, dwarf, world, search);
      }
      order = c.orders.find(o => o.id === dwarf.task && o.status === 'pending');
    }
    const target = dwarf.haul ? c.stockpiles.find(s => s.id === dwarf.haul!.stockpileId)?.at : order?.at;
    if (!target) continue;
    if ((!dwarf.path.length && !inWorkRange(dwarf.position, target))
      || dwarf.path.length && !canMove(world, dwarf.position, dwarf.path[0]!, forbidden)) {
      stopMovement(c, dwarf, 'route changed');
      const search = requestReachable(c, dwarf, world);
      if (!search) continue;
      const path = pathToWork(search, target);
      if (!path) { releaseTask(c, dwarf); continue; }
      dwarf.path = path; dwarf.searchRetryAt = 0;
    }
    if (dwarf.path.length) {
      dwarf.activity = 'walking'; beginMovement(c, dwarf);
      dwarf.moveTicks = Math.min(MOVEMENT.ticksPerBlock, dwarf.moveTicks + 1);
      if (c.movementMode === 'headless' && dwarf.moveTicks >= MOVEMENT.ticksPerBlock) {
        dwarf.position = { ...dwarf.path.shift()! }; stopMovement(c, dwarf, 'arrived');
      }
      continue; // Arrival and work never happen in the same simulation tick.
    }
    if (!inWorkRange(dwarf.position, target) || world.read(target) === undefined) continue;
    if (dwarf.haul) {
      const haul = dwarf.haul;
      if (transferAtStockpile(c, dwarf, world)) {
        dwarf.activity = 'hauling';
        delete dwarf.haul; dwarf.path = haul.kind === 'pickup' ? haul.workPath ?? [] : [];
        delete dwarf.search; dwarf.searchRetryAt = 0; stopMovement(c, dwarf, 'stockpile transfer');
      } else releaseTask(c, dwarf);
      continue;
    }
    if (!order) continue;
    if (order.kind === 'place-block' && occupied(c, order.at)) { releaseTask(c, dwarf); continue; }
    dwarf.activity = order.kind === 'gather-block' ? 'gathering' : 'building';
    if (order.block === 'wood') { dwarf.carry.wood--; order.reserved = true; }
    order.status = 'awaiting-world';
    c.pending.push({ id: order.id, at: { ...order.at }, expected: order.expected, next: order.block,
      reason: order.kind === 'gather-block' ? `gather ${order.yield}` : 'construction' });
    log(c, `${dwarf.name} prepared ${order.id} (provisional)`);
    delete dwarf.task; dwarf.path = []; dwarf.moveTicks = 0;
  }
  return c.pending.map(p => ({ ...p, at: { ...p.at } }));
}
function refund(c: Colony, o: WorkOrder): void {
  if (o.reserved) {
    const owner = c.dwarves.find(d => d.id === o.owner)!; owner.carry.wood++; owner.deliveryRequired = true; o.reserved = false;
  }
}
/** Conflicts suspend the project, preserve confirmed blocks, and release unused materials. */
export function acknowledge(c: Colony, result: ChangeResult): void {
  const order = c.orders.find(o => o.id === result.id);
  if (!order || order.status !== 'awaiting-world') return;
  order.status = result.applied ? 'complete' : 'blocked';
  if (result.applied) {
    if (order.reserved) c.consumedWood++;
    order.reserved = false;
    if (order.kind === 'gather-block' && order.yield) {
      const owner = c.dwarves.find(d => d.id === order.owner)!;
      owner.carry[order.yield]++; owner.deliveryRequired = true; c.gathered[order.yield]++;
      log(c, `gathered 1 ${order.yield} from ${order.id}`);
    }
  }
  else refund(c, order);
  c.pending = c.pending.filter(p => p.id !== order.id);
  log(c, `${order.id} ${order.status}${result.reason ? `: ${result.reason}` : ''}`);
  if (!result.applied && order.project) {
    const shelter = c.shelters.find(s => s.id === order.project)!;
    shelter.status = 'suspended';
    for (const o of c.orders.filter(o => o.project === order.project && (o.status === 'pending' || o.status === 'awaiting-world'))) {
      refund(c, o); o.status = 'cancelled';
    }
    c.pending = c.pending.filter(p => c.orders.find(o => o.id === p.id)?.status === 'awaiting-world');
    log(c, `hut ${shelter.id} suspended; confirmed work preserved`);
  }
  updateShelters(c);
}
/** Budget counts attempts, including unavailable terrain. Round robin prevents starvation. */
export function reconcile(c: Colony, world: WorldPort, budget = 4): number {
  validateCount(budget, 'budget');
  if (c.dwarves.some(d => !d.positionKnown)) return 0;
  const ids = c.pending.map(p => p.id);
  if (!ids.length) return 0;
  const start = c.reconciliationCursor % ids.length;
  const count = Math.min(budget, ids.length);
  for (let n = 0; n < count; n++) {
    const id = ids[(start + n) % ids.length]!;
    const change = c.pending.find(p => p.id === id);
    if (!change) continue;
    const order = c.orders.find(o => o.id === id)!;
    if (order.kind === 'place-block' && occupied(c, change.at)) continue;
    if (!solid(change.next) && supportsDwarf(c, change.at)) continue;
    const denial = !permitted(c, change.at) ? 'permission revoked'
      : stockpileOccupies(c, change.at) ? 'reserved for stockpile'
        : order.kind === 'gather-block' && reservedForBuilding(c, change.at) ? 'reserved for construction' : undefined;
    const result = denial ? { id, applied: false, reason: denial } : world.apply(change);
    if (result) acknowledge(c, result);
  }
  const nextId = ids[(start + count) % ids.length];
  const nextIndex = c.pending.findIndex(p => p.id === nextId);
  c.reconciliationCursor = nextIndex >= 0 ? nextIndex : 0;
  return count;
}
function validateCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
}
export function advanceTo(c: Colony, targetTick: number, world: WorldPort, budget = 4): void {
  validateCount(targetTick, 'targetTick'); validateCount(budget, 'budget');
  if (targetTick < c.tick) throw new Error('cannot reverse simulation time');
  while (c.tick < targetTick) { step(c, world); reconcile(c, world, budget); }
}
export function runHeadless(c: Colony, world: WorldPort, ticks: number, budget = 4): void {
  validateCount(ticks, 'ticks'); advanceTo(c, c.tick + ticks, world, budget);
}
export const tick = step;
