import { createServer } from "node:http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { expect, it } from "vitest";
import { KomootProvider } from "../providers/komoot.ts";
import {
  type AccountErasureProcessorProgress,
  eraseAccountProcessors,
  verifyAccountProcessors,
} from "./processor-erasure.ts";
import { eraseStripeAccount, revokeRemoteAccounts } from "./remote-revocation.ts";
import type { AccountErasureRemoteSnapshot } from "./remote-snapshot.ts";

const SYNTHETIC_ACCOUNT_MARKER = "synthetic-account-marker";
const POSTHOG_PERSON_UUID = "20000000-0000-4000-8000-000000001994";

it("keeps processor and Komoot erasure URLs out of exported spans without disabling ordinary tracing", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Connection", "close");
    response.end("ok");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test HTTP server did not bind to a TCP port");
  }

  const originalEnabledInstrumentations = process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
  process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = "undici";
  const instrumentations = getNodeAutoInstrumentations();
  if (originalEnabledInstrumentations === undefined) {
    delete process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
  } else {
    process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = originalEnabledInstrumentations;
  }

  const exporter = new InMemorySpanExporter();
  const spanProcessor = new SimpleSpanProcessor(exporter);
  const sdk = new NodeSDK({
    autoDetectResources: false,
    instrumentations,
    spanProcessors: [spanProcessor],
  });
  sdk.start();

  const originalKomootClientId = process.env.KOMOOT_CLIENT_ID;
  const originalKomootClientSecret = process.env.KOMOOT_CLIENT_SECRET;
  process.env.KOMOOT_CLIENT_ID = "test-client";
  process.env.KOMOOT_CLIENT_SECRET = "test-client-secret";

  try {
    const origin = `http://127.0.0.1:${address.port}`;
    let receivedKomootRevocation = false;
    const provider = new KomootProvider(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      receivedKomootRevocation =
        url.pathname.endsWith("/clients/test-client/refresh_tokens/") &&
        url.searchParams.has("refresh_token");
      await (await fetch(`${origin}/account-erasure?account=${SYNTHETIC_ACCOUNT_MARKER}`)).text();
      return new Response(null, { status: 200 });
    });
    const snapshot: AccountErasureRemoteSnapshot = {
      appleCredentials: [],
      authIdentities: [],
      externalEffects: [],
      localIdentifiers: {
        activityIds: [],
        exportObjects: [],
        fileUploads: [],
        processingOperationIds: [],
        sessionIds: [],
        sleepSessionIds: [],
        userId: "10000000-0000-4000-8000-000000001994",
      },
      posthogDistinctId: "10000000-0000-4000-8000-000000001994",
      processorEmails: [],
      providerConnections: [
        {
          accessToken: "test-access-token",
          disposition: "revocation_credentials",
          expiresAt: "2026-07-26T12:00:00.000Z",
          providerId: "komoot",
          refreshToken: "test-refresh-token",
          scopes: "profile",
        },
      ],
      stripe: null,
      webhooks: [],
    };
    const observedSuppressedRequests = new Set<string>();
    const recordSuppressedRequest = async (kind: string): Promise<void> => {
      observedSuppressedRequests.add(kind);
      await (await fetch(`${origin}/account-erasure?account=${SYNTHETIC_ACCOUNT_MARKER}`)).text();
    };
    let posthogPersonListRequests = 0;
    const processorFetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "api.brevo.com" && url.pathname.includes("/smtp/log/")) {
        await recordSuppressedRequest("brevo-email-delete");
        return Response.json({ process_id: 1 });
      }
      if (url.hostname === "api.brevo.com" && url.pathname.includes("/processes/")) {
        await recordSuppressedRequest("brevo-process");
        return Response.json({ status: "completed" });
      }
      if (url.hostname === "api.brevo.com" && url.pathname.endsWith("/smtp/emails")) {
        await recordSuppressedRequest("brevo-email-query");
        return Response.json({ count: 0, transactionalEmails: [] });
      }
      if (url.pathname.endsWith("/persons/bulk_delete/")) {
        await recordSuppressedRequest("posthog-bulk-delete");
        return Response.json(
          {
            deletion_errors: [],
            events_queued_for_deletion: true,
            recordings_queued_for_deletion: true,
          },
          { status: 202 },
        );
      }
      if (url.pathname.endsWith("/persons/deletion_status/")) {
        await recordSuppressedRequest("posthog-person-query");
        return Response.json({
          results: [{ person_uuid: POSTHOG_PERSON_UUID, status: "completed" }],
        });
      }
      if (url.pathname.endsWith("/persons/")) {
        await recordSuppressedRequest("posthog-distinct-id-query");
        posthogPersonListRequests += 1;
        return Response.json({
          next: null,
          results: posthogPersonListRequests === 1 ? [{ uuid: POSTHOG_PERSON_UUID }] : [],
        });
      }
      throw new Error("Unexpected account-erasure processor request");
    };
    const zohoDesk = {
      deleteTicket: async () => {
        await recordSuppressedRequest("zoho-ticket-delete");
      },
      listTicketIdsByDofekUserId: async () => {
        await recordSuppressedRequest("zoho-user-query");
        return [`ticket-${SYNTHETIC_ACCOUNT_MARKER}`];
      },
    };
    const progress: AccountErasureProcessorProgress = {
      knownPosthogPersonUuids: [],
      savePosthogPersonUuids: async () => undefined,
    };
    const processorSnapshot = {
      ...snapshot,
      processorEmails: ["person@example.test"],
      providerConnections: [],
    };
    const processorConfig = {
      brevoApiKey: "test-brevo-key",
      posthogApiHost: "https://us.posthog.test",
      posthogPersonalApiKey: "test-posthog-key",
      posthogProjectId: "12345",
    };
    const checkpoint = await eraseAccountProcessors(processorSnapshot, processorConfig, progress, {
      fetchFn: processorFetch,
      zohoDesk,
    });
    await verifyAccountProcessors(processorSnapshot, checkpoint, processorConfig, progress, {
      fetchFn: processorFetch,
      zohoDesk,
    });
    const stripeSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      providerConnections: [],
      stripe: {
        customerId: "cus_sensitive",
        subscriptionId: "sub_sensitive",
      },
    };
    const recordStripeRequest = async (kind: string): Promise<void> => {
      await recordSuppressedRequest(kind);
    };
    await eraseStripeAccount(stripeSnapshot, {
      customers: {
        del: async () => {
          await recordStripeRequest("stripe-customer-delete");
          return { deleted: true };
        },
        list: async () => {
          await recordStripeRequest("stripe-user-query");
          return { data: [], has_more: false };
        },
      },
      subscriptions: {
        cancel: async () => {
          await recordStripeRequest("stripe-subscription-cancel");
          return { status: "canceled" };
        },
      },
    });
    await (await fetch(`${origin}/ordinary?visible=true`)).text();
    await spanProcessor.forceFlush();

    const finishedSpans = exporter.getFinishedSpans();
    const exportedFullUrls = finishedSpans.flatMap((span) =>
      typeof span.attributes["url.full"] === "string" ? [span.attributes["url.full"]] : [],
    );
    const exportedUrlAttributes = finishedSpans.flatMap((span) =>
      ["url.full", "url.query"].flatMap((attributeName) => {
        const value = span.attributes[attributeName];
        return typeof value === "string" ? [value] : [];
      }),
    );
    expect(exportedFullUrls.some((url) => url.includes("/ordinary?visible=true"))).toBe(true);
    expect(exportedFullUrls.some((url) => url.includes("/account-erasure"))).toBe(false);
    expect(exportedUrlAttributes.some((value) => value.includes(SYNTHETIC_ACCOUNT_MARKER))).toBe(
      false,
    );
    expect(receivedKomootRevocation).toBe(true);
    expect([...observedSuppressedRequests].sort()).toEqual([
      "brevo-email-delete",
      "brevo-email-query",
      "brevo-process",
      "posthog-bulk-delete",
      "posthog-distinct-id-query",
      "posthog-person-query",
      "slack-token-revocation",
      "stripe-customer-delete",
      "stripe-subscription-cancel",
      "stripe-user-query",
      "zoho-ticket-delete",
      "zoho-user-query",
    ]);
  } finally {
    if (originalKomootClientId === undefined) {
      delete process.env.KOMOOT_CLIENT_ID;
    } else {
      process.env.KOMOOT_CLIENT_ID = originalKomootClientId;
    }
    if (originalKomootClientSecret === undefined) {
      delete process.env.KOMOOT_CLIENT_SECRET;
    } else {
      process.env.KOMOOT_CLIENT_SECRET = originalKomootClientSecret;
    }
    await sdk.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
