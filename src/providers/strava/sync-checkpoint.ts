import { z } from "zod";
import type { SyncWindow } from "../sync-window.ts";
import type { SyncCheckpointStore } from "../types.ts";

const checkpointSchema = z.object({
  version: z.literal(1),
  sinceIso: z.iso.datetime(),
  untilIso: z.iso.datetime(),
  completedActivityExternalIds: z.array(z.string().regex(/^\d+$/)),
});

/** Provider-owned durable progress; activity writes must finish before completion is saved. */
export class StravaSyncCheckpoint {
  readonly #window: SyncWindow;
  readonly #store: SyncCheckpointStore | undefined;
  readonly #completedActivityExternalIds: Set<string>;

  constructor(window: SyncWindow, store: SyncCheckpointStore | undefined, saved: unknown) {
    const parsed = checkpointSchema.safeParse(
      saved ?? {
        version: 1,
        sinceIso: window.sinceIso,
        untilIso: window.untilIso,
        completedActivityExternalIds: [],
      },
    );
    if (!parsed.success) throw new Error("Invalid Strava sync checkpoint");
    if (parsed.data.sinceIso !== window.sinceIso || parsed.data.untilIso !== window.untilIso) {
      throw new Error("Strava sync checkpoint does not match the requested sync window");
    }
    this.#window = window;
    this.#store = store;
    this.#completedActivityExternalIds = new Set(parsed.data.completedActivityExternalIds);
  }

  static async load(
    window: SyncWindow,
    store: SyncCheckpointStore | undefined,
  ): Promise<StravaSyncCheckpoint> {
    return new StravaSyncCheckpoint(window, store, await store?.load());
  }

  get completedActivityExternalIds(): ReadonlySet<string> {
    return this.#completedActivityExternalIds;
  }

  async completeActivity(externalId: string): Promise<void> {
    this.#completedActivityExternalIds.add(externalId);
    await this.#save();
  }

  async clear(): Promise<void> {
    await this.#store?.clear();
  }

  async #save(): Promise<void> {
    await this.#store?.save({
      version: 1,
      sinceIso: this.#window.sinceIso,
      untilIso: this.#window.untilIso,
      completedActivityExternalIds: [...this.#completedActivityExternalIds],
    });
  }
}
