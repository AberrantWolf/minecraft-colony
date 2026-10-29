# Movement boundary for future adapters

This is a tested platform-independent protocol, not an implemented Bedrock or Java adapter. Neither edition's NPC navigation API is integrated yet.

## Time and authority

The engine runs at 20 simulation ticks per second, matching normal Minecraft game ticks. One cardinal block takes eight active movement ticks: 2.5 horizontal blocks per second. Headless mode advances logical positions automatically; `createColony(seed, 'adapter')` requires explicit NPC arrival feedback. Choose the mode at colony creation; live mode switching and old-snapshot migrations are not implemented.

The simulation chooses tasks, paths, and desired movement. The adapter reports observed NPC position. Neither elapsed time nor delivery of a command proves arrival in adapter mode. A correction records the observed position, clears the cached route/search and partial movement credit, and causes a bounded replan from that position. It never marks gathering or construction complete. Confirmed prior physical work remains confirmed.

## Commands from the simulation

After each step or input transition, call `getMovementCommands(colony, afterRevisions?)`. Each dwarf exposes its latest command, carrying `id`, `dwarfId`, monotonically increasing `revision`, and `issuedTick`:

- `move`: `from` and `to` integer foot cells, `durationTicks: 8`, and `blocksPerSecond: 2.5`.
- `stop`: last known `at` foot cell and a reason, such as needs, changed route, arrival, correction, or unavailable terrain. `at` is context, not a teleport or move-back instruction; cancel the current motor and report any displacement.

These are desired-state replacements, not a FIFO event stream. Every newer revision must cancel/supersede that NPC's older motor/path request before applying the new command. A superseding move also cancels the previous move, even if an intermediate stop was not polled. Retrying the same command ID must not restart or accelerate movement. `afterRevisions` maps dwarf IDs to the adapter's last consumed revision and suppresses unchanged commands. Returned objects are detached from simulation state.

Command IDs are local to one colony; bind and namespace them with a persistent colony/entity identity in an adapter. Persist revision/observation cursors with entity bindings. Rebinding to a newly spawned/replaced entity must explicitly reconcile its observed position rather than replay an old motor request.

The adapter should instruct NPC navigation toward the waypoint at the supplied speed, rather than teleporting on every tick. Integer foot cells describe the simulation grid; an adapter must normalize the edition's continuous position/collision conventions and confirm that the entity actually occupies the requested foot cell. No continuous movement interpolation or edition-specific step/jump motor is implemented in the core.

## Explicit feedback into the simulation

Call `observeMovement(colony, feedback)` with `dwarfId`, the current command `revision`, a strictly increasing positive `sequence`, and one of:

- `{ kind: 'arrived', position }`: the NPC reached the exact current move destination. This advances one path edge. An early report updates the observed position but cannot start another move or work before the commanded duration has elapsed.
- `{ kind: 'corrected', position }`: an authoritative foot position after displacement, knockback, a blocked move, or a requested resynchronization. This produces a newer stop and invalidates the old route. Unknown/obstructed positions are retained as observations and physical activity pauses until terrain becomes usable; the core never invents a safe location.
- `{ kind: 'unavailable' }`: the NPC cannot currently be observed. This emits a stop and marks its position unknown. A fresh `corrected` report using the new revision restores position availability.

The function returns `true` only for accepted inputs. Unknown dwarves, noninteger coordinates, wrong destinations, duplicate/out-of-order sequences, and stale command revisions are rejected without changing state. Feedback is ordered input: persist/replay the same input sequence at the same simulation ticks for determinism. `arrived` is a completion report, not continuous in-progress telemetry.

If an old motor completes after the simulation cancelled it, reject its obsolete completion and report the latest actual position as `corrected` under the current revision. Even a stop command must therefore be accompanied by a position correction when the NPC actually ended up elsewhere. Position corrections are trusted observations, not terrain permission or a request to overwrite blocks.

## Tick integration outline

1. Sample only accessible world terrain and observable NPCs.
2. Apply queued ordered position feedback using `observeMovement`.
3. Run one `step(colony, worldPort)` per game tick.
4. Dispatch changed movement commands, superseding previous revisions.
5. Reconcile block changes under a separate bounded budget using the existing synchronous world/receipt contract.

Arrival and work use distinct transitions. Reconciliation settles prior on-site work contributions; a later displacement does not retroactively invalidate them. As a conservative prototype policy, if any NPC position is unknown, all block reconciliation pauses because collision/footing safety cannot be established. Needs still advance. Future adapters may scope uncertainty spatially with an explicit occupancy model.

## Pathfinding budgets

The engine keeps paths and only checks the current position/next edge during movement. It schedules BFS frontiers globally: at most two new jobs per tick, four round-robin job visits, and 64 total node expansions. Each job discovers at most 512 nodes and stores a serializable frontier and parent indices. An already-adjacent job avoids a graph search. An unreachable result delays retry by 40 ticks plus a small deterministic dwarf stagger.

Queued jobs do not expand across unavailable positions. Reloading chunks resumes them under the same shared budget, rather than recalculating every dwarf's route at once. Corrections and changed obstacles use this scheduler too. Snapshots retain scheduling order, partial frontiers, delayed retries, command revisions, and feedback sequences. `colony.pathfinding` reports start/expansion counters for headless checks.

The budget bounds graph expansion, not the entire engine's wall-clock cost. Candidate/source scans, shelter planning, and colony loops still scale with state size. Global navigation beyond the local search horizon, crowd avoidance, continuous physics, carried resources, durable entity bindings, and real adapter integration remain future work.
