import { z } from "zod/v3";
import {
  type HealthEnvelopeV1,
  type HealthUploadResponse,
  parseHealthUploadResponse,
} from "./health-contract.ts";
import type { ImuChunkPayload } from "./imu-upload.ts";

export type { ImuConnectionBinding } from "./imu-upload.ts";

import {
  summarizeZeppFetchResponse,
  type ZeppFetchResponse,
  type ZeppFetchSummary,
} from "./zepp-fetch.ts";

export class ImuUploadFailure extends Error {
  constructor(readonly summary: ZeppFetchSummary) {
    super(summary.errorMessage ?? "Dofek did not acknowledge the IMU batch.");
    this.name = "ImuUploadFailure";
  }
}

type SideFetch = (request: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<ZeppFetchResponse>;

const nonBlankString = z.string().refine((value) => value.trim().length > 0);

const connectionResponseSchema = z.object({ accountId: nonBlankString });

const connectionBindingSchema = z.object({
  serverUrl: z.string(),
  accountId: nonBlankString,
});

const uploadResponseSchema = z.object({
  status: z.literal("ok"),
  acceptedEventIds: z.array(nonBlankString),
  rejected: z.array(
    z.object({
      eventId: nonBlankString,
      issues: z.array(z.object({ path: z.string(), message: z.string() })),
    }),
  ),
});

export async function getImuConnection(
  serverUrl: string,
  token: string,
  fetch: SideFetch,
): Promise<{ serverUrl: string; accountId: string }> {
  if (!token.trim()) throw new Error("Connect Dofek from Zepp settings first.");
  const normalizedUrl = serverUrl.replace(/\/$/, "");
  const response = summarizeZeppFetchResponse(
    await fetch({
      url: `${normalizedUrl}/api/ingest/zos-imu/connection`,
      method: "GET",
      headers: { Authorization: `Bearer ${token.trim()}` },
    }),
  );
  const parsedBody = connectionResponseSchema.safeParse(response.body);
  if (response.status !== 200 || !response.ok || !parsedBody.success) {
    throw new Error(
      response.errorMessage ?? "Dofek did not return a valid IMU connection binding.",
    );
  }
  return { serverUrl: normalizedUrl, accountId: parsedBody.data.accountId };
}

export async function postImuEnvelope(
  serverUrl: string,
  token: string,
  envelope: HealthEnvelopeV1<ImuChunkPayload>,
  connection: unknown,
  fetch: SideFetch,
): Promise<HealthUploadResponse> {
  if (!token.trim()) throw new Error("Connect Dofek from Zepp settings first.");
  const parsedConnection = connectionBindingSchema.safeParse(connection);
  if (!parsedConnection.success) {
    throw new Error("Missing or invalid IMU connection binding.");
  }
  if (parsedConnection.data.serverUrl !== serverUrl.replace(/\/$/, "")) {
    throw new Error("Reconnect the original Dofek server to upload this recording.");
  }
  const response = summarizeZeppFetchResponse(
    await fetch({
      url: `${serverUrl.replace(/\/$/, "")}/api/ingest/zos-imu`,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.trim()}` },
      body: JSON.stringify({
        ...envelope,
        accountId: parsedConnection.data.accountId,
      }),
    }),
  );
  const parsedBody = uploadResponseSchema.safeParse(response.body);
  if (response.status !== 200 || !response.ok || !parsedBody.success) {
    throw new ImuUploadFailure(response);
  }
  return parseHealthUploadResponse(parsedBody.data);
}
