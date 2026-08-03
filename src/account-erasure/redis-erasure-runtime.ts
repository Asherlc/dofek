import { getSharedRedisConnection } from "../jobs/queues.ts";
import { type AccountRedisErasureResult, purgeAccountRedisState } from "./redis-erasure.ts";
import type { AccountErasureRemoteSnapshot } from "./remote-snapshot.ts";

export async function purgeAccountRedisStateForSnapshot(
  snapshot: AccountErasureRemoteSnapshot,
  bullmqJobIds: readonly string[] = [],
): Promise<AccountRedisErasureResult> {
  const connection = getSharedRedisConnection();
  const client = await connection.client;
  return purgeAccountRedisState(
    {
      authIdentities: snapshot.authIdentities.map((identity) => ({
        authProvider: identity.authProvider,
        providerAccountId: identity.providerAccountId,
      })),
      bullmqJobIds: [...bullmqJobIds],
      sessionIds: snapshot.localIdentifiers.sessionIds,
      uploadIds: snapshot.localIdentifiers.fileUploads.map((upload) => upload.uploadId),
      userId: snapshot.localIdentifiers.userId,
    },
    client,
  );
}
