# Bedrock adapter (planned)

Implement `WorldPort` against the Bedrock Script API, only for loaded/accessible chunks.
Return `undefined` if a change cannot be applied because a chunk is unavailable.
Do not mark a simulated task complete until Bedrock confirms the actual world edit.
Do not depend on Node builtins in the simulation core. Bedrock build pipeline and pack manifest are future milestones.
