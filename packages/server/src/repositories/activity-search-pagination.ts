import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  decryptCredentialValue,
  encryptCredentialValue,
  isEncryptedCredentialValue,
} from "dofek/security/credential-encryption";
import { z } from "zod";

export const activitySearchCursorSchema = z.string().max(2_048).refine(isEncryptedCredentialValue);

export function activitySearchCursor<Schema extends z.ZodType>(
  schema: Schema,
  scope: readonly unknown[],
) {
  const scopeId = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  const context = { tableName: "activity_search", columnName: "cursor", scopeId };
  return {
    async decode(cursor: string): Promise<z.output<Schema>> {
      try {
        const token = activitySearchCursorSchema.parse(cursor);
        return schema.parse(JSON.parse(await decryptCredentialValue(token, context)));
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Search filters changed. Start a new search.",
        });
      }
    },
    encode(position: z.output<Schema>): Promise<string> {
      return encryptCredentialValue(JSON.stringify(position), context);
    },
  };
}

const maxBatchesPerPage = 8;

export async function pageActivitySearch<Activity extends { id: string }, Position>({
  load,
  hydrate,
  initialPosition,
  encode,
  pageSize,
}: {
  load: (
    after: Position | undefined,
    limit: number,
  ) => Promise<{ id: string; position: Position }[]>;
  hydrate: (ids: string[]) => Promise<Activity[]>;
  initialPosition: Position | undefined;
  encode: (position: Position) => Promise<string>;
  pageSize: number;
}): Promise<{ activities: Activity[]; next: string | null }> {
  const limit = pageSize + 1;
  const activities: Activity[] = [];
  let after = initialPosition;
  for (let batch = 0; batch < maxBatchesPerPage; batch++) {
    const hits = await load(after, limit);
    if (hits.length === 0) return { activities, next: null };
    const available = await hydrate(hits.map(({ id }) => id));
    const byId = new Map(available.map((activity) => [activity.id, activity]));
    for (const hit of hits) {
      const activity = byId.get(hit.id);
      if (activity) {
        if (activities.length === pageSize && after !== undefined) {
          return { activities, next: await encode(after) };
        }
        activities.push(activity);
      }
      after = hit.position;
    }
    if (hits.length < limit) return { activities, next: null };
  }
  return { activities, next: after === undefined ? null : await encode(after) };
}
