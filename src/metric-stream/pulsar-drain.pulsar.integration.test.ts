import { randomUUID } from "node:crypto";
import Pulsar from "pulsar-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertAccountErasureSubscriptionsDrained,
  captureAccountErasureNativeFenceProgress,
  createPulsarDrainAdminFromUrls,
} from "./pulsar-drain.ts";

/** Fixture-only destination_storage byte limit under producer_request_hold (not a production claim). */
const FIXTURE_DESTINATION_STORAGE_BYTES = 64 * 1024 * 1024;

describe("native capture + ACK-cursor drain on a disposable namespace", () => {
  let serviceUrl: string;
  let adminUrl: string;
  let ownedNamespace: string;
  const ownedTopics: string[] = [];

  beforeAll(() => {
    const service = process.env.PULSAR_TEST_SERVICE_URL;
    const admin = process.env.PULSAR_TEST_ADMIN_URL;
    if (!service || !admin)
      throw new Error("PULSAR_TEST_SERVICE_URL and PULSAR_TEST_ADMIN_URL are required");
    serviceUrl = service;
    adminUrl = admin;
    ownedNamespace = `public/erasure-cap-${randomUUID().slice(0, 8)}`;
  });

  afterAll(async () => {
    for (const topic of ownedTopics.splice(0)) {
      const path = topic.replace("persistent://", "");
      await fetch(`${adminUrl}/admin/v2/persistent/${path}?force=true`, { method: "DELETE" });
    }
    if (ownedNamespace) {
      const deleted = await fetch(`${adminUrl}/admin/v2/namespaces/${ownedNamespace}`, {
        method: "DELETE",
      });
      expect([204, 404]).toContain(deleted.status);
    }
  });

  async function putJson(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${adminUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (![200, 204].includes(response.status)) {
      throw new Error(`POST ${path} failed HTTP ${response.status}: ${await response.text()}`);
    }
  }

  async function ensureOwnedNamespacePolicies(): Promise<void> {
    const created = await fetch(`${adminUrl}/admin/v2/namespaces/${ownedNamespace}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect([204, 409]).toContain(created.status);
    await putJson(`/admin/v2/namespaces/${ownedNamespace}/retention`, {
      retentionTimeInMinutes: 1440,
      retentionSizeInMB: -1,
    });
    await putJson(`/admin/v2/namespaces/${ownedNamespace}/messageTTL`, 1_209_600);
    await putJson(
      `/admin/v2/namespaces/${ownedNamespace}/backlogQuota?backlogQuotaType=destination_storage`,
      {
        limit: FIXTURE_DESTINATION_STORAGE_BYTES,
        limitSize: FIXTURE_DESTINATION_STORAGE_BYTES,
        policy: "producer_request_hold",
      },
    );
    await putJson(
      `/admin/v2/namespaces/${ownedNamespace}/backlogQuota?backlogQuotaType=message_age`,
      {
        limitTime: 1_209_600,
        policy: "producer_request_hold",
      },
    );
    await putJson(`/admin/v2/namespaces/${ownedNamespace}/inactiveTopicPolicies`, {
      inactiveTopicDeleteMode: "delete_when_no_subscriptions",
      maxInactiveDurationSeconds: 31_536_000,
      deleteWhileInactive: false,
    });
  }

  async function withOwnedTopic(
    verify: (input: {
      admin: ReturnType<typeof createPulsarDrainAdminFromUrls>;
      client: Pulsar.Client;
      stream: { epoch: string; topic: string; partition: number };
      subscription: string;
      topicAdminPath: string;
    }) => Promise<void>,
  ) {
    await ensureOwnedNamespacePolicies();
    const name = `cap-${randomUUID()}`;
    const [, nsName = ""] = ownedNamespace.split("/");
    const stream = {
      epoch: randomUUID(),
      topic: `persistent://${ownedNamespace}/${name}`,
      partition: -1,
    };
    const topicAdminPath = `/admin/v2/persistent/public/${nsName}/${name}`;
    ownedTopics.push(stream.topic);
    const subscription = `archive-${randomUUID()}`;
    const admin = createPulsarDrainAdminFromUrls({ adminUrl });
    const created = await fetch(`${adminUrl}${topicAdminPath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect([204, 409]).toContain(created.status);
    const client = new Pulsar.Client({ serviceUrl });
    try {
      await verify({ admin, client, stream, subscription, topicAdminPath });
    } finally {
      await client.close();
      const removed = await fetch(`${adminUrl}${topicAdminPath}?force=true`, { method: "DELETE" });
      expect([204, 404]).toContain(removed.status);
      const index = ownedTopics.indexOf(stream.topic);
      if (index >= 0) ownedTopics.splice(index, 1);
    }
  }

  it("rejects when the durable subscription is behind the fence", async () => {
    await withOwnedTopic(async ({ admin, client, stream, subscription }) => {
      const producer = await client.createProducer({
        topic: stream.topic,
        batchingEnabled: false,
      });
      try {
        await producer.send({ data: Buffer.from("one") });
        await producer.send({ data: Buffer.from("two") });
      } finally {
        await producer.close();
      }
      const { fence } = await captureAccountErasureNativeFenceProgress(admin, stream);
      expect(fence.state).toBe("message");
      const consumer = await client.subscribe({
        topic: stream.topic,
        subscription,
        subscriptionType: "Exclusive",
        subscriptionInitialPosition: "Earliest",
        receiverQueueSize: 20,
        batchIndexAckEnabled: true,
      });
      try {
        const first = await consumer.receive();
        await consumer.acknowledge(first);
        await expect(
          assertAccountErasureSubscriptionsDrained(admin, fence, [subscription]),
        ).rejects.toThrow(subscription);
      } finally {
        await consumer.close();
      }
    });
  });

  it("rejects gap ACKs and does not let newer publishes mask the hole", async () => {
    await withOwnedTopic(async ({ admin, client, stream, subscription }) => {
      const producer = await client.createProducer({
        topic: stream.topic,
        batchingEnabled: false,
      });
      try {
        await producer.send({ data: Buffer.from("a") });
        await producer.send({ data: Buffer.from("b") });
        await producer.send({ data: Buffer.from("c") });
      } finally {
        await producer.close();
      }
      const { fence } = await captureAccountErasureNativeFenceProgress(admin, stream);
      const consumer = await client.subscribe({
        topic: stream.topic,
        subscription,
        subscriptionType: "Exclusive",
        subscriptionInitialPosition: "Earliest",
        receiverQueueSize: 20,
        batchIndexAckEnabled: true,
      });
      try {
        const held = [await consumer.receive(), await consumer.receive(), await consumer.receive()];
        await consumer.acknowledge(held[2]!);
        await expect(
          assertAccountErasureSubscriptionsDrained(admin, fence, [subscription]),
        ).rejects.toThrow(subscription);
        const late = await client.createProducer({
          topic: stream.topic,
          batchingEnabled: false,
        });
        try {
          await late.send({ data: Buffer.from("newer-than-fence") });
        } finally {
          await late.close();
        }
        await expect(
          assertAccountErasureSubscriptionsDrained(admin, fence, [subscription]),
        ).rejects.toThrow(subscription);
      } finally {
        await consumer.close();
      }
    });
  });

  it("passes only after contiguous ACK through the fence, before any rewrite gate", async () => {
    await withOwnedTopic(async ({ admin, client, stream, subscription }) => {
      const producer = await client.createProducer({
        topic: stream.topic,
        batchingEnabled: false,
      });
      try {
        await producer.send({ data: Buffer.from("one") });
        await producer.send({ data: Buffer.from("two") });
      } finally {
        await producer.close();
      }
      const { fence } = await captureAccountErasureNativeFenceProgress(admin, stream);
      const consumer = await client.subscribe({
        topic: stream.topic,
        subscription,
        subscriptionType: "Exclusive",
        subscriptionInitialPosition: "Earliest",
        receiverQueueSize: 20,
        batchIndexAckEnabled: true,
      });
      try {
        await expect(
          assertAccountErasureSubscriptionsDrained(admin, fence, [subscription]),
        ).rejects.toThrow(subscription);
        const first = await consumer.receive();
        await consumer.acknowledge(first);
        await expect(
          assertAccountErasureSubscriptionsDrained(admin, fence, [subscription]),
        ).rejects.toThrow(subscription);
        const second = await consumer.receive();
        await consumer.acknowledge(second);
        await expect
          .poll(
            async () => {
              await assertAccountErasureSubscriptionsDrained(admin, fence, [subscription]);
              return true;
            },
            { interval: 50, timeout: 5_000 },
          )
          .toBe(true);
        const late = await client.createProducer({
          topic: stream.topic,
          batchingEnabled: false,
        });
        try {
          await late.send({ data: Buffer.from("after-fence") });
        } finally {
          await late.close();
        }
        await expect(
          assertAccountErasureSubscriptionsDrained(admin, fence, [subscription]),
        ).resolves.toBeUndefined();
      } finally {
        await consumer.close();
      }
    });
  });

  it("treats an empty fence as drained once the durable subscription exists", async () => {
    await withOwnedTopic(async ({ admin, client, stream, subscription }) => {
      const { fence } = await captureAccountErasureNativeFenceProgress(admin, stream);
      expect(fence.state).toBe("empty");
      await expect(
        assertAccountErasureSubscriptionsDrained(admin, fence, [subscription]),
      ).rejects.toThrow(subscription);
      const consumer = await client.subscribe({
        topic: stream.topic,
        subscription,
        subscriptionType: "Exclusive",
        subscriptionInitialPosition: "Earliest",
        receiverQueueSize: 20,
        batchIndexAckEnabled: true,
      });
      await consumer.close();
      await expect(
        assertAccountErasureSubscriptionsDrained(admin, fence, [subscription]),
      ).resolves.toBeUndefined();
    });
  });

});
