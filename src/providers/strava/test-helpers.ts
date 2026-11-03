import type { SyncCheckpointStore } from "../types.ts";

export function createMemoryCheckpointStore(initial: unknown = null): SyncCheckpointStore {
  let saved: unknown = initial;
  return {
    load: async () => structuredClone(saved),
    save: async (checkpoint) => {
      saved = structuredClone(checkpoint);
    },
    clear: async () => {
      saved = null;
    },
  };
}
