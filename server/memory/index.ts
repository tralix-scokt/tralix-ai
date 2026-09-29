/**
 * Persistent (cross-conversation) memory — architecture only.
 *
 * V1 keeps context within a conversation (the full history is sent to the
 * model). Cross-conversation memory is deliberately OFF: it must ship together
 * with user-facing controls (view / edit / delete memories, global on/off).
 *
 * The orchestrator already asks the `MemoryStore` for memories to inject into
 * the prompt, so enabling the feature later means implementing `MemoryStore`
 * against the existing `memories` table and returning it from `createMemoryStore`.
 */
export interface MemoryStore {
  readonly enabled: boolean;
  recall(userId: string, query: string): Promise<string[]>;
  remember?(userId: string, fact: string): Promise<void>;
  forget?(userId: string, memoryId: string): Promise<void>;
}

export class DisabledMemoryStore implements MemoryStore {
  readonly enabled = false;
  async recall(): Promise<string[]> {
    return [];
  }
}

export function createMemoryStore(): MemoryStore {
  return new DisabledMemoryStore();
}
