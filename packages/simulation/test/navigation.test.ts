import test from 'node:test';
import assert from 'node:assert/strict';
import { addDwarf, addResourceSource, advanceTo, canMove, createColony, inWorkRange, MemoryWorld, MOVEMENT, pathToWork, queueBlock, reachable, reconcile, runHeadless, standable, step, type Colony, type Voxel } from '../src/index.ts';
import { accounting, until } from './fixtures.ts';
function corridor(length = 9, width = 1) {
  const c = createColony(7); const w = new MemoryWorld();
  c.territory = [{ min: { x: 0, y: 0, z: 0 }, max: { x: length, y: 4, z: width } }];
  for (let x = 0; x < length; x++) for (let z = 0; z < width; z++) w.set({ x, y: 0, z }, 'dirt');
  const d = addDwarf(c, 'Urist', { x: 0, y: 1, z: 0 });
  const target = { x: 6, y: 1, z: 0 };
  addResourceSource(c, target, 'food'); w.set(target, 'berries');
  return { c, w, d, target };
}
test('20 simulation ticks per second give 2.5 blocks/second and no banked instant movement', () => {
  const { c, w, d } = corridor();
  assert.equal(MOVEMENT.ticksPerSecond, 20);
  until(c, w, () => d.motion?.kind === 'move'); // First active movement tick after scheduling.
  runHeadless(c, w, 6); assert.deepEqual(d.position, { x: 0, y: 1, z: 0 }); assert.equal(d.moveTicks, 7);
  runHeadless(c, w, 1); assert.equal(d.position.x, 1); assert.equal(d.moveTicks, 0);
  runHeadless(c, w, 12); assert.equal(d.position.x, 2); assert.equal(d.moveTicks, 4);
  runHeadless(c, w, 20); assert.equal(d.position.x, 5); assert.equal(c.gathered.food, 0);
  runHeadless(c, w, 1); assert.equal(c.gathered.food, 1); accounting(c);
});
test('construction reserves no wood until arrival and takes a separate work tick', () => {
  const { c, w, d } = corridor(); c.sources = []; w.set({ x: 6, y: 1, z: 0 }, 'air'); c.resources.wood = 1;
  const order = queueBlock(c, { x: 6, y: 1, z: 0 }, 'air', 'wood');
  until(c, w, () => d.motion?.kind === 'move'); runHeadless(c, w, 38);
  assert.equal(c.resources.wood, 1); assert.equal(order.status, 'pending');
  assert.equal(order.owner, d.id); assert.equal(d.activity, 'walking');
  runHeadless(c, w, 1); assert.equal(d.position.x, 5); assert.equal(order.status, 'pending');
  step(c, w); assert.equal(order.status, 'awaiting-world'); assert.equal(c.resources.wood, 0);
  assert.equal(w.read(order.at), 'air'); reconcile(c, w); assert.equal(w.read(order.at), 'wood'); accounting(c, 1);
});
test('unreachable gathering and construction never reserve materials or emit operations', () => {
  const { c, w, d } = corridor(); w.set({ x: 3, y: 0, z: 0 }, 'air');
  c.resources.wood = 1; const order = queueBlock(c, { x: 7, y: 1, z: 0 }, 'air', 'wood');
  runHeadless(c, w, 100);
  assert.deepEqual(d.position, { x: 0, y: 1, z: 0 }); assert.equal(c.pending.length, 0);
  assert.equal(order.status, 'pending'); assert.equal(order.owner, undefined); assert.equal(c.gathered.food, 0); accounting(c, 1);
});
test('two-high clearance, solid footing, and unknown support are required', () => {
  const { w } = corridor(); const at = { x: 1, y: 1, z: 0 };
  assert.equal(standable(w, at), true);
  w.set({ ...at, y: 2 }, 'stone'); assert.equal(standable(w, at), false);
  w.set({ ...at, y: 2 }, 'air'); w.setAvailable({ ...at, y: 0 }, false);
  assert.equal(standable(w, at), false);
  w.setAvailable({ ...at, y: 0 }, true); w.set({ ...at, y: 0 }, 'berries');
  assert.equal(standable(w, at), false);
});
test('cardinal one-block steps require head clearance; gaps, diagonals and tall climbs fail', () => {
  const { w } = corridor(); const a = { x: 0, y: 1, z: 0 }; const b = { x: 1, y: 2, z: 0 };
  w.set({ x: 1, y: 1, z: 0 }, 'stone'); assert.equal(canMove(w, a, b), true); assert.equal(canMove(w, b, a), true);
  w.set({ x: 0, y: 3, z: 0 }, 'stone'); assert.equal(canMove(w, a, b), false); assert.equal(canMove(w, b, a), false);
  w.set({ x: 0, y: 3, z: 0 }, 'air');
  assert.equal(canMove(w, a, { x: 2, y: 1, z: 0 }), false);
  assert.equal(canMove(w, a, { x: 1, y: 1, z: 1 }), false);
  assert.equal(canMove(w, a, { x: 1, y: 3, z: 0 }), false);
});
test('shortest route ties are deterministic, search is bounded, and work range is local', () => {
  const { w } = corridor(6, 3); const start = { x: 0, y: 1, z: 1 }; const target = { x: 4, y: 1, z: 1 };
  w.set({ x: 1, y: 1, z: 1 }, 'stone'); w.set({ x: 1, y: 2, z: 1 }, 'stone');
  const first = pathToWork(reachable(w, start), target)!;
  assert.deepEqual(first[0], { x: 0, y: 1, z: 2 });
  assert.deepEqual(first, pathToWork(reachable(w, start), target));
  assert.equal(reachable(w, start, 3).positions.length, 3);
  assert.equal(pathToWork(reachable(w, start, 3), target), undefined);
  assert.throws(() => reachable(w, start, 0));
  assert.equal(inWorkRange(start, { x: 1, y: 3, z: 1 }), true);
  assert.equal(inWorkRange(start, { x: 1, y: 4, z: 1 }), false);
  assert.equal(inWorkRange(start, start), false);
});
test('a new obstruction invalidates a cached route and the dwarf takes a safe detour', () => {
  const { c, w, d } = corridor(9, 3); d.position.z = 1;
  until(c, w, () => d.motion?.kind === 'move'); const blocked = { ...d.path[0]! };
  w.set(blocked, 'stone'); w.set({ ...blocked, y: blocked.y + 1 }, 'stone');
  const visited: Voxel[] = [];
  for (let n = 0; n < 100 && c.gathered.food === 0; n++) {
    const before = { ...d.position }; step(c, w); reconcile(c, w); visited.push({ ...d.position });
    assert.ok(Math.abs(d.position.x - before.x) + Math.abs(d.position.z - before.z) <= 1);
    assert.notDeepEqual(d.position, blocked); assert.equal(standable(w, d.position), true);
  }
  assert.equal(c.gathered.food, 1); assert.ok(visited.some(p => p.z !== 1)); accounting(c);
});
test('unloading freezes travel and preparation, while eating/rest remain possible', () => {
  const { c, w, d } = corridor(); until(c, w, () => d.motion?.kind === 'move'); runHeadless(c, w, 2);
  const position = { ...d.position }; w.available = false;
  d.hunger = 80; c.resources.food = 1; runHeadless(c, w, 1); assert.equal(d.activity, 'eating');
  assert.equal(d.moveTicks, 0); // Unloading clears travel credit even during a needs action.
  d.tiredness = 60; runHeadless(c, w, 160);
  assert.deepEqual(d.position, position); assert.equal(d.moveTicks, 0); assert.equal(c.pending.length, 0);
  w.available = true; runHeadless(c, w, 7); assert.deepEqual(d.position, position);
  runHeadless(c, w, 1); assert.equal(d.position.x, 1); accounting(c, 0, 1);
});
test('unknown cells cannot be traversed and blocked targets can be retried after availability returns', () => {
  const { c, w, d } = corridor(); w.setAvailable({ x: 3, y: 1, z: 0 }, false);
  runHeadless(c, w, 20); assert.equal(d.position.x, 0); assert.equal(c.orders.length, 0);
  w.setAvailable({ x: 3, y: 1, z: 0 }, true); until(c, w, () => c.gathered.food === 1);
  accounting(c);
});
test('needs pause an existing route without advancing it or losing the task', () => {
  const { c, w, d } = corridor(); until(c, w, () => d.motion?.kind === 'move'); runHeadless(c, w, 1);
  const task = d.task; const path = structuredClone(d.path); const before = { ...d.position };
  d.hunger = 80; c.resources.food = 1; step(c, w);
  assert.equal(d.task, task); assert.deepEqual(d.path, path); assert.deepEqual(d.position, before); assert.equal(d.moveTicks, 0); assert.equal(d.motion?.kind, 'stop');
  runHeadless(c, w, 8); assert.equal(d.position.x, 1); accounting(c, 0, 1);
});
test('a lost route releases a walking claim so other reachable work can be chosen', () => {
  const { c, w, d } = corridor(); until(c, w, () => d.motion?.kind === 'move'); const old = d.task;
  w.set({ x: 2, y: 1, z: 0 }, 'stone'); w.set({ x: 2, y: 2, z: 0 }, 'stone');
  until(c, w, () => c.orders.find(o => o.id === old)!.status === 'cancelled');
  assert.equal(c.orders.find(o => o.id === old)!.status, 'cancelled');
  const near = { x: 0, y: 1, z: 1 }; addResourceSource(c, near, 'food'); w.set(near, 'berries');
  until(c, w, () => c.gathered.food > 0); assert.ok(c.gathered.food > 0); accounting(c);
});
test('permission revoked while walking stops the task before any placement', () => {
  const { c, w, d } = corridor(); c.sources = []; w.set({ x: 6, y: 1, z: 0 }, 'air'); c.resources.wood = 1;
  const o = queueBlock(c, { x: 6, y: 1, z: 0 }, 'air', 'wood'); until(c, w, () => d.motion?.kind === 'move');
  const position = { ...d.position }; c.territory = []; runHeadless(c, w, 10);
  assert.equal(o.status, 'blocked'); assert.deepEqual(d.position, position); assert.equal(w.read(o.at), 'air'); accounting(c, 1);
});
test('construction waits instead of placing into a dwarf, and harvest cannot remove occupied footing', () => {
  const { c, w, d, target } = corridor(); d.position = { x: 5, y: 1, z: 0 };
  c.sources = []; addResourceSource(c, target, 'wood'); w.set(target, 'wood');
  const blockAt = { x: 5, y: 1, z: 1 }; const o = queueBlock(c, blockAt, 'air', 'wood');
  step(c, w); // Harvest contribution prepared while adjacent, before another dwarf arrives.
  const other = addDwarf(c, 'Domas', { ...target, y: 2 });
  assert.equal(standable(w, other.position), true);
  reconcile(c, w); assert.equal(w.read(target), 'wood'); assert.equal(c.gathered.wood, 0);
  other.position = { x: 4, y: 1, z: 0 }; reconcile(c, w); assert.equal(c.gathered.wood, 1);
  c.sources = [];
  step(c, w); other.position = { ...blockAt }; reconcile(c, w);
  assert.equal(o.status, 'awaiting-world'); assert.equal(w.read(blockAt), 'air');
  other.position = { x: 4, y: 1, z: 0 }; reconcile(c, w); assert.equal(o.status, 'complete'); accounting(c);
});
test('mid-step position, route, task, and travel progress round-trip and replay exactly', () => {
  const a = corridor(); const b = corridor();
  until(a.c, a.w, () => a.d.motion?.kind === 'move'); until(b.c, b.w, () => b.d.motion?.kind === 'move');
  runHeadless(a.c, a.w, 14); runHeadless(b.c, b.w, 14);
  assert.equal(a.d.position.x, 1); assert.equal(a.d.moveTicks, 7);
  const restored: Colony = JSON.parse(JSON.stringify(b.c));
  advanceTo(a.c, 100, a.w);
  while (restored.tick < 100) { step(restored, b.w); reconcile(restored, b.w); }
  assert.deepEqual(a.c, restored); accounting(a.c);
  assert.throws(() => addDwarf(a.c, 'Invalid', { x: 0.5, y: 1, z: 0 }));
});
