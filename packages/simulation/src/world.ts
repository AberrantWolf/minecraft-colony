import { key, type Block, type Change, type ChangeResult, type Voxel, type WorldPort } from './types.ts';
/** Sparse known-air test landscape. Availability and protection are explicit. */
export class MemoryWorld implements WorldPort {
  private blocks = new Map<string, Block>();
  private unavailable = new Set<string>();
  private protectedBlocks = new Set<string>();
  private receipts = new Map<string, { signature: string; result: ChangeResult }>();
  available = true;
  read(at: Voxel): Block | undefined {
    return !this.available || this.unavailable.has(key(at)) ? undefined : this.blocks.get(key(at)) ?? 'air';
  }
  set(at: Voxel, block: Block): void { this.blocks.set(key(at), block); }
  setAvailable(at: Voxel, available: boolean): void {
    if (available) this.unavailable.delete(key(at)); else this.unavailable.add(key(at));
  }
  protect(at: Voxel): void { this.protectedBlocks.add(key(at)); }
  apply(change: Change): ChangeResult | undefined {
    const signature = JSON.stringify(change);
    const receipt = this.receipts.get(change.id);
    if (receipt) {
      if (receipt.signature !== signature) throw new Error('operation ID reused with different payload');
      return { ...receipt.result };
    }
    const actual = this.read(change.at);
    if (actual === undefined) return undefined;
    const result: ChangeResult = this.protectedBlocks.has(key(change.at))
      ? { id: change.id, applied: false, actual, reason: 'protected' }
      : actual !== change.expected
        ? { id: change.id, applied: false, actual, reason: 'terrain conflict' }
        : { id: change.id, applied: true };
    if (result.applied) this.set(change.at, change.next);
    this.receipts.set(change.id, { signature, result });
    return { ...result };
  }
}
