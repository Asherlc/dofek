import { z } from "zod";
import { getZohoDeskClient, type ZohoDeskClient } from "../zoho-desk.ts";
import type { AccountErasureRemoteSnapshot } from "./remote-snapshot.ts";
import { withAccountErasureTracingSuppressed } from "./tracing.ts";

const processorConfigSchema = z.object({
  brevoApiKey: z.string().min(1),
  posthogApiHost: z.url(),
  posthogPersonalApiKey: z.string().min(1),
  posthogProjectId: z.string().min(1),
});

const posthogPersonListSchema = z.object({
  next: z.string().nullable().optional(),
  results: z.array(z.object({ uuid: z.uuid() })),
});
const posthogBulkDeleteSchema = z.object({
  deletion_errors: z.array(z.unknown()),
  events_queued_for_deletion: z.boolean(),
  recordings_queued_for_deletion: z.boolean(),
});
const posthogDeletionStatusSchema = z.object({
  results: z.array(
    z.object({
      person_uuid: z.uuid(),
      status: z.enum(["completed", "pending"]),
    }),
  ),
});
const brevoDeleteProcessSchema = z.object({
  process_id: z.coerce.number().int().positive(),
});
const brevoProcessSchema = z.object({
  status: z.string().min(1),
});
const brevoTransactionalEmailsSchema = z.object({
  count: z.coerce.number().int().nonnegative(),
  transactionalEmails: z.array(z.unknown()),
});

const processorCheckpointSchema = z.object({
  brevoProcesses: z.array(
    z.object({
      email: z.email(),
      processId: z.number().int().positive().nullable(),
    }),
  ),
  posthogPersonUuids: z.array(z.uuid()),
  posthogQueued: z.boolean(),
  zohoTicketIds: z.array(z.string().min(1)),
});

export type AccountErasureProcessorConfig = z.infer<typeof processorConfigSchema>;
export type AccountErasureProcessorCheckpoint = z.infer<typeof processorCheckpointSchema>;

export interface AccountErasureProcessorProgress {
  knownPosthogPersonUuids: readonly string[];
  savePosthogPersonUuids(personUuids: readonly string[]): Promise<void>;
}

interface AccountErasureProcessorDependencies {
  fetchFn?: typeof globalThis.fetch;
  zohoDesk?: Pick<ZohoDeskClient, "deleteTicket" | "listTicketIdsByDofekUserId">;
}

function requiredEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required for account erasure`);
  }
  return value;
}

export function accountErasureProcessorConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AccountErasureProcessorConfig {
  return processorConfigSchema.parse({
    brevoApiKey: requiredEnvironmentValue(env, "BREVO_API_KEY"),
    posthogApiHost: env.POSTHOG_API_HOST?.trim() || "https://us.posthog.com",
    posthogPersonalApiKey: requiredEnvironmentValue(env, "POSTHOG_PERSONAL_API_KEY"),
    posthogProjectId: requiredEnvironmentValue(env, "POSTHOG_PROJECT_ID"),
  });
}

function normalizedPosthogOrigin(config: AccountErasureProcessorConfig): string {
  return new URL(config.posthogApiHost).origin;
}

function posthogHeaders(config: AccountErasureProcessorConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.posthogPersonalApiKey}`,
    "Content-Type": "application/json",
  };
}

async function deleteBrevoTransactionalLogs(
  emails: readonly string[],
  config: AccountErasureProcessorConfig,
  fetchFn: typeof globalThis.fetch,
): Promise<Array<{ email: string; processId: number | null }>> {
  const uniqueEmails = [...new Set(emails)];
  const processes: Array<{ email: string; processId: number | null }> = [];
  for (const email of uniqueEmails) {
    const response = await fetchFn(
      `https://api.brevo.com/v3/smtp/log/${encodeURIComponent(email)}`,
      {
        method: "DELETE",
        headers: { "api-key": config.brevoApiKey },
      },
    );
    if (response.status === 404) {
      processes.push({ email, processId: null });
      continue;
    }
    if (!response.ok) {
      throw new Error(`Brevo transactional-log deletion failed with status ${response.status}`);
    }
    const result = brevoDeleteProcessSchema.parse(await response.json());
    processes.push({ email, processId: result.process_id });
  }
  return processes;
}

async function verifyBrevoTransactionalLogs(
  processes: readonly { email: string; processId: number | null }[],
  config: AccountErasureProcessorConfig,
  fetchFn: typeof globalThis.fetch,
): Promise<number> {
  for (const process of processes) {
    if (process.processId !== null) {
      const processResponse = await fetchFn(
        `https://api.brevo.com/v3/processes/${process.processId}`,
        { headers: { "api-key": config.brevoApiKey } },
      );
      if (!processResponse.ok) {
        throw new Error(
          `Brevo deletion-process lookup failed with status ${processResponse.status}`,
        );
      }
      const status = brevoProcessSchema.parse(await processResponse.json()).status;
      if (status !== "completed") {
        throw new Error(`Brevo transactional-log deletion is ${status}`);
      }
    }
    const logUrl = new URL("https://api.brevo.com/v3/smtp/emails");
    logUrl.searchParams.set("email", process.email);
    logUrl.searchParams.set("limit", "1");
    logUrl.searchParams.set("offset", "0");
    const logResponse = await fetchFn(logUrl, {
      headers: { "api-key": config.brevoApiKey },
    });
    if (!logResponse.ok) {
      throw new Error(
        `Brevo transactional-log verification failed with status ${logResponse.status}`,
      );
    }
    const logs = brevoTransactionalEmailsSchema.parse(await logResponse.json());
    if (logs.count > 0 || logs.transactionalEmails.length > 0) {
      await deleteBrevoTransactionalLogs([process.email], config, fetchFn);
      throw new Error("Brevo still returns transactional logs after account erasure");
    }
  }
  return processes.length;
}

async function deleteZohoTickets(
  snapshot: AccountErasureRemoteSnapshot,
  knownTicketIds: readonly string[],
  zohoDesk?: Pick<ZohoDeskClient, "deleteTicket" | "listTicketIdsByDofekUserId">,
): Promise<string[]> {
  const client = zohoDesk ?? getZohoDeskClient();
  const recordedTicketIds = snapshot.externalEffects
    .filter((effect) => effect.system === "zoho_desk")
    .map((effect) => effect.externalId);
  const legacyTicketIds = await client.listTicketIdsByDofekUserId(snapshot.localIdentifiers.userId);
  const ticketIds = [...new Set([...recordedTicketIds, ...knownTicketIds, ...legacyTicketIds])];
  for (const ticketId of ticketIds) {
    await client.deleteTicket(ticketId);
  }
  return ticketIds;
}

async function listPosthogPersonUuids(
  distinctId: string,
  config: AccountErasureProcessorConfig,
  fetchFn: typeof globalThis.fetch,
): Promise<string[]> {
  const url = new URL(
    `/api/projects/${encodeURIComponent(config.posthogProjectId)}/persons/`,
    normalizedPosthogOrigin(config),
  );
  url.searchParams.set("distinct_id", distinctId);
  url.searchParams.set("limit", "1000");
  const response = await fetchFn(url, {
    headers: posthogHeaders(config),
  });
  if (!response.ok) {
    throw new Error(`PostHog person lookup failed with status ${response.status}`);
  }
  const parsed = posthogPersonListSchema.parse(await response.json());
  if (parsed.next) {
    throw new Error("PostHog person lookup unexpectedly exceeded one 1000-person page");
  }
  return parsed.results.map((person) => person.uuid);
}

async function queuePosthogDeletion(
  distinctId: string,
  config: AccountErasureProcessorConfig,
  fetchFn: typeof globalThis.fetch,
): Promise<void> {
  const url = new URL(
    `/api/projects/${encodeURIComponent(config.posthogProjectId)}/persons/bulk_delete/`,
    normalizedPosthogOrigin(config),
  );
  const response = await fetchFn(url, {
    body: JSON.stringify({
      delete_events: true,
      delete_recordings: true,
      distinct_ids: [distinctId],
      keep_person: false,
    }),
    headers: posthogHeaders(config),
    method: "POST",
  });
  if (response.status !== 202) {
    throw new Error(`PostHog bulk deletion failed with status ${response.status}`);
  }
  const parsed = posthogBulkDeleteSchema.parse(await response.json());
  if (parsed.deletion_errors.length > 0) {
    throw new Error(`PostHog bulk deletion returned ${parsed.deletion_errors.length} error(s)`);
  }
  if (!parsed.events_queued_for_deletion || !parsed.recordings_queued_for_deletion) {
    throw new Error("PostHog did not acknowledge event and recording deletion");
  }
}

async function loadPosthogDeletionStatus(
  personUuid: string,
  config: AccountErasureProcessorConfig,
  fetchFn: typeof globalThis.fetch,
): Promise<"completed" | "pending"> {
  const url = new URL(
    `/api/projects/${encodeURIComponent(config.posthogProjectId)}/persons/deletion_status/`,
    normalizedPosthogOrigin(config),
  );
  url.searchParams.set("person_uuid", personUuid);
  url.searchParams.set("status", "all");
  const response = await fetchFn(url, {
    headers: posthogHeaders(config),
  });
  if (!response.ok) {
    throw new Error(`PostHog deletion-status lookup failed with status ${response.status}`);
  }
  const parsed = posthogDeletionStatusSchema.parse(await response.json());
  const statuses = parsed.results
    .filter((result) => result.person_uuid === personUuid)
    .map((result) => result.status);
  if (statuses.includes("pending")) return "pending";
  if (statuses.includes("completed")) return "completed";
  throw new Error("PostHog deletion-status lookup did not include the queued person");
}

async function persistPosthogPersonUuids(
  discoveredPersonUuids: readonly string[],
  progress: AccountErasureProcessorProgress,
): Promise<string[]> {
  const personUuids = z
    .array(z.uuid())
    .parse([...new Set([...progress.knownPosthogPersonUuids, ...discoveredPersonUuids])].sort());
  await progress.savePosthogPersonUuids(personUuids);
  return personUuids;
}

function resolveDependencies(dependencies: AccountErasureProcessorDependencies): {
  fetchFn: typeof globalThis.fetch;
  zohoDesk?: Pick<ZohoDeskClient, "deleteTicket" | "listTicketIdsByDofekUserId">;
} {
  return {
    fetchFn: dependencies.fetchFn ?? globalThis.fetch,
    zohoDesk: dependencies.zohoDesk,
  };
}

export async function eraseAccountProcessors(
  snapshot: AccountErasureRemoteSnapshot,
  rawConfig: AccountErasureProcessorConfig,
  progress: AccountErasureProcessorProgress,
  rawDependencies: AccountErasureProcessorDependencies = {},
): Promise<AccountErasureProcessorCheckpoint> {
  return withAccountErasureTracingSuppressed(async () => {
    const config = processorConfigSchema.parse(rawConfig);
    const dependencies = resolveDependencies(rawDependencies);
    const [brevoProcesses, zohoTicketIds, discoveredPosthogPersonUuids] = await Promise.all([
      deleteBrevoTransactionalLogs(snapshot.processorEmails, config, dependencies.fetchFn),
      deleteZohoTickets(snapshot, [], dependencies.zohoDesk),
      listPosthogPersonUuids(snapshot.posthogDistinctId, config, dependencies.fetchFn),
    ]);
    const posthogPersonUuids = await persistPosthogPersonUuids(
      discoveredPosthogPersonUuids,
      progress,
    );
    if (discoveredPosthogPersonUuids.length > 0) {
      await queuePosthogDeletion(snapshot.posthogDistinctId, config, dependencies.fetchFn);
    }
    return processorCheckpointSchema.parse({
      brevoProcesses,
      posthogPersonUuids,
      posthogQueued: posthogPersonUuids.length > 0,
      zohoTicketIds,
    });
  });
}

export async function verifyAccountProcessors(
  snapshot: AccountErasureRemoteSnapshot,
  rawCheckpoint: Record<string, unknown> | null,
  rawConfig: AccountErasureProcessorConfig,
  progress: AccountErasureProcessorProgress,
  rawDependencies: AccountErasureProcessorDependencies = {},
): Promise<Record<string, unknown>> {
  return withAccountErasureTracingSuppressed(async () => {
    const checkpoint = processorCheckpointSchema.parse(rawCheckpoint);
    const config = processorConfigSchema.parse(rawConfig);
    const dependencies = resolveDependencies(rawDependencies);
    const [brevoLogsVerified, zohoTicketIds, currentPosthogPersonUuids] = await Promise.all([
      verifyBrevoTransactionalLogs(checkpoint.brevoProcesses, config, dependencies.fetchFn),
      deleteZohoTickets(snapshot, checkpoint.zohoTicketIds, dependencies.zohoDesk),
      listPosthogPersonUuids(snapshot.posthogDistinctId, config, dependencies.fetchFn),
    ]);
    const personUuids = await persistPosthogPersonUuids(
      [...checkpoint.posthogPersonUuids, ...currentPosthogPersonUuids],
      progress,
    );
    if (currentPosthogPersonUuids.length > 0) {
      await queuePosthogDeletion(snapshot.posthogDistinctId, config, dependencies.fetchFn);
    }
    const statuses = await Promise.all(
      personUuids.map((personUuid) =>
        loadPosthogDeletionStatus(personUuid, config, dependencies.fetchFn),
      ),
    );
    if (statuses.includes("pending")) {
      throw new Error("PostHog deletion is still pending");
    }
    const remainingPersonUuids = await listPosthogPersonUuids(
      snapshot.posthogDistinctId,
      config,
      dependencies.fetchFn,
    );
    if (remainingPersonUuids.length > 0) {
      await persistPosthogPersonUuids([...personUuids, ...remainingPersonUuids], progress);
      await queuePosthogDeletion(snapshot.posthogDistinctId, config, dependencies.fetchFn);
      throw new Error(
        `PostHog still returns ${remainingPersonUuids.length} person record(s) after deletion`,
      );
    }
    return {
      brevoLogsVerified,
      posthogDeletionsCompleted: statuses.length,
      zohoTickets: zohoTicketIds.length,
    };
  });
}
