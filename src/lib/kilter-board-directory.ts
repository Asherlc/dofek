import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aborted } from "node:util";
import { column, PowerSyncDatabase, Schema, Table } from "@powersync/node";
import { z } from "zod";

const identity = z.string().trim().min(1);
const name = z
  .string()
  .nullish()
  .transform((value) => value?.trim() || null);
const wallSchema = z.object({
  wall_uuid: identity,
  name,
  gym_uuid: identity.nullish().transform((value) => value ?? null),
});
const gymSchema = z.object({
  gym_uuid: identity,
  name,
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .nullish()
    .transform((value) => value ?? null),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .nullish()
    .transform((value) => value ?? null),
});
const wallsSchema = z
  .array(wallSchema)
  .refine(
    (rows) => new Set(rows.map((row) => row.wall_uuid)).size === rows.length,
    "Kilter Board directory returned duplicate wall identities.",
  );
const gymsSchema = z
  .array(gymSchema)
  .refine(
    (rows) => new Set(rows.map((row) => row.gym_uuid)).size === rows.length,
    "Kilter Board directory returned duplicate gym identities.",
  );

/** Read the source-owned directory without retaining a second application store. */
export class KilterBoardDirectory {
  readonly #fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  async fetch(
    credentials: (signal: AbortSignal) => Promise<{ token: string; expiresAt: Date }>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const failure = new AbortController();
    const bounded = AbortSignal.any([
      failure.signal,
      AbortSignal.timeout(120_000),
      ...(signal ? [signal] : []),
    ]);
    const directory = await mkdtemp(join(tmpdir(), "dofek-kilter-directory-"));
    try {
      bounded.throwIfAborted();
      const db = new PowerSyncDatabase({
        remoteOptions: {
          fetchImplementation: (input, init) =>
            this.#fetchFn(input, {
              ...init,
              signal: AbortSignal.any([bounded, ...(init?.signal ? [init.signal] : [])]),
            }),
        },
        schema: new Schema({
          gyms: new Table({
            gym_uuid: column.text,
            name: column.text,
            latitude: column.real,
            longitude: column.real,
          }),
          walls: new Table({ wall_uuid: column.text, name: column.text, gym_uuid: column.text }),
        }),
        database: {
          dbFilename: join(directory, "directory.db"),
          // Directory reads are serial; extra SDK threads duplicate telemetry preloads.
          readWorkerCount: 1,
          implementation: { type: "node:sqlite" },
        },
      });
      const cancellation = aborted(bounded, db).then(() => {
        throw bounded.reason;
      });
      try {
        const dispose = db.registerListener({
          statusChanged: ({ dataFlowStatus }) => {
            if (dataFlowStatus.downloadError) failure.abort(dataFlowStatus.downloadError);
          },
        });
        try {
          const subscription = await Promise.race([
            db.syncStream("global_gyms").subscribe(),
            cancellation,
          ]);
          await Promise.race([
            db.connect(
              {
                fetchCredentials: async () => ({
                  endpoint: "https://sync1.kiltergrips.com",
                  ...(await Promise.race([credentials(bounded), cancellation])),
                }),
                // This disposable mirror never writes to the upstream database.
                uploadData: async () => undefined,
              },
              { includeDefaultStreams: false },
            ),
            cancellation,
          ]);
          await Promise.race([subscription.waitForFirstSync(bounded), cancellation]);
          bounded.throwIfAborted();
          const walls = wallsSchema.parse(
            await db.getAll(
              "SELECT wall_uuid, name, gym_uuid FROM walls ORDER BY gym_uuid, wall_uuid",
            ),
          );
          const gyms = gymsSchema.parse(
            await db.getAll(
              "SELECT gym_uuid, name, latitude, longitude FROM gyms ORDER BY gym_uuid",
            ),
          );
          bounded.throwIfAborted();
          return { walls, gyms };
        } finally {
          dispose();
        }
      } finally {
        failure.abort();
        await db.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
