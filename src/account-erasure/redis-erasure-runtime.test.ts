import { describe, expect, it, vi } from "vitest";
import type { AccountErasureRemoteSnapshot } from "./remote-snapshot.ts";

const mocks = vi.hoisted(() => ({
  purgeAccountRedisState: vi.fn(async () => ({
    aofPersisted: true,
    deletedKeys: 4,
    deletedStreamEntries: 2,
    rdbPersisted: true,
    removedSetMembers: 1,
    scanPasses: 2,
  })),
  redisClient: { name: "redis-client" },
}));

vi.mock("./redis-erasure.ts", () => ({
  purgeAccountRedisState: mocks.purgeAccountRedisState,
}));

vi.mock("../jobs/queues.ts", () => ({
  getSharedRedisConnection: vi.fn(() => ({
    client: Promise.resolve(mocks.redisClient),
  })),
}));

import { purgeAccountRedisStateForSnapshot } from "./redis-erasure-runtime.ts";

const snapshot: AccountErasureRemoteSnapshot = {
  appleCredentials: [],
  authIdentities: [],
  externalEffects: [],
  localIdentifiers: {
    activityIds: [],
    exportObjects: [],
    fileUploads: [
      {
        importJobId: null,
        multipartUploadId: null,
        objectKey: "imports/user/upload",
        uploadId: "30000000-0000-4000-8000-000000001994",
      },
    ],
    processingOperationIds: [],
    sessionIds: ["session-1994"],
    sleepSessionIds: [],
    userId: "40000000-0000-4000-8000-000000001994",
  },
  posthogDistinctId: "posthog-distinct-1994",
  processorEmails: [],
  providerConnections: [],
  slackInstallations: [],
  stripe: null,
  webhooks: [],
};

describe("purgeAccountRedisStateForSnapshot", () => {
  it("uses the canonical local user ID instead of the PostHog distinct ID", async () => {
    await purgeAccountRedisStateForSnapshot(snapshot, ["bullmq-job-1994"]);

    expect(mocks.purgeAccountRedisState).toHaveBeenCalledWith(
      {
        authIdentities: [],
        bullmqJobIds: ["bullmq-job-1994"],
        sessionIds: ["session-1994"],
        uploadIds: ["30000000-0000-4000-8000-000000001994"],
        userId: snapshot.localIdentifiers.userId,
      },
      mocks.redisClient,
    );
  });

  it("passes provider identity pairs into Redis cleanup", async () => {
    const snapshotWithIdentity: AccountErasureRemoteSnapshot = {
      ...snapshot,
      authIdentities: [
        {
          authProvider: "slack",
          email: null,
          providerAccountId: "slack-account-1994",
        },
      ],
    };

    await purgeAccountRedisStateForSnapshot(snapshotWithIdentity, []);

    expect(mocks.purgeAccountRedisState).toHaveBeenCalledWith(
      expect.objectContaining({
        authIdentities: [
          {
            authProvider: "slack",
            providerAccountId: "slack-account-1994",
          },
        ],
      }),
      mocks.redisClient,
    );
  });
});
