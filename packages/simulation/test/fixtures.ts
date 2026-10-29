import { createColony, addDwarf, step, reconcile, MemoryWorld, type Colony, type Voxel } from '../src/index.ts';
export function setup(count = 1) {
  const c = createColony(42); const w = new MemoryWorld();
  c.territory = [{ min: { x: -3, y: 0, z: -3 }, max: { x: 24, y: 6, z: 24 } }];
  for (let x = -3; x <= 24; x++) for (let z = -3; z <= 24; z++) w.set({ x, y: 0, z }, 'dirt');
  for (let i = 0; i < count; i++) addDwarf(c, `Dwarf ${i + 1}`, { x: 0, y: 1, z: -1 });
  return { c, w };
}
export function until(c: Colony, w: MemoryWorld, condition: () => boolean, limit = 2000, budget = 4): void {
  for (let n = 0; n < limit && !condition(); n++) { step(c, w); reconcile(c, w, budget); }
  if (!condition()) throw new Error(`condition not reached by tick ${c.tick}`);
}
export function putDwarf(c: Colony, at: Voxel): void {
  c.dwarves[0]!.position = { ...at }; c.dwarves[0]!.path = []; c.dwarves[0]!.moveTicks = 0;
}
export function resourcePositions(count: number, z: number): Voxel[] {
  // Spaced rows have walkable aisles, and fit within the bounded local search.
  return Array.from({ length: count }, (_, n) => ({ x: n % 10 + (z === 6 ? 12 : 0), y: 1, z: z + 2 * Math.floor(n / 10) }));
}
export function accounting(c: Colony, initialWood = 0, initialFood = 0): void {
  const wood = c.resources.wood + c.consumedWood + c.orders.filter(o => o.reserved).length;
  const food = c.resources.food + c.consumedFood;
  if (wood !== initialWood + c.gathered.wood || food !== initialFood + c.gathered.food || c.resources.food < 0 || c.resources.wood < 0) {
    throw new Error('resource accounting violated');
  }
}
