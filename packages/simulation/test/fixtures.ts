import { createColony, addDwarf, step, reconcile, MemoryWorld, type Colony, type Voxel, addStockpile, inventoryTotals, inventorySize, CARRY_CAPACITY } from '../src/index.ts';
export function setup(count = 1) {
  const c = createColony(42); const w = new MemoryWorld();
  c.territory = [{ min: { x: -3, y: 0, z: -3 }, max: { x: 24, y: 6, z: 24 } }];
  for (let x = -3; x <= 24; x++) for (let z = -3; z <= 24; z++) w.set({ x, y: 0, z }, 'dirt');
  addStockpile(c, { x: -1, y: 1, z: -1 }, 256);
  for (let i = 0; i < count; i++) addDwarf(c, `Dwarf ${i + 1}`, { x: 0, y: 1, z: -1 });
  return { c, w };
}
export function until(c: Colony, w: MemoryWorld, condition: () => boolean, limit = 10000, budget = 4): void {
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
  const total = inventoryTotals(c);
  if (total.wood + c.consumedWood !== initialWood + c.gathered.wood || total.food + c.consumedFood !== initialFood + c.gathered.food) throw new Error('resource accounting violated');
  for (const d of c.dwarves) if (d.carry.wood < 0 || d.carry.food < 0 || inventorySize(d.carry) > CARRY_CAPACITY) throw new Error('invalid carried inventory');
  for (const p of c.stockpiles) if (p.resources.wood < 0 || p.resources.food < 0 || inventorySize(p.resources) > p.capacity) throw new Error('invalid stockpile inventory');
}
/** Unit fixtures may start workers already carrying material; integrated tests use storage trips. */
export function preload(c: Colony, amount = 1, index = 0): void {
  c.stockpiles[0]!.resources.wood -= amount; c.dwarves[index]!.carry.wood += amount;
}
