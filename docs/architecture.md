# Architecture and decisions

## Authority and boundaries

The canonical colony state is a versioned, JSON-serializable snapshot. The simulation has no Minecraft, Node, filesystem, network, or wall-clock dependencies. Minecraft will supply observations and implement physical actions through a separate adapter. No external server is required for a future basic Bedrock add-on; Java may eventually use a separate adapter/runtime.

`types.ts` defines state and the world port, `simulation.ts` implements transitions, `needs.ts` selects needs and harvest actions, `navigation.ts` handles spatial queries and scheduled routes, `movement.ts` defines movement commands/feedback, `clock.ts` defines the game tick rate, and `world.ts` provides a sparse in-memory voxel environment. `index.ts` exposes the public API. There is no complete Bedrock adapter or manifest.

## Clock and explicit inputs

`tick` (alias `step`) advances exactly one simulation tick. `reconcile` performs a separate bounded batch of physical attempts. `advanceTo` repeats both transitions to reach an absolute target tick; `runHeadless` accepts a relative count. The intended rate is 20 simulation ticks per second, independent of rendering. A future adapter should invoke the engine once per normal Minecraft game tick. An adapter chooses when to invoke these functions. Time never derives from wall-clock time; offline adapters must explicitly choose a capped target tick.

The simulation accepts a `WorldPort` observation source. `read` returns a block or `undefined` for unavailable/unknown terrain. Unknown is never air. Seeded selection among valid sites advances an LCG stored in colony state. Identical starting state and observation/acknowledgement sequences give identical results. Changing reconciliation timing or external observations can change outcomes.

## Small shelter slice

A colony receives permitted territory, candidate origins, stockpiles (possibly empty), designated harvest sites, and dwarves. Each tick, unmet capacity may trigger one hut plan. Planning checks all 27 cells in its 3x3x3 volume, nine support blocks, construction permission, and overlap with earlier projects. A hut has two-high walls, an open two-high doorway, an interior, and a roof: 23 wood blocks and capacity two. It has no floor block layer; observed terrain supplies support.

Workers each prepare at most one block per tick, taking wood from the available pool into an order reservation. Workers must first travel to a reachable adjacent stance. Arrival consumes its entire movement tick; preparation starts on a later tick. Needs decisions precede harvesting and construction, so eating and resting consume the entire action for that tick. The model does not manufacture character events to explain lost construction.

The inventory identity is `available wood + reserved wood + consumed wood = initial wood + confirmed gathered wood`. Successful acknowledgement consumes a reservation. Rejected or cancelled unconfirmed work returns it. Only a fully confirmed hut assigns homes. Limited inventory bounds provisional construction; no additional offline productivity budget is implemented.

## Needs and gathering

Every twentieth tick adds one hunger and fatigue, each capped at 100, so need growth is one point per simulated second. A dwarf with hunger at least 50 eats one available food, reducing hunger by 40. At fatigue 60, a dwarf begins resting and continues until fatigue reaches 20 or below; every second rest tick reduces fatigue by one after any scheduled need increment. A rest cycle normally lasts about 88 ticks (about 4.4 seconds, depending on clock phase). A meal can interrupt rest without discarding the persisted recovery goal. Rest is abstract and works outdoors, without requiring confirmed housing or loaded terrain. Without food, hunger stays capped; injury, death, and starvation productivity penalties are not implemented.

After needs, dwarves try to gather food up to two meals per colony member, then wood to cover pending construction demand, then prepare construction or idle. Available stock plus claimed/pending harvest yields count toward each target. Only reachable sources/orders are selected. Stable source and order priority is used, rather than globally optimizing travel distance. Stable dwarf and source insertion order resolve contention deterministically. Each dwarf takes one action per tick; earlier unconfirmed physical contributions can remain queued while the dwarf eats, rests, or performs another action. Reconciliation settles prior contributions independently of current activity.

`addResourceSource` designates a coordinate and resource. One observed wood block yields one wood; one berries block yields one food. Registration authorizes consideration, but current territory and adapter protection are still required. Unknown sources are skipped. The simulation never automatically treats arbitrary wood as harvestable. Sources cannot overlap reserved construction cells, hut interiors, or foundations. Planning also avoids pending harvests, and reconciliation rechecks construction reservations before removal.

Harvest orders use the same operation IDs, compare-and-set, budget, and receipt lifecycle as construction: expected resource block → air. A yield enters inventory only after successful acknowledgement, exactly once. Depleted, blocked, or completed sources are not automatically retried; walking claims cancelled because their route disappeared may be selected again after reachability returns; explicit regeneration/revision is future work. Protection or terrain conflicts block harvest without affecting unrelated shelter projects. Food accounting is `available food + consumed meals = initial food + confirmed gathered food`.

Eating from canonical stock and resting can continue without loaded terrain. No new harvest work is prepared without a known matching resource block, and deferred removal yields no resources. The current state schema is version 5, including integer foot position, cached path, task ID, partial movement ticks, movement mode, command/feedback revisions, scheduled search frontiers, needs, resources, and gathering totals. JSON replay supports current-version state; older prototype snapshots need explicit future migration.

## Positions, paths, and travel

`addDwarf` accepts an explicit integer foot coordinate (default `0,1,-1` for compatibility). Callers must supply a supported, clear spawn in their landscape. Unknown, unsupported, or obstructed current positions freeze physical activity; the engine never guesses air or teleports the dwarf to safety.

`navigation.ts` performs scheduled incremental breadth-first search (512 discovered nodes per search, at most 64 node expansions and two new jobs per simulation tick across the colony), with deterministic east/south/west/north neighbor order and level/up/down step order. Each position requires known air for feet and head, and known dirt/wood/stone support. Cardinal neighbors may differ by one block of height, with clearance over the full step. There are no diagonals, jumps, drops greater than one block, swimming, or ladders. Search-budget exhaustion conservatively defers a task even if a longer route exists; this is a local-search prototype, not global navigation.

Task selection reuses one scheduled reachability result across its candidate list. Adjacent work needs no search; unsuccessful results use delayed staggered retries. Partial frontiers and the round-robin queue persist in snapshots, and chunk reload uses the same shared per-tick budget. The chosen order is claimed by one worker and its path is stored in the snapshot. Workers advance at most one cardinal edge every eight active movement ticks (2.5 horizontal blocks/second at 20 ticks/second). One-block rises and descents use the same eight ticks. Positions are discrete foot cells, not per-frame interpolated coordinates; an adapter may interpolate presentation without changing canonical completion time.

Every movement tick validates the current position and next edge against current observations. A changed obstacle causes deterministic scheduled replanning. Failed routes release their claim without consuming materials; cancelled harvest claims can be retried. Fully unknown terrain resets partial movement credit and pauses travel. Needs emit a superseding stop and reset partial movement credit without spending movement time; a resumed route cannot accumulate a burst of moves. There is no background/offline travel across unobserved terrain.

Work requires a standing position in a cardinal neighboring column, with target height from one below feet to two above. Planned solid construction cells are excluded from routes, preventing workers from occupying unfinished wall/roof cells. Designated harvest blocks cannot be used as future footing. Reconciliation defers placements into dwarf bodies and harvests supporting dwarves. Existing contributions can settle after a worker leaves; they represent work already prepared on site, not new remote labor.

Dwarves may share a tile or pass through each other; crowd avoidance and entity-level collisions are future adapter/navigation work. Movement is constrained by observations, while work also requires build/harvest permission. Travel itself need not remain inside construction territory. Eating, resting, stock access, and hauling are still abstract: this milestone constrains gathering and construction positions only.

## Movement commands and corrections

Headless mode automatically realizes walking at the configured rate. `createColony(seed, 'adapter')` instead emits stable revisioned waypoints through `getMovementCommands` and requires `observeMovement` arrival feedback before advancing a path edge or preparing work. A correction records the actual position, emits a superseding stop, and invalidates the route/search. Duplicate and stale observations cannot rewind state. Unknown positions freeze movement; block reconciliation conservatively pauses colony-wide while any NPC position is unknown. See [movement protocol](movement-protocol.md) for command replacement, observation ordering, early arrival gating, and future adapter responsibilities.

## Proposed, provisional, realized

Construction orders begin `pending` (proposed). Worker preparation changes them to `awaiting-world` (provisional) and emits a change carrying the immutable order ID, coordinates, expected block, and desired block. Harvest selection creates a claimed `pending` removal order. Reaching its stance and spending a separate work tick changes it to `awaiting-world`. Construction materials are reserved only at preparation, not while travelling. Only a successful world result makes an order `complete` (realized). Disconnection does not stop needs, eating, or rest. Movement and new physical preparation require current known terrain; previously prepared contributions may remain provisional. No new plan uses unknown terrain and no unconfirmed block counts toward completed shelter.

`reconcile` attempts at most its budget, including attempts that return unavailable. A persistent round-robin cursor prevents an unavailable position from starving other pending operations. It rechecks colony permission before dispatch. World adapters must atomically enforce current protection and compare-and-set conditions when actually applying a change; a prior observation is insufficient.

`MemoryWorld` treats unspecified available positions as known air, supports individual and global unavailability, and denies writes to protected positions even if they contain air. It records stable receipts so retries do not repeat writes, and rejects ID reuse with another payload. An adapter must retain receipts across its own persistence/restart boundary and namespace operation IDs per colony. Colony JSON alone does not persist the test world's terrain or receipt map.

## Conservative conflict policy

Unexpected terrain, protection, or revoked permission blocks an operation. A project conflict suspends its hut, cancels remaining unconfirmed orders, and returns their reserved resources. Confirmed partial construction remains, and other projects continue. Suspended footprints stay reserved so autonomous planning does not repeatedly build on a failed site. No rollback, retroactive history, or elapsed-tick replay is needed. Revision, abandonment/cleanup, and explicit player consent for replacement are future work.

This synchronous prototype has no in-flight asynchronous writes: `apply` must either return a definitive result or defer without mutating. Future asynchronous adapters need a receipt/status protocol before cancellation can safely refund uncertain writes. Duplicate acknowledgements are ignored. The core trusts adapter receipts; adapters must not claim success before physical completion.

## Intentional limits and next steps

Planning scans a small supplied site list; reconciliation attempts and total per-tick graph expansion/start work are bounded. Total planning/task-selection work still scales with colony and candidate count. Arrays, linear lookups, and an unbounded event log favor inspectability over scale. Social relationships, hauling, crowd avoidance, blueprint teaching/replacement, save migrations, continuously observed housing validity, and durable persistence are absent. A completed shelter means it was confirmed at completion time; later player destruction is not yet reconciled.

Next, add physical stockpiles, carried resources, and reachable meal/rest destinations; then expose player policies and blueprint revision. Preserve autonomous personal/community behavior and player authority. Integrate Bedrock only after implementing and testing a real adapter, manifest, durable operation receipts, loaded-chunk checks, and protection policy. Never treat unloaded chunks as loaded or overwrite player/protected builds without consent.
