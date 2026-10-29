import test from 'node:test';
import assert from 'node:assert/strict';
import { createColony, addDwarf, queueBlock, step, tick, acknowledge, reconcile, runHeadless, advanceTo, MemoryWorld, shelterPlan, type Colony } from '../src/index.ts';
import { setup as baseSetup, until, putDwarf } from './fixtures.ts';
function setup(count = 5) {
  const { c, w } = baseSetup(count);
  c.sites = [0, 5, 10].map(x => ({ x, y: 1, z: 0 }));
  c.resources.wood = 80;
  return { c, w };
}
function accounting(c: Colony, initial = 80) {
  assert.equal(c.resources.wood + c.consumedWood + c.orders.filter(o => o.reserved).length, initial);
  assert.ok(c.resources.wood >= 0);
}
test('five dwarves autonomously construct three supported huts and receive homes', () => {
  const { c, w } = setup(); until(c, w, () => c.dwellings.length === 3);
  assert.equal(c.dwellings.length, 3); assert.ok(c.dwarves.every(d => d.home));
  assert.equal(c.consumedWood, 3 * shelterPlan(c.sites[0]!).length);
  for (const s of c.shelters) for (const at of shelterPlan(s.origin)) assert.equal(w.read(at), 'wood');
  accounting(c);
});
test('work remains provisional without acknowledgement, even when the target already matches', () => {
  const { c, w } = setup(1); c.sites = [];
  const o = queueBlock(c, { x: 1, y: 1, z: 1 }, 'air', 'wood'); putDwarf(c, { x: 1, y: 1, z: 0 }); step(c, w);
  assert.equal(o.status, 'awaiting-world'); assert.equal(w.read(o.at), 'air');
  w.set(o.at, 'wood'); reconcile(c, w);
  assert.equal(o.status, 'blocked'); accounting(c);
});
test('unavailable terrain is unknown and cannot authorize a plan', () => {
  const { c, w } = setup(); w.available = false; runHeadless(c, w, 10);
  assert.equal(w.read(c.sites[0]!), undefined); assert.equal(c.shelters.length, 0);
  w.available = true; runHeadless(c, w, 1); assert.equal(c.shelters.length, 1);
});
test('offline work is bounded by wood and never becomes realized housing', () => {
  const { c, w } = setup(); until(c, w, () => c.pending.length > 0, 200, 0); w.available = false;
  const consumed = c.consumedWood; const before = c.dwarves[0]!.hunger;
  runHeadless(c, w, 30);
  assert.equal(c.consumedWood, consumed); assert.equal(c.dwellings.length, 0);
  assert.ok(c.pending.length > 0); assert.ok(c.dwarves[0]!.hunger > before); accounting(c);
  w.available = true; until(c, w, () => c.dwellings.length === 3); assert.equal(c.dwellings.length, 3); accounting(c);
});
test('conflict after unloading preserves partial work, refunds reservations, and permits other huts', () => {
  const { c, w } = setup(); until(c, w, () => c.orders.filter(o => o.status === 'complete').length >= 5);
  until(c, w, () => c.pending.length > 0, 100, 0); w.available = false; runHeadless(c, w, 12);
  const target = c.pending[0]!;
  const project = c.orders.find(o => o.id === target.id)!.project!;
  const complete = c.orders.filter(o => o.project === project && o.status === 'complete');
  assert.ok(complete.length > 0);
  w.set(target.at, 'stone'); w.available = true; until(c, w, () => c.dwellings.length === 2, 2000, 2);
  assert.equal(w.read(target.at), 'stone');
  assert.equal(c.shelters.find(s => s.id === project)!.status, 'suspended');
  for (const o of complete) assert.equal(w.read(o.at), 'wood');
  assert.equal(c.dwellings.length, 2); assert.equal(c.dwarves.filter(d => d.home).length, 4);
  assert.ok(!c.orders.some(o => o.project === project && o.reserved)); accounting(c);
});
test('reconciliation bounds attempts and unavailable operations do not starve others', () => {
  const { c, w } = setup(1); c.sites = [];
  for (let x = 0; x < 3; x++) { queueBlock(c, { x, y: 1, z: 0 }, 'air', 'wood'); putDwarf(c, { x, y: 1, z: -1 }); step(c, w); }
  w.setAvailable(c.pending[0]!.at, false);
  let calls = 0;
  const port = { read: w.read.bind(w), apply: (change: Parameters<MemoryWorld['apply']>[0]) => { calls++; return w.apply(change); } };
  reconcile(c, port, 1); assert.equal(calls, 1);
  reconcile(c, port, 1); reconcile(c, port, 1);
  assert.equal(calls, 3); assert.equal(c.orders.filter(o => o.status === 'complete').length, 2);
  assert.equal(c.pending.length, 1);
});
test('protected air and revoked territory reject edits with resources preserved', () => {
  for (const mode of ['protected', 'revoked']) {
    const { c, w } = setup(1); c.sites = [];
    const o = queueBlock(c, { x: 1, y: 1, z: 1 }, 'air', 'wood'); putDwarf(c, { x: 1, y: 1, z: 0 }); step(c, w);
    if (mode === 'protected') w.protect(o.at); else c.territory = [];
    reconcile(c, w); assert.equal(o.status, 'blocked'); assert.equal(w.read(o.at), 'air'); accounting(c);
  }
});
test('construction requires territory and known support, including interior clearance', () => {
  for (const mode of ['territory', 'support', 'interior', 'unknown']) {
    const { c, w } = setup();
    if (mode === 'territory') c.territory = [];
    for (const site of c.sites) {
      if (mode === 'support') w.set({ ...site, y: 0 }, 'air');
      if (mode === 'interior') w.set({ x: site.x + 1, y: 1, z: 1 }, 'stone');
      if (mode === 'unknown') w.setAvailable(site, false);
    }
    runHeadless(c, w, 5); assert.equal(c.shelters.length, 0);
  }
});
test('receipts and acknowledgements are idempotent and never overwrite subsequent player edits', () => {
  const { c, w } = setup(1); c.sites = [];
  const o = queueBlock(c, { x: 1, y: 1, z: 1 }, 'air', 'wood'); putDwarf(c, { x: 1, y: 1, z: 0 }); step(c, w);
  const change = c.pending[0]!; const first = w.apply(change)!;
  w.set(o.at, 'stone'); assert.deepEqual(w.apply(change), first); assert.equal(w.read(o.at), 'stone');
  acknowledge(c, first); acknowledge(c, first); assert.equal(c.consumedWood, 1); accounting(c);
  assert.throws(() => w.apply({ ...change, next: 'dirt' }), /reused/);
});
test('seeded runs, JSON snapshots, tick, and advanceTo produce equivalent outcomes', () => {
  const a = setup(); const b = setup();
  advanceTo(a.c, 5, a.w);
  b.c = JSON.parse(JSON.stringify(b.c));
  for (let i = 0; i < 5; i++) { tick(b.c, b.w); reconcile(b.c, b.w); }
  assert.deepEqual(a.c, b.c);
  const restored: Colony = JSON.parse(JSON.stringify(a.c));
  a.w.available = false; runHeadless(a.c, a.w, 7); runHeadless(restored, a.w, 7);
  assert.deepEqual(a.c, restored);
  const repeat = setup(); advanceTo(repeat.c, 5, repeat.w); b.w.available = false; runHeadless(b.c, b.w, 7);
  assert.deepEqual(a.c, b.c);
  assert.throws(() => advanceTo(a.c, 1, a.w));
  assert.throws(() => runHeadless(a.c, a.w, -1));
  assert.throws(() => reconcile(a.c, a.w, 0.5));
});
test('limited resources constrain actual and provisional construction', () => {
  const { c, w } = setup(); c.resources.wood = 2; until(c, w, () => c.consumedWood === 2);
  assert.equal(c.consumedWood, 2); assert.equal(c.dwellings.length, 0); accounting(c, 2);
});
test('revoking territory stops travel and further preparation without stranded reservations', () => {
  const { c, w } = setup(1); step(c, w);
  c.territory = []; const before = c.orders.filter(o => o.reserved).length;
  step(c, w); reconcile(c, w);
  assert.ok(c.orders.filter(o => o.reserved).length <= before);
  assert.equal(c.pending.length, 0); accounting(c);
});
test('a zero reconciliation budget leaves all physical work provisional', () => {
  const { c, w } = setup(); runHeadless(c, w, 200, 0);
  assert.equal(c.consumedWood, 0); assert.equal(c.dwellings.length, 0);
  assert.ok(c.pending.length > 0 && c.pending.length <= 69);
  for (const p of c.pending) assert.equal(w.read(p.at), 'air'); accounting(c);
});
