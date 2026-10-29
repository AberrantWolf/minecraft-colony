import { key, type Colony, type Dwarf, type MovementCommand, type MovementFeedback } from './types.ts';
import { MOVEMENT } from './navigation.ts';

function envelope(c: Colony, d: Dwarf) {
  const revision = ++d.motionRevision;
  return { id: `${d.id}:motion:${revision}`, dwarfId: d.id, revision, issuedTick: c.tick };
}
/** Persist a replacement command; adapters discard older revisions and stop any old navigation. */
export function stopMovement(c: Colony, d: Dwarf, reason: string, force = false): void {
  if (force || d.motion?.kind === 'move') d.motion = { ...envelope(c, d), kind: 'stop', at: { ...d.position }, reason };
  d.moveTicks = 0;
}
export function beginMovement(c: Colony, d: Dwarf): void {
  if (d.motion?.kind === 'move') return;
  d.motion = { ...envelope(c, d), kind: 'move', from: { ...d.position }, to: { ...d.path[0]! },
    durationTicks: MOVEMENT.ticksPerBlock, blocksPerSecond: MOVEMENT.ticksPerSecond / MOVEMENT.ticksPerBlock };
}
/** Latest desired commands are retriable, detached snapshots, not a growing per-frame event queue. */
export function getMovementCommands(c: Colony, afterRevisions: Record<string, number> = {}): MovementCommand[] {
  return c.dwarves.flatMap(d => d.motion && d.motion.revision > (afterRevisions[d.id] ?? -1)
    ? [d.motion.kind === 'move' ? { ...d.motion, from: { ...d.motion.from }, to: { ...d.motion.to } } : { ...d.motion, at: { ...d.motion.at } }] : []);
}
/** Ordered adapter inputs. Corrections report reality; they never infer terrain or finish work. */
export function observeMovement(c: Colony, feedback: MovementFeedback): boolean {
  if (!feedback || !['arrived', 'corrected', 'unavailable'].includes(feedback.kind)) return false;
  const d = c.dwarves.find(d => d.id === feedback.dwarfId);
  if (!d || !Number.isSafeInteger(feedback.sequence) || feedback.sequence <= d.lastMotionSequence
    || feedback.revision !== d.motionRevision) return false;
  if (feedback.kind !== 'unavailable' && (!feedback.position || ![feedback.position.x, feedback.position.y, feedback.position.z].every(Number.isSafeInteger))) return false;
  if (feedback.kind === 'arrived') {
    if (d.motion?.kind !== 'move' || key(feedback.position) !== key(d.motion.to)) return false;
    d.actionNotBeforeTick = Math.max(c.tick + 1, d.motion.issuedTick + d.motion.durationTicks);
    d.position = { ...feedback.position }; d.positionKnown = true;
    d.path.shift(); stopMovement(c, d, 'arrived', true);
  } else {
    if (feedback.kind === 'corrected') { d.position = { ...feedback.position }; d.positionKnown = true; }
    else d.positionKnown = false;
    d.path = []; delete d.search; d.searchRetryAt = 0;
    d.actionNotBeforeTick = Math.max(d.actionNotBeforeTick, c.tick + 1);
    stopMovement(c, d, feedback.kind, true);
    c.events.push(`tick ${c.tick}: ${d.id} movement ${feedback.kind}`);
  }
  d.lastMotionSequence = feedback.sequence;
  return true;
}
