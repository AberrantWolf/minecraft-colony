import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledge, addDwarf, addResourceSource, addStockpile, advanceTo, createColony, inventorySize, inventoryTotals, MemoryWorld, observeMovement, queueBlock, reconcile, runHeadless, step, storedResources, type Colony, type MovementMode } from '../src/index.ts';
import { accounting, until } from './fixtures.ts';
function fixture(count = 1, movementMode: MovementMode = 'headless') {
  const c = createColony(17, movementMode); const w = new MemoryWorld();
  c.territory = [{ min: { x: 0, y: 0, z: 0 }, max: { x: 12, y: 5, z: 5 } }];
  for (let x = 0; x <= 12; x++) for (let z = 0; z <= 5; z++) w.set({ x, y: 0, z }, 'dirt');
  const pile = addStockpile(c, { x: 1, y: 1, z: 2 }, 16);
  for (let n = 0; n < count; n++) addDwarf(c, `Dwarf ${n}`, { x: 0, y: 1, z: 0 });
  return { c, w, pile, d: c.dwarves[0]! };
}
test('confirmed harvest goes to hands, then storage, then is picked up and carried to construction', () => {
  const { c, w, pile, d } = fixture(); const at = { x: 7, y: 1, z: 0 };
  addResourceSource(c, at, 'wood'); w.set(at, 'wood');
  const order = queueBlock(c, { x: 10, y: 1, z: 2 }, 'air', 'wood');
  until(c, w, () => c.gathered.wood === 1);
  assert.equal(d.carry.wood, 1); assert.equal(pile.resources.wood, 0); assert.equal(d.deliveryRequired, true); accounting(c);
  const harvestedAt = c.tick;
  until(c, w, () => pile.resources.wood === 1);
  assert.ok(c.tick > harvestedAt); assert.equal(d.carry.wood, 0); assert.equal(order.status, 'pending');
  until(c, w, () => d.carry.wood === 1 && !d.deliveryRequired);
  assert.equal(pile.resources.wood, 0); assert.equal(order.status, 'pending'); assert.equal(order.reserved, false); accounting(c);
  const pickup = c.tick;
  until(c, w, () => order.status === 'complete');
  assert.ok(c.tick > pickup + 8); assert.equal(w.read(order.at), 'wood'); assert.equal(d.carry.wood, 0); accounting(c);
  const delivery = c.events.findIndex(e => e.includes('delivered 1 wood'));
  const withdraw = c.events.findIndex(e => e.includes('picked up 1 wood'));
  const prepared = c.events.findIndex(e => e.includes(`prepared ${order.id}`));
  assert.ok(delivery < withdraw && withdraw < prepared);
});
test('gathered wood cannot bypass an unreachable stockpile even when the build site is adjacent', () => {
  const { c, w, d } = fixture(); d.position = { x: 6, y: 1, z: 0 };
  for (let z = 0; z <= 5; z++) w.set({ x: 3, y: 0, z }, 'air');
  const source = { x: 7, y: 1, z: 0 }; addResourceSource(c, source, 'wood'); w.set(source, 'wood');
  const order = queueBlock(c, { x: 6, y: 1, z: 1 }, 'air', 'wood');
  runHeadless(c, w, 300);
  assert.equal(c.gathered.wood, 1); assert.equal(d.carry.wood, 1); assert.equal(storedResources(c).wood, 0);
  assert.equal(order.status, 'pending'); assert.equal(c.consumedWood, 0); accounting(c);
});
test('multiple builders cannot withdraw the same last plank', () => {
  const { c, w, pile } = fixture(2); pile.resources.wood = 1;
  for (let n = 0; n < 2; n++) queueBlock(c, { x: 8 + n, y: 1, z: 2 }, 'air', 'wood');
  until(c, w, () => c.dwarves.some(d => d.carry.wood === 1));
  assert.equal(pile.resources.wood, 0); assert.equal(c.dwarves.reduce((sum, d) => sum + d.carry.wood, 0), 1); accounting(c, 1);
  runHeadless(c, w, 400);
  assert.equal(c.consumedWood, 1); assert.equal(c.orders.filter(o => o.status === 'complete').length, 1); accounting(c, 1);
});
test('capacity contention leaves excess cargo in hands and an alternate stockpile receives it', () => {
  const { c, w, pile } = fixture(2); pile.capacity = 1;
  for (const d of c.dwarves) { d.position = { x: 0, y: 1, z: 2 }; d.carry.wood = 1; d.deliveryRequired = true; }
  step(c, w);
  assert.equal(pile.resources.wood, 1); assert.equal(c.dwarves.reduce((sum, d) => sum + d.carry.wood, 0), 1); accounting(c, 2);
  runHeadless(c, w, 50); assert.equal(pile.resources.wood, 1); accounting(c, 2);
  const other = addStockpile(c, { x: 5, y: 1, z: 2 }, 1);
  until(c, w, () => other.resources.wood === 1);
  assert.equal(storedResources(c).wood, 2); assert.ok(c.dwarves.every(d => inventorySize(d.carry) === 0)); accounting(c, 2);
});
test('unavailable, disabled, obstructed, or revoked storage cannot receive cargo', () => {
  for (const mode of ['unavailable', 'disabled', 'obstructed', 'revoked']) {
    const { c, w, pile, d } = fixture(); d.carry.wood = 1; d.deliveryRequired = true;
    if (mode === 'unavailable') w.setAvailable(pile.at, false);
    if (mode === 'disabled') pile.enabled = false;
    if (mode === 'obstructed') w.set(pile.at, 'stone');
    if (mode === 'revoked') c.territory = [];
    runHeadless(c, w, 100);
    assert.equal(d.carry.wood, 1); assert.equal(pile.resources.wood, 0); accounting(c, 1);
    if (mode === 'obstructed') assert.equal(w.read(pile.at), 'stone');
  }
});
test('unavailable storage cannot supply wood, while an already loaded carrier retains its material', () => {
  const { c, w, pile, d } = fixture(); pile.resources.wood = 1;
  const order = queueBlock(c, { x: 10, y: 1, z: 2 }, 'air', 'wood');
  w.setAvailable(pile.at, false); runHeadless(c, w, 100);
  assert.equal(d.carry.wood, 0); assert.equal(pile.resources.wood, 1); assert.equal(order.status, 'pending'); accounting(c, 1);
  w.setAvailable(pile.at, true); until(c, w, () => d.carry.wood === 1);
  w.setAvailable(pile.at, false); until(c, w, () => order.status === 'complete'); accounting(c, 1);
});
test('a terrain conflict refunds the plank to its carrier, which physically returns it to storage', () => {
  const { c, w, pile, d } = fixture(); pile.resources.wood = 1;
  const order = queueBlock(c, { x: 10, y: 1, z: 2 }, 'air', 'wood');
  until(c, w, () => order.status === 'awaiting-world', 2000, 0);
  assert.equal(pile.resources.wood, 0); assert.equal(d.carry.wood, 0); assert.equal(order.reserved, true); accounting(c, 1);
  w.set(order.at, 'stone'); reconcile(c, w);
  assert.equal(order.status, 'blocked'); assert.equal(d.carry.wood, 1); assert.equal(d.deliveryRequired, true); assert.equal(pile.resources.wood, 0);
  const tick = c.tick; until(c, w, () => pile.resources.wood === 1);
  assert.ok(c.tick > tick + 8); assert.equal(w.read(order.at), 'stone'); assert.equal(c.consumedWood, 0); accounting(c, 1);
});
test('project suspension preserves loaded and escrowed material and returns both without teleporting', () => {
  const { c, w, pile } = fixture(2); pile.resources.wood = 2;
  const orders = [0, 1].map(n => queueBlock(c, { x: 9 + n, y: 1, z: 2 }, 'air', 'wood', 'hut'));
  c.shelters.push({ id: 'hut', origin: { x: 9, y: 1, z: 2 }, orders: orders.map(o => o.id), status: 'building' });
  until(c, w, () => pile.resources.wood === 0);
  until(c, w, () => c.pending.length > 0, 2000, 0);
  const change = c.pending[0]!; w.set(change.at, 'stone'); reconcile(c, w);
  assert.equal(c.shelters[0]!.status, 'suspended'); assert.equal(pile.resources.wood, 0); accounting(c, 2);
  until(c, w, () => pile.resources.wood === 2);
  assert.equal(c.consumedWood, 0); assert.equal(w.read(change.at), 'stone'); accounting(c, 2);
});
test('one outstanding contribution reserves carry room for yields and duplicate acknowledgements do not duplicate cargo', () => {
  const { c, w, d } = fixture(); d.position = { x: 6, y: 1, z: 0 }; d.carry.wood = 3;
  const at = { x: 7, y: 1, z: 0 }; addResourceSource(c, at, 'food'); w.set(at, 'berries');
  step(c, w); assert.equal(c.pending.length, 1); const change = c.pending[0]!;
  runHeadless(c, w, 100, 0); assert.equal(c.pending.length, 1); assert.equal(d.carry.food, 0);
  const result = w.apply(change)!;
  acknowledge(c, result); acknowledge(c, result);
  assert.equal(inventorySize(d.carry), 4); assert.equal(c.gathered.food, 1); assert.equal(d.deliveryRequired, true); accounting(c, 3);
});
test('food must be carried or fetched at reachable storage before a hungry dwarf can eat it', () => {
  const { c, w, pile, d } = fixture(); pile.at = { x: 8, y: 1, z: 2 }; pile.resources.food = 1; d.hunger = 80;
  step(c, w); assert.equal(c.consumedFood, 0); assert.equal(pile.resources.food, 1);
  until(c, w, () => d.carry.food === 1);
  assert.equal(c.consumedFood, 0); assert.equal(pile.resources.food, 0);
  step(c, w); assert.equal(c.consumedFood, 1); assert.equal(d.carry.food, 0); accounting(c, 0, 1);
});
test('adapter-mode hauling waits for arrival and a correction replans without losing cargo', () => {
  const { c, w, pile, d } = fixture(1, 'adapter'); pile.at = { x: 8, y: 1, z: 2 }; d.carry.wood = 1; d.deliveryRequired = true;
  until(c, w, () => d.motion?.kind === 'move'); runHeadless(c, w, 100);
  assert.equal(pile.resources.wood, 0); assert.equal(d.carry.wood, 1);
  const stale = d.motionRevision;
  observeMovement(c, { dwarfId: d.id, revision: stale, sequence: 1, kind: 'corrected', position: { x: 2, y: 1, z: 0 } });
  assert.equal(d.carry.wood, 1); assert.equal(d.path.length, 0);
  assert.equal(observeMovement(c, { dwarfId: d.id, revision: stale, sequence: 2, kind: 'arrived', position: { x: 1, y: 1, z: 0 } }), false);
  for (let n = 0; n < 500 && pile.resources.wood === 0; n++) {
    step(c, w);
    if (d.motion?.kind === 'move' && d.moveTicks === 8) observeMovement(c, { dwarfId: d.id, revision: d.motionRevision, sequence: d.lastMotionSequence + 1, kind: 'arrived', position: d.motion.to });
    assert.ok(c.pathfinding.starts <= 2 && c.pathfinding.expanded <= 64);
  }
  assert.equal(pile.resources.wood, 1); assert.equal(d.carry.wood, 0); accounting(c, 1);
});
test('in-transit inventory and stockpile phases survive snapshots, unloads, and deterministic replay', () => {
  const a = fixture(); const b = fixture();
  for (const s of [a, b]) {
    s.pile.resources.wood = 1; queueBlock(s.c, { x: 10, y: 1, z: 2 }, 'air', 'wood');
    until(s.c, s.w, () => s.d.carry.wood === 1);
    s.w.available = false; const at = { ...s.d.position }; runHeadless(s.c, s.w, 50);
    assert.deepEqual(s.d.position, at); assert.equal(s.d.carry.wood, 1); accounting(s.c, 1);
    s.w.available = true;
  }
  const restored: Colony = JSON.parse(JSON.stringify(b.c));
  advanceTo(a.c, 1000, a.w);
  while (restored.tick < 1000) { step(restored, b.w); reconcile(restored, b.w); }
  assert.deepEqual(a.c, restored); assert.equal(a.c.consumedWood, 1); accounting(a.c, 1);
});
test('stockpile registration rejects invalid or overlapping locations and construction preserves storage', () => {
  const { c, w, pile, d } = fixture();
  assert.throws(() => addStockpile(c, pile.at), /overlap/);
  assert.throws(() => addStockpile(c, { x: 0.5, y: 1, z: 0 }), /invalid/);
  assert.throws(() => addStockpile(c, { x: 3, y: 1, z: 2 }, 0), /invalid/);
  assert.throws(() => addStockpile(c, { x: 3, y: 1, z: 2 }, 1, { wood: 2, food: 0 }), /invalid/);
  assert.throws(() => addStockpile(c, { x: 50, y: 1, z: 0 }), /territory/);
  assert.throws(() => addResourceSource(c, { ...pile.at, y: 0 }, 'wood'), /stockpile/);
  c.sites = [{ x: 0, y: 1, z: 1 }]; runHeadless(c, w, 1); assert.equal(c.shelters.length, 0);
  d.carry.wood = 1; const order = queueBlock(c, pile.at, 'air', 'wood'); runHeadless(c, w, 100);
  assert.notEqual(order.status, 'complete'); assert.equal(w.read(pile.at), 'air'); accounting(c, 1);
  assert.deepEqual(inventoryTotals(c), { wood: 1, food: 0 });
});
test('a stockpile unloading mid-trip preserves cargo, haul phase and cached route until reload', () => {
  const { c, w, pile, d } = fixture(); pile.at = { x: 8, y: 1, z: 2 }; d.carry.wood = 1; d.deliveryRequired = true;
  until(c, w, () => d.motion?.kind === 'move');
  const route = structuredClone(d.path); const at = { ...d.position }; const haul = structuredClone(d.haul);
  w.setAvailable(pile.at, false); runHeadless(c, w, 100);
  assert.deepEqual(d.position, at); assert.deepEqual(d.path, route); assert.deepEqual(d.haul, haul);
  assert.equal(d.carry.wood, 1); assert.equal(pile.resources.wood, 0); accounting(c, 1);
  w.setAvailable(pile.at, true); until(c, w, () => pile.resources.wood === 1); accounting(c, 1);
});
test('gatherers reuse a valid known return route without starting another graph search', () => {
  const { c, w, pile } = fixture(); const at = { x: 7, y: 1, z: 0 };
  addResourceSource(c, at, 'wood'); w.set(at, 'wood'); queueBlock(c, { x: 10, y: 1, z: 2 }, 'air', 'wood');
  until(c, w, () => c.gathered.wood === 1);
  const searches = c.pathfinding.totalStarted;
  until(c, w, () => pile.resources.wood === 1);
  assert.equal(c.pathfinding.totalStarted, searches); accounting(c);
});
