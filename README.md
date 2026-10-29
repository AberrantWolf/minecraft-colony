# Minecraft Colony

A Dwarf Fortress-inspired colony simulation with a portable TypeScript core. Dwarves eat, rest, gather and haul food and wood to physical stockpiles, fetch building supplies, and build rough huts. Minecraft integration is a future milestone; this repository is a headless prototype.

## Run it

Requires Node.js >=22.16 (Node 24 recommended) and npm.

```sh
npm install
npm test
npm run typecheck
npm run simulate
```

Tests and the demo run directly from TypeScript using Node type stripping. Installing dependencies provides the project's TypeScript compiler.

The demo starts five dwarves with no carried or stored supplies, a capacity-limited stockpile near work areas, three building sites, finite harvest areas, and supported walkways. They gather, carry harvests to storage, pick up planks, and bring them to construction. Terrain becomes unavailable from tick 400 to 600. The 12,000-tick run represents 600 simulated seconds, showing a sampled hauling timeline, hut completion, storage contents, and carried inventory. Conflict and protection scenarios remain covered by tests.

The colony clock runs at **20 simulation ticks per second**. Walking takes **eight ticks per block (2.5 blocks/second)**. Minecraft normally runs at [20 game ticks per second](https://learn.microsoft.com/en-us/minecraft/creator/documents/redstoneguide?view=minecraft-bedrock-stable); a future adapter should run one simulation step per game tick. No adapter is implemented yet.

## What works

- Explicit tick clock, seeded site selection, JSON-serializable colony state, `tick`/`step`, and `advanceTo` (repeated stepping).
- Autonomous shelter demand, two-person huts with doors and roofs, on-site material delivery, and conservative conflict handling.
- Positioned stockpiles with total capacity, carried inventories, delivery/pickup phases, and conserved resources across contention or cancellation.
- Autonomous eating and multi-tick rest, one action per dwarf per tick, and deterministic allocation of food/wood gathering.
- Serializable foot positions, claimed tasks, cached deterministic paths, and per-step travel progress.
- Shared incremental pathfinding: at most two new searches and 64 node expansions per tick, cached routes, and delayed staggered retries.
- Revisioned move/stop commands, observed-position corrections, and adapter-mode arrival confirmation.
- Bounded breadth-first pathfinding with solid footing, two-block clearance, one-block steps, and dynamic obstacle checks.
- Finite designated harvest blocks, confirmed yields, food stock targets, and construction-driven wood demand.
- Explicit unknown terrain; plans require observed support and clear interiors within configured territory.
- Harvests enter carried inventory only after confirmation; prepared work remains provisional while disconnected. Movement, storage access, and new physical preparation require loaded observations.
- Bounded, round-robin reconciliation; conflicts suspend a project without undoing confirmed work or replaying elapsed time.
- In-memory world with block availability, protected positions, atomic compare-and-set, and stable operation receipts.
- Deterministic tests covering construction, unloading, conflicts, protection, permissions, resources, replay, and reconciliation.

## Structure and limits

`packages/simulation/src` contains platform-free state, simulation, and the test world. `packages/headless` runs the scenario; `packages/bedrock` is a placeholder with no deployable adapter or manifest. See [architecture](docs/architecture.md) and the [hauling lifecycle](docs/hauling.md).

The prototype uses supplied building sites and explicitly designated wood/berry blocks. Workers must reach an adjacent stance before preparing one physical operation on a separate tick. Routes use a 512-node local search; tasks outside that search horizon wait. Dwarves can share cells; crowd collision, jumping, swimming, ladders, tool use, and advanced batch hauling are not implemented. Logical positions move between integer foot cells; smooth visual interpolation belongs to a future adapter. In adapter mode, a dwarf waits for confirmed NPC arrival before starting work. See the [movement protocol](docs/movement-protocol.md). Meals reduce hunger; rest reduces fatigue even without housing. Food must be carried or fetched at a reachable stockpile. Stockpile inventory is simulation state in a designated air zone, not a Minecraft chest or real container inventory. Each transfer consumes a separate on-site tick. Needs grow once per simulated second; sustained rest usually takes about 4.4 seconds. These are prototype balance values. There is no starvation damage, death, crop growth, or source regeneration. Failed harvest sites are retained as blocked orders and are not retried automatically. Planning checks current observations but does not continuously validate completed buildings after player edits. Colony state round-trips through JSON; durable saves, migrations, persisted world receipts, and real Minecraft chunk integration are not implemented. Large-scale planning and event-log limits remain future work.

The next milestone should add reachable beds/rest locations and policies for storage/hauling priorities, then investigate batch hauling and real inventory adapters. Snapshot schema is now version 6; automatic migration from earlier prototypes is not implemented. A real Bedrock adapter should follow with integration tests for chunk availability, protection, receipts, and placement confirmations.
