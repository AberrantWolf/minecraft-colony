import test from 'node:test';
import assert from 'node:assert/strict';
import { createColony, addDwarf, addResourceSource, queueBlock, step, reconcile, acknowledge, runHeadless, advanceTo, MemoryWorld, type Colony, type Resource, storedResources, inventoryTotals } from '../src/index.ts';
import { setup, until, putDwarf, resourcePositions, accounting as checkAccounting } from './fixtures.ts';
function sources(c: Colony, w: MemoryWorld, resource: Resource, count: number, z = 5) {
  for (const at of resourcePositions(count, z)) {
    addResourceSource(c, at, resource); w.set(at, resource === 'wood' ? 'wood' : 'berries');
  }
}
function accounting(c: Colony, initialWood = 0, initialFood = 0) { checkAccounting(c, initialWood, initialFood); }
test('a hungry dwarf eats one meal instead of building and resumes work next tick', () => {
  const { c, w } = setup(); const d = c.dwarves[0]!;
  c.tick = 19; d.hunger = 49; c.dwarves[0]!.carry.food = 1; c.dwarves[0]!.carry.wood = 1;
  const o = queueBlock(c, { x: 0, y: 1, z: 0 }, 'air', 'wood');
  step(c, w);
  assert.equal(d.hunger, 10); assert.equal(d.activity, 'eating');
  assert.equal(c.consumedFood, 1); assert.equal(o.status, 'pending');
  step(c, w); reconcile(c, w);
  assert.equal(d.activity, 'building'); assert.equal(o.status, 'complete'); accounting(c, 1, 1);
});
test('dwarves cannot consume another dwarf\'s carried meal', () => {
  const { c, w } = setup(2); c.dwarves[0]!.carry.food = 1;
  for (const d of c.dwarves) d.hunger = 80;
  step(c, w);
  assert.equal(c.dwarves[0]!.hunger, 40); assert.equal(c.dwarves[1]!.hunger, 80);
  assert.equal(c.dwarves[1]!.activity, 'idle'); accounting(c, 0, 1);
});
test('rest takes multiple ticks, excludes construction, and resumes it when recovered', () => {
  const { c, w } = setup(); const d = c.dwarves[0]!; c.tick = 19; d.tiredness = 59; putDwarf(c, { x: 1, y: 1, z: -1 });
  c.dwarves[0]!.carry.wood = 1;
  const order = queueBlock(c, { x: 1, y: 1, z: 0 }, 'air', 'wood');
  runHeadless(c, w, 87);
  assert.equal(d.tiredness, 20); assert.equal(d.resting, false); assert.equal(d.activity, 'resting');
  assert.equal(order.status, 'pending');
  runHeadless(c, w, 1); assert.equal(order.status, 'complete'); accounting(c, 1);
});
test('eating interrupts rest without discarding the recovery goal', () => {
  const { c, w } = setup(); const d = c.dwarves[0]!;
  c.tick = 19; d.tiredness = 59; d.hunger = 47; c.dwarves[0]!.carry.food = 1;
  runHeadless(c, w, 40); assert.equal(d.tiredness, 41);
  runHeadless(c, w, 1); assert.equal(d.activity, 'eating'); assert.equal(d.resting, true);
  runHeadless(c, w, 2); assert.equal(d.activity, 'resting'); assert.equal(d.tiredness, 41);
  accounting(c, 0, 1);
});
test('eating and resting work without a world, with needs bounded during prolonged scarcity', () => {
  const { c } = setup(); const d = c.dwarves[0]!;
  d.hunger = 100; d.tiredness = 100; c.dwarves[0]!.carry.food = 1;
  step(c); assert.equal(d.activity, 'eating'); assert.equal(d.hunger, 60);
  step(c); assert.equal(d.activity, 'resting');
  for (let n = 0; n < 1000; n++) step(c);
  assert.equal(d.hunger, 100); assert.ok(d.tiredness >= 0 && d.tiredness <= 100);
  accounting(c, 0, 1);
});
test('food gathering is a confirmed removal, yields exactly once, and feeds a hungry dwarf', () => {
  const { c, w } = setup(); const d = c.dwarves[0]!; d.hunger = 70;
  sources(c, w, 'food', 1); putDwarf(c, { x: 0, y: 1, z: 4 }); step(c, w);
  assert.equal(d.activity, 'gathering'); assert.equal(storedResources(c).food, 0);
  const change = c.pending[0]!;
  assert.equal(w.read(change.at), 'berries'); assert.equal(change.next, 'air');
  const receipt = w.apply(change)!;
  acknowledge(c, receipt); acknowledge(c, receipt);
  assert.equal(c.dwarves[0]!.carry.food, 1); assert.equal(storedResources(c).food, 0); assert.equal(c.gathered.food, 1); assert.equal(w.read(change.at), 'air');
  step(c, w); assert.equal(d.activity, 'eating'); assert.equal(d.hunger, 30); accounting(c);
});
test('workers reserve distinct harvests while waiting for confirmation', () => {
  const { c, w } = setup(5); sources(c, w, 'food', 30);
  runHeadless(c, w, 200, 0);
  assert.equal(c.pending.length, 5); assert.equal(storedResources(c).food, 0);
  assert.equal(new Set(c.pending.map(p => JSON.stringify(p.at))).size, 5);
  assert.equal(c.orders.filter(o => o.kind === 'gather-block').length, 5);
  reconcile(c, w, 20); assert.equal(inventoryTotals(c).food, 5); assert.equal(storedResources(c).food, 0); accounting(c);
});
test('wood gathering unblocks construction and stops once demand is covered', () => {
  const { c, w } = setup(3); sources(c, w, 'wood', 10);
  for (let x = 0; x < 4; x++) queueBlock(c, { x, y: 1, z: 0 }, 'air', 'wood');
  until(c, w, () => c.orders.filter(o => o.kind === 'place-block' && o.status === 'complete').length === 4);
  assert.equal(c.consumedWood, 4); assert.equal(c.gathered.wood, 4); assert.equal(storedResources(c).wood, 0);
  assert.equal(c.orders.filter(o => o.kind === 'place-block' && o.status === 'complete').length, 4);
  assert.equal(w.read({ x: 4, y: 1, z: 5 }), 'wood'); accounting(c);
});
test('unavailable sources produce no harvest intentions and deferred harvest gives no resources', () => {
  const { c, w } = setup(); sources(c, w, 'food', 1); w.available = false;
  runHeadless(c, w, 5); assert.equal(c.pending.length, 0);
  w.available = true; until(c, w, () => c.pending.length === 1, 100, 0);
  w.available = false; runHeadless(c, w, 50);
  assert.equal(c.gathered.food, 0); assert.equal(storedResources(c).food, 0); assert.equal(c.pending.length, 1);
  w.available = true; reconcile(c, w); assert.equal(c.dwarves[0]!.carry.food, 1); accounting(c);
});
test('gathering respects protection, conflicts, and permission revocation without phantom yields', () => {
  for (const mode of ['protected', 'conflict', 'revoked', 'outside']) {
    const { c, w } = setup(); sources(c, w, 'food', 1); const at = c.sources[0]!.at;
    if (mode === 'outside') c.territory = [];
    putDwarf(c, { x: 0, y: 1, z: 4 }); step(c, w);
    if (mode === 'protected') w.protect(at);
    if (mode === 'conflict') w.set(at, 'stone');
    if (mode === 'revoked') c.territory = [];
    reconcile(c, w); runHeadless(c, w, 5);
    assert.equal(c.gathered.food, 0); assert.equal(storedResources(c).food, 0);
    assert.equal(w.read(at), mode === 'conflict' ? 'stone' : 'berries');
    assert.equal(c.orders.length, mode === 'outside' ? 0 : 1); accounting(c);
  }
});
test('undesignated wood, exhausted sources, and construction locations are never harvested', () => {
  const { c, w } = setup(); const at = { x: 1, y: 1, z: 0 };
  w.set(at, 'wood'); queueBlock(c, { x: 2, y: 1, z: 0 }, 'air', 'wood');
  runHeadless(c, w, 2); assert.equal(c.orders.length, 1);
  addResourceSource(c, at, 'wood'); queueBlock(c, at, 'air', 'wood');
  runHeadless(c, w, 2); assert.equal(c.orders.length, 2); assert.equal(w.read(at), 'wood');
  assert.throws(() => addResourceSource(c, at, 'wood'), /duplicate/);
  assert.throws(() => addResourceSource(c, { x: 0.5, y: 1, z: 0 }, 'food'), /integer/);
});
test('harvest selection skips hut interiors and foundations', () => {
  const { c, w } = setup(); c.dwarves[0]!.carry.wood = 1;
  c.sites = [{ x: 0, y: 1, z: 0 }];
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) w.set({ x, y: 0, z }, 'wood');
  addResourceSource(c, { x: 0, y: 0, z: 0 }, 'wood');
  step(c, w);
  const interior = { x: 1, y: 1, z: 1 };
  addResourceSource(c, interior, 'food'); w.set(interior, 'berries');
  runHeadless(c, w, 3);
  assert.equal(c.orders.filter(o => o.kind === 'gather-block').length, 0);
  assert.equal(w.read({ x: 0, y: 0, z: 0 }), 'wood');
  assert.equal(w.read(interior), 'berries'); accounting(c, 1);
});
function settlement() {
  const { c, w } = setup(5);
  c.stockpiles[0]!.at = { x: 10, y: 1, z: 4 };
  c.sites = [0, 5, 10].map(x => ({ x, y: 1, z: 0 }));
  for (let x = 0; x < 13; x++) for (let z = 0; z < 3; z++) w.set({ x, y: 0, z }, 'dirt');
  sources(c, w, 'wood', 80); sources(c, w, 'food', 100, 6);
  return { c, w };
}
test('five dwarves walk to resources and build three huts while eating and resting', () => {
  const { c, w } = settlement(); until(c, w, () => c.dwellings.length === 3, 15000);
  assert.equal(c.dwellings.length, 3); assert.ok(c.dwarves.every(d => d.home));
  assert.equal(c.consumedWood, 69); assert.equal(c.gathered.wood, 69);
  assert.ok(c.consumedFood > 0); assert.ok(c.events.some(e => e.includes('resting')));
  assert.ok(c.dwarves.every(d => d.hunger < 50 && d.tiredness < 60)); accounting(c);
});
test('needs and pending harvest survive JSON snapshots with identical tick and advanceTo replay', () => {
  const a = settlement(); const b = settlement();
  runHeadless(a.c, a.w, 220, 0); runHeadless(b.c, b.w, 220, 0);
  assert.ok(a.c.pending.some(p => p.reason.startsWith('gather')));
  b.c = JSON.parse(JSON.stringify(b.c));
  assert.ok(a.c.orders.some(o => o.status === 'awaiting-world' && o.owner));
  advanceTo(a.c, 500, a.w, 2);
  while (b.c.tick < 500) { step(b.c, b.w); reconcile(b.c, b.w, 2); }
  assert.deepEqual(a.c, b.c); accounting(a.c);
  for (const source of a.c.sources) assert.equal(a.w.read(source.at), b.w.read(source.at));
});
test('pending harvest prevents new shelter planning on its foundation', () => {
  const { c, w } = setup(); sources(c, w, 'wood', 1, 0);
  queueBlock(c, { x: 10, y: 1, z: 0 }, 'air', 'wood');
  putDwarf(c, { x: 0, y: 1, z: -1 }); step(c, w); assert.equal(c.pending[0]!.reason, 'gather wood');
  c.sites = [{ x: 0, y: 2, z: 0 }];
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) if (x !== 0 || z !== 0) w.set({ x, y: 1, z }, 'dirt');
  step(c, w); assert.equal(c.shelters.length, 0);
  reconcile(c, w); runHeadless(c, w, 2); assert.equal(c.shelters.length, 0); accounting(c);
});
test('a new construction reservation cancels a deferred harvest safely', () => {
  const { c, w } = setup(); sources(c, w, 'food', 1); putDwarf(c, { x: 0, y: 1, z: 4 }); step(c, w);
  const at = c.sources[0]!.at;
  queueBlock(c, at, 'air', 'wood'); reconcile(c, w);
  assert.equal(c.orders[0]!.status, 'blocked'); assert.equal(w.read(at), 'berries');
  assert.equal(c.gathered.food, 0); accounting(c);
});
test('needs and harvest replay deterministically across unloading and a changed source', () => {
  const a = settlement(); const b = settlement();
  for (const s of [a, b]) {
    until(s.c, s.w, () => storedResources(s.c).food > 0);
    until(s.c, s.w, () => s.c.pending.some(p => p.reason.startsWith('gather')), 1200, 0);
    s.w.available = false;
    const stock = storedResources(s.c);
    const gathered = { ...s.c.gathered };
    runHeadless(s.c, s.w, 1200, 2);
    assert.deepEqual(s.c.gathered, gathered);
    assert.deepEqual(storedResources(s.c), stock);
    assert.ok(s.c.events.some(e => e.includes('resting')));
    const harvest = s.c.orders.find(o => o.kind === 'gather-block' && o.status === 'awaiting-world')!;
    assert.ok(harvest);
    s.w.set(harvest.at, 'stone'); s.w.available = true;
  }
  b.c = JSON.parse(JSON.stringify(b.c));
  const target = a.c.tick + 1500;
  advanceTo(a.c, target, a.w, 2);
  while (b.c.tick < target) { step(b.c, b.w); reconcile(b.c, b.w, 2); }
  assert.deepEqual(a.c, b.c); accounting(a.c);
  assert.ok(a.c.orders.some(o => o.kind === 'gather-block' && o.status === 'blocked'));
  assert.ok(a.c.gathered.wood > 0);
});
