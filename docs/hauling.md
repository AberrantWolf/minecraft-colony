# Stockpiles and hauling

This is a headless physical inventory slice. Stockpiles are designated storage zones with coordinates and capacity, not Minecraft chests. Inventory remains canonical simulation state. No Bedrock/Java container integration or inventory adapter is implemented.

## Resource locations and accounting

`addStockpile(colony, at, capacity, initialInventory)` creates a zone in permitted territory. Its floor, foot cell, and head cell are reserved against harvest/construction. Use a supported air position; transfers require the zone and worker stance to be currently observed, clear, supported, and within permission. Registration itself does not query or edit the world. Overlapping resource sites, construction reservations, and storage zones are rejected.

Stockpiles have a shared total capacity for food and wood and an `enabled` flag. Disabled, obstructed, unavailable, or inaccessible storage keeps its contents. A new stockpile is empty unless the caller explicitly supplies an initial inventory.

Each dwarf has `carry`, with a four-unit total capacity. This slice harvests one unit per trip and picks up one plank per construction order; it does not yet batch multiple jobs or transfer stockpile-to-stockpile cargo. `storedResources()` sums stockpiles for reporting. `inventoryTotals()` includes storage, carried units, and wood reserved in prepared orders. There is no writable global colony resource pool.

The conservation equations are:

- `stored wood + carried wood + prepared wood escrow + consumed wood = initial wood + confirmed gathered wood`
- `stored food + carried food + consumed meals = initial food + confirmed gathered food`

Claiming an order does not reserve or withdraw a stockpile unit. A pickup transfers one unit atomically on site, so competing workers cannot take the same last plank. Deposit transfers only what fits. Excess cargo stays with the worker and may be delivered to another reachable zone. Transfers are internal serial simulation transitions; integrating real container inventory will need its own explicit atomic confirmation/receipt protocol.

## Harvest, delivery, pickup, construction

A worker reaches a harvest stance and prepares a compare-and-set removal. On successful world acknowledgement, the unit enters that worker's hands exactly once, and `deliveryRequired` prevents it being used directly for construction. Failed/deferred removals produce no cargo. Gatherers cache a known route back to storage while planning the outward trip, reusing those steps rather than starting another search. Each step is still checked against current terrain. If a hungry gatherer eats the food on site, it can still return along that known route.

Delivery takes a trip to an adjacent stockpile stance and a separate transfer tick. Builders claim an order, travel to stock, pick up a plank, travel to the construction stance, then prepare placement on another tick. A work path already calculated from an adjacent pickup stance can be reused. Pickup does not mark construction progress, and placement is never realized before its world acknowledgement.

There is at most one outstanding physical contribution per dwarf. This reserves room for its harvest yield or refunded plank while the adapter defers confirmation. A dwarf may eat or rest while waiting, but cannot issue another physical contribution or collect more cargo. An awaiting order holds prepared wood in escrow; success consumes it and a failure returns it to its carrier, never instantly to storage.

A project conflict cancels remaining unconfirmed work and preserves confirmed blocks. Workers carrying cancelled materials return them to storage. A lost route, full capacity, disabled/revoked storage, or an obstructed destination never deletes or teleports cargo. If there is no reachable destination, workers retain their load and wait for conditions to change under delayed retry rules.

## Needs, movement, and disconnection

Dwarves eat carried food. A hungry dwarf without food can fetch one meal from reachable storage, then eat it on a later tick. Rest remains an abstract activity at the current position. During chunk unavailability, dwarves can eat food already in their hands or rest, but cannot remotely access stockpiles or transfer supplies.

All hauling uses the existing 20 TPS movement rate (eight ticks per block), global pathfinding budget, and adapter arrival-confirmation protocol. Corrections clear stale routes while preserving cargo and haul intent. An actively targeted stockpile becoming unobserved pauses its haul and preserves the cached route until observations return. Changed/blocked routes replan under the same shared two-start/64-expansion budget. No graph searches are run synchronously for return trips or chunk reload.

Snapshots include stockpile inventories, carried units, delivery flags, haul phase, cached return routes, work reservations, and movement/search state. Schema is version 6. There is no migration from earlier prototype snapshots.

## Current limits

Zones do not render items or place storage blocks. There are no dropped-item entities, physical rest/bed destinations, starvation damage, tools, container theft/destruction accounting, inventory adapters, or global navigation. Local 512-node searches can fail to connect distant locations; keep storage near work areas or provide multiple zones. Batch hauling and advanced logistics are future optimizations. The resource lifecycle and conflict behavior should remain inspectable before adding those systems.
