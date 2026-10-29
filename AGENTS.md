# Codex project instructions

This is a Minecraft colony simulation project inspired by emergent Dwarf Fortress stories: dwarves should independently meet needs and build rough solutions, while players may design better structures and guide colony policy.

Priorities: headless simulation, deterministic tests, safe world integration, offline/chunk-unloaded behavior, platform independence. Minecraft worlds are projections and observation sources; never use unloaded chunks as though loaded. Never overwrite player edits or protected builds without consent.

Keep the core pure TypeScript with serializable state and explicit inputs. Write tests for all simulation behavior and conflict handling. Do not claim Bedrock add-on functionality exists before implementing and testing a real adapter and manifest. Prefer incremental vertical slices over speculative large systems.

## Current headless milestone

The simulation lives in `packages/simulation/src/{types,simulation,needs,navigation,movement,clock,world}.ts`; the CLI is in `packages/headless/src/main.ts`. Use npm and run `npm test`, `npm run typecheck`, and `npm run simulate` after simulation changes.

Keep time explicit (`tick`/`step`, `advanceTo`) and randomness seeded in serializable state. Unknown world observations are not air. Planning requires observed support/clearance and permitted territory. Preserve the distinction between proposed orders, provisional reserved work, and world-confirmed construction. Maintain resource accounting through conflicts and cancellation.

Reconciliation must bound attempts, avoid starvation on unavailable terrain, enforce current permission/protection and compare-and-set, and use stable idempotent operation IDs. Conflicts may suspend a project and preserve valid partial construction; do not replay history or invent character events to explain failed provisional work. World ports must defer without writing or return definitive receipts synchronously; asynchronous writes require an explicit settlement protocol before cancellation/refund.

The current demo starts with empty stock and uses candidate building sites plus explicitly designated finite wood/berry harvest blocks. Each dwarf has a serializable integer foot position, claimed task, path, and partial movement progress. Movement uses 20 simulation ticks/sec and eight ticks per cardinal block, with known two-high clearance and solid footing. Keep path searches bounded and deterministic; revalidate each step, freeze movement/preparation on unknown terrain, and exclude planned construction or harvest footing. Require adjacent reachable work stances before preparation, and defer edits into dwarf bodies or removal of their footing.

Needs grow once per 20 simulation ticks; resting reduces fatigue by one every second rest tick. Needs consume one action per tick: eating, sustained rest, gathering, then construction. Harvest yields require successful world acknowledgements; pending yields count toward stock targets. Do not harvest arbitrary wood or reserved construction/interior/foundation cells. Preserve wood/food accounting and idempotency. Pathfinding is a local 512-node BFS; crowd collisions, hauling, physical food/rest access, starvation damage, and source regeneration are absent. Snapshot schema is version 5 with no automatic migrations. No durable world persistence or functioning Bedrock adapter exists. Do not add a large framework before the next useful tested behavior. Player blueprint teaching and replacement remain future work, and require protection/consent checks.

Use globally scheduled incremental BFS: at most two starts and 64 node expansions per tick, round-robin job progress, cached routes, and delayed staggered retries. Preserve queued frontiers across saves/unloading; never rebuild every route synchronously on reload. Adjacent tasks skip graph search.

Future adapters must use revisioned move/stop commands and explicit observed-position feedback (see `docs/movement-protocol.md`). Adapter mode must not infer arrival from elapsed time. Corrections invalidate the route and supersede obsolete NPC commands; stale/duplicate feedback must not change state. Unknown NPC positions conservatively suspend physical reconciliation. No real Bedrock or Java adapter is implemented.
