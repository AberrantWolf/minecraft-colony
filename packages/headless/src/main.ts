import { createColony, addDwarf, addResourceSource, runHeadless, MemoryWorld, MOVEMENT } from '../../simulation/src/index.ts';
const colony = createColony(42);
const world = new MemoryWorld();
colony.territory = [{ min: { x: 0, y: 0, z: 0 }, max: { x: 24, y: 6, z: 24 } }];
colony.sites = [0, 5, 10].map(x => ({ x, y: 1, z: 0 }));
for (let x = -3; x <= 24; x++) for (let z = -3; z <= 24; z++) world.set({ x, y: 0, z }, 'dirt');
for (const resource of ['wood', 'food'] as const) {
  for (let x = 0; x < (resource === 'wood' ? 80 : 100); x++) {
    const at = { x: x % 10 + (resource === 'food' ? 12 : 0), y: 1, z: (resource === 'wood' ? 5 : 6) + 2 * Math.floor(x / 10) };
    addResourceSource(colony, at, resource);
    world.set(at, resource === 'wood' ? 'wood' : 'berries');
  }
}
for (const name of ['Urist', 'Domas', 'Atis', 'Kogan', 'Nil']) addDwarf(colony, name);
runHeadless(colony, world, 400);
world.available = false;
colony.events.push(`tick ${colony.tick}: world unavailable; movement pauses; eating/rest continue, harvest yields deferred`);
runHeadless(colony, world, 200);
world.available = true;
colony.events.push(`tick ${colony.tick}: world restored; reconciliation budget 2`);
runHeadless(colony, world, 3400, 2);
console.log('MINECRAFT COLONY — REACHABLE WORK AND TRAVEL DEMO');
console.log('Five dwarves, empty stock, finite harvest sites, supported paths. 20 simulation ticks/sec; 1 block per 8 ticks. Pathfinding: at most 64 node expansions/tick.');
console.log(colony.events.filter(e => e.includes('planned') || e.includes('confirmed;') || e.includes('world ')
  || e.includes('Urist eating') || e.includes('Urist resting')).join('\n'));
console.log(JSON.stringify({ tick: colony.tick, simulatedSeconds: colony.tick / MOVEMENT.ticksPerSecond, walkingBlocksPerSecond: MOVEMENT.ticksPerSecond / MOVEMENT.ticksPerBlock, housed: colony.dwarves.filter(d => d.home).length, huts: colony.shelters.map(s => ({ id: s.id, status: s.status })), gathered: colony.gathered, available: colony.resources, consumed: { wood: colony.consumedWood, food: colony.consumedFood }, dwarves: colony.dwarves.map(d => ({ name: d.name, hunger: d.hunger, tiredness: d.tiredness, activity: d.activity, position: d.position, remainingPath: d.path.length })), confirmedBlocks: colony.orders.filter(o => o.kind === 'place-block' && o.status === 'complete').length, provisionalOperations: colony.pending.length, activeTrips: colony.dwarves.filter(d => d.task).length, pathfinding: { queued: colony.pathfinding.queue.length, totalSearches: colony.pathfinding.totalStarted, totalExpanded: colony.pathfinding.totalExpanded } }, null, 2));
