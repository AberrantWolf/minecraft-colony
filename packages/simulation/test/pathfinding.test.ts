import test from 'node:test';
import assert from 'node:assert/strict';
import { addDwarf, advanceTo, createColony, MemoryWorld, PATHFINDING, queueBlock, reconcile, runHeadless, step, type Colony } from '../src/index.ts';
import { until } from './fixtures.ts';
function crowd(count = 40) {
  const c = createColony(1); const w = new MemoryWorld();
  for (let x = 0; x < 30; x++) for (let z = 0; z < 30; z++) w.set({ x, y: 0, z }, 'dirt');
  c.territory = [{ min: { x: 0, y: 0, z: 0 }, max: { x: 29, y: 5, z: 29 } }];
  c.resources.wood = count;
  for (let n = 0; n < count; n++) {
    addDwarf(c, `Dwarf ${n}`, { x: 0, y: 1, z: 0 });
    queueBlock(c, { x: 10 + n % 5, y: 1, z: 10 + Math.floor(n / 5) }, 'air', 'wood');
  }
  return { c, w };
}
test('crowd path searches share strict start and expansion budgets, including after chunk reload', () => {
  const { c, w } = crowd();
  for (let n = 0; n < 25; n++) {
    step(c, w); assert.ok(c.pathfinding.starts <= 2); assert.ok(c.pathfinding.expanded <= 64);
  }
  assert.ok(c.pathfinding.queue.length > 0);
  const expanded = c.pathfinding.totalExpanded; w.available = false; runHeadless(c, w, 30);
  assert.equal(c.pathfinding.totalExpanded, expanded);
  w.available = true;
  for (let n = 0; n < 50; n++) {
    step(c, w); assert.ok(c.pathfinding.expanded <= PATHFINDING.nodesPerTick); assert.ok(c.pathfinding.starts <= PATHFINDING.startsPerTick);
  }
  assert.ok(c.dwarves.slice(20).some(d => (d.search?.cursor ?? 0) > 0 || d.task));
});
test('unreachable tasks use delayed staggered retries instead of a fresh graph search each frame', () => {
  const { c, w } = crowd(8);
  for (let x = 0; x < 30; x++) w.set({ x, y: 0, z: 5 }, 'air');
  until(c, w, () => c.dwarves.every(d => d.searchRetryAt > c.tick && !d.search), 200);
  const count = c.pathfinding.totalStarted;
  step(c, w); assert.equal(c.pathfinding.totalStarted, count);
  const delays = c.dwarves.map(d => d.searchRetryAt); assert.ok(new Set(delays).size > 1);
  assert.ok(count < c.tick * 8 / 4);
});
test('cached routes continue across ticks without repeating graph searches', () => {
  const { c, w } = crowd(1); until(c, w, () => c.dwarves[0]!.motion?.kind === 'move');
  const count = c.pathfinding.totalStarted; const expanded = c.pathfinding.totalExpanded;
  runHeadless(c, w, 50);
  assert.equal(c.pathfinding.totalStarted, count); assert.equal(c.pathfinding.totalExpanded, expanded);
  assert.ok(c.dwarves[0]!.position.x + c.dwarves[0]!.position.z > 0);
});
test('an adjacent job needs no graph search', () => {
  const { c, w } = crowd(1); c.orders[0]!.at = { x: 1, y: 1, z: 0 }; step(c, w); reconcile(c, w);
  assert.equal(c.orders[0]!.status, 'complete'); assert.equal(c.pathfinding.totalStarted, 0);
});
test('in-flight frontiers, scheduler order, and retries survive snapshots and deterministic replay', () => {
  const a = crowd(8); const b = crowd(8); runHeadless(a.c, a.w, 5); runHeadless(b.c, b.w, 5);
  assert.ok(a.c.pathfinding.queue.length > 0); assert.ok(a.c.dwarves[0]!.search!.cursor > 0);
  const restored: Colony = JSON.parse(JSON.stringify(b.c));
  advanceTo(a.c, 250, a.w);
  while (restored.tick < 250) { step(restored, b.w); reconcile(restored, b.w); }
  assert.deepEqual(a.c, restored);
});
