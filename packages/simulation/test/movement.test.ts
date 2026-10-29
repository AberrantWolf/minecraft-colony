import test from 'node:test';
import assert from 'node:assert/strict';
import { addDwarf, createColony, getMovementCommands, MemoryWorld, observeMovement, queueBlock, reconcile, runHeadless, step, type Colony, type MovementCommand } from '../src/index.ts';
import { accounting, until } from './fixtures.ts';
function fixture() {
  const c = createColony(42, 'adapter'); const w = new MemoryWorld();
  c.territory = [{ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 4, z: 2 } }];
  for (let x = 0; x <= 10; x++) for (let z = 0; z < 3; z++) w.set({ x, y: 0, z }, 'dirt');
  const d = addDwarf(c, 'Urist', { x: 0, y: 1, z: 0 });
  c.resources.wood = 1; const order = queueBlock(c, { x: 6, y: 1, z: 0 }, 'air', 'wood');
  until(c, w, () => d.motion?.kind === 'move');
  return { c, w, d, order };
}
function move(command: MovementCommand | undefined): Extract<MovementCommand, { kind: 'move' }> {
  assert.ok(command && command.kind === 'move'); return command;
}
test('adapter motion emits stable waypoints at 20 TPS, and elapsed ticks cannot confirm NPC arrival', () => {
  const { c, w, d, order } = fixture(); const first = move(d.motion);
  assert.equal(first.durationTicks, 8); assert.equal(first.blocksPerSecond, 2.5);
  assert.deepEqual(first.from, d.position); assert.deepEqual(first.to, { x: 1, y: 1, z: 0 });
  runHeadless(c, w, 100);
  assert.equal(d.position.x, 0); assert.equal(order.status, 'pending'); assert.equal(c.resources.wood, 1);
  assert.deepEqual(d.motion, first); assert.deepEqual(getMovementCommands(c), [first]);
  assert.deepEqual(getMovementCommands(c, { [d.id]: first.revision }), []);
  const detached = move(getMovementCommands(c)[0]); detached.to.x = 99; assert.equal(move(d.motion).to.x, 1);
  accounting(c, 1);
});
test('an adapter confirms successive waypoints before construction can begin', () => {
  const { c, w, d, order } = fixture(); let sequence = 0;
  for (let x = 1; x <= 5; x++) {
    const command = move(d.motion); assert.equal(command.to.x, x);
    runHeadless(c, w, 7); assert.equal(d.position.x, x - 1);
    assert.equal(observeMovement(c, { dwarfId: d.id, revision: command.revision, sequence: ++sequence, kind: 'arrived', position: command.to }), true);
    assert.equal(d.position.x, x); assert.equal(order.status, 'pending'); assert.equal(d.motion?.kind, 'stop');
    if (x < 5) step(c, w);
  }
  step(c, w); assert.equal(order.status, 'awaiting-world'); reconcile(c, w);
  assert.equal(order.status, 'complete'); accounting(c, 1);
});
test('an early arrival report updates reality but cannot accelerate the next move or work tick', () => {
  const { c, w, d } = fixture(); const command = move(d.motion);
  observeMovement(c, { dwarfId: d.id, revision: command.revision, sequence: 1, kind: 'arrived', position: command.to });
  assert.equal(d.position.x, 1); const revision = d.motionRevision;
  runHeadless(c, w, 7); assert.equal(d.motionRevision, revision); assert.equal(d.motion?.kind, 'stop');
  step(c, w); assert.equal(move(d.motion).from.x, 1); assert.equal(d.position.x, 1);
});
test('corrections supersede old commands, invalidate the route, and replan from observed feet', () => {
  const { c, w, d, order } = fixture(); const old = move(d.motion); const task = d.task;
  assert.equal(observeMovement(c, { dwarfId: d.id, revision: old.revision, sequence: 1, kind: 'corrected', position: { x: 0, y: 1, z: 2 } }), true);
  assert.equal(d.motion?.kind, 'stop'); assert.ok(d.motionRevision > old.revision);
  assert.equal(d.path.length, 0); assert.equal(d.moveTicks, 0); assert.equal(d.task, task); assert.equal(d.search, undefined);
  assert.equal(observeMovement(c, { dwarfId: d.id, revision: old.revision, sequence: 2, kind: 'arrived', position: old.to }), false);
  until(c, w, () => d.motion?.kind === 'move');
  assert.deepEqual(move(d.motion).from, { x: 0, y: 1, z: 2 }); assert.equal(order.status, 'pending'); accounting(c, 1);
});
test('unknown or obstructed corrected positions are retained without teleporting or permitting work', () => {
  for (const mode of ['unknown', 'obstructed']) {
    const { c, w, d } = fixture(); const at = { x: 4, y: 1, z: 2 };
    if (mode === 'unknown') w.setAvailable(at, false); else w.set(at, 'stone');
    observeMovement(c, { dwarfId: d.id, revision: d.motionRevision, sequence: 1, kind: 'corrected', position: at });
    runHeadless(c, w, 50); assert.deepEqual(d.position, at); assert.equal(c.pending.length, 0);
    assert.equal(d.motion?.kind, 'stop'); accounting(c, 1);
  }
});
test('unavailable NPC feedback stops movement and gates physical reconciliation until observed again', () => {
  const { c, w, d } = fixture();
  observeMovement(c, { dwarfId: d.id, revision: d.motionRevision, sequence: 1, kind: 'unavailable' });
  assert.equal(d.positionKnown, false); const revision = d.motionRevision;
  const worker = addDwarf(c, 'Domas', { x: 8, y: 1, z: 0 });
  const near = queueBlock(c, { x: 9, y: 1, z: 0 }, 'air', 'stone'); step(c, w);
  assert.equal(near.owner, worker.id); assert.equal(near.status, 'awaiting-world');
  assert.equal(reconcile(c, w), 0); assert.equal(w.read(near.at), 'air');
  observeMovement(c, { dwarfId: d.id, revision, sequence: 2, kind: 'corrected', position: d.position });
  reconcile(c, w); assert.equal(w.read(near.at), 'stone'); accounting(c, 1);
});
test('malformed, duplicate, stale, and mismatched feedback never mutates colony state', () => {
  const { c, d } = fixture(); const command = move(d.motion); const snapshot = JSON.stringify(c);
  for (const input of [
    { dwarfId: 'missing', revision: command.revision, sequence: 1, kind: 'unavailable' as const },
    { dwarfId: d.id, revision: command.revision - 1, sequence: 1, kind: 'unavailable' as const },
    { dwarfId: d.id, revision: command.revision, sequence: 0, kind: 'unavailable' as const },
    { dwarfId: d.id, revision: command.revision, sequence: 0.5, kind: 'unavailable' as const },
    { dwarfId: d.id, revision: command.revision, sequence: 1, kind: 'arrived' as const, position: { x: 9, y: 1, z: 0 } },
    { dwarfId: d.id, revision: command.revision, sequence: 1, kind: 'corrected' as const, position: { x: NaN, y: 1, z: 0 } },
  ]) assert.equal(observeMovement(c, input), false);
  assert.equal(JSON.stringify(c), snapshot);
  const feedback = { dwarfId: d.id, revision: command.revision, sequence: 1, kind: 'arrived' as const, position: command.to };
  assert.equal(observeMovement(c, feedback), true); const after = JSON.stringify(c);
  assert.equal(observeMovement(c, feedback), false); assert.equal(JSON.stringify(c), after);
});
test('needs and changed terrain emit superseding stops so obsolete NPC commands cannot complete', () => {
  for (const reason of ['needs', 'terrain']) {
    const { c, w, d } = fixture(); const old = move(d.motion);
    if (reason === 'needs') { d.hunger = 80; c.resources.food = 1; }
    else { w.set(old.to, 'stone'); w.set({ ...old.to, y: 2 }, 'stone'); }
    step(c, w); assert.equal(d.motion?.kind, 'stop'); assert.ok(d.motionRevision > old.revision);
    assert.equal(observeMovement(c, { dwarfId: d.id, revision: old.revision, sequence: 1, kind: 'arrived', position: old.to }), false);
    assert.equal(d.position.x, 0);
  }
});
test('saved adapter state and the same ordered correction inputs replay deterministically', () => {
  const a = fixture(); const b = fixture(); const restored: Colony = JSON.parse(JSON.stringify(b.c));
  for (const c of [a.c, restored]) observeMovement(c, { dwarfId: c.dwarves[0]!.id, revision: c.dwarves[0]!.motionRevision, sequence: 1, kind: 'corrected', position: { x: 0, y: 1, z: 1 } });
  for (let n = 0; n < 100; n++) {
    for (const [c, w] of [[a.c, a.w], [restored, b.w]] as const) {
      step(c, w); const d = c.dwarves[0]!;
      if (d.motion?.kind === 'move' && d.moveTicks === 8) observeMovement(c, { dwarfId: d.id, revision: d.motionRevision, sequence: d.lastMotionSequence + 1, kind: 'arrived', position: d.motion.to });
      reconcile(c, w);
    }
  }
  assert.deepEqual(a.c, restored); assert.equal(a.order.status, 'complete'); accounting(a.c, 1);
});
