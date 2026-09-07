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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  if (
    response.status !== 200 ||
    !response.ok ||
    !isRecord(response.body) ||
    typeof response.body.accountId !== "string" ||
    !response.body.accountId.trim()
  ) {
    throw new Error(
      response.errorMessage ?? "Dofek did not return a valid IMU connection binding.",
    );
  }
  return { serverUrl: normalizedUrl, accountId: response.body.accountId };
}

export async function postImuEnvelope(
  serverUrl: string,
  token: string,
  envelope: HealthEnvelopeV1<ImuChunkPayload>,
  connection: unknown,
  fetch: SideFetch,
): Promise<HealthUploadResponse> {
  if (!token.trim()) throw new Error("Connect Dofek from Zepp settings first.");
  if (
    !isRecord(connection) ||
    typeof connection.serverUrl !== "string" ||
    typeof connection.accountId !== "string" ||
    !connection.accountId.trim()
  ) {
    throw new Error("Missing or invalid IMU connection binding.");
  }
  if (connection.serverUrl !== serverUrl.replace(/\/$/, "")) {
    throw new Error("Reconnect the original Dofek server to upload this recording.");
  }
  const response = summarizeZeppFetchResponse(
    await fetch({
      url: `${serverUrl.replace(/\/$/, "")}/api/ingest/zos-imu`,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.trim()}` },
      body: JSON.stringify({
        ...envelope,
        accountId: connection.accountId,
      }),
    }),
  );
  if (
    response.status !== 200 ||
    !response.ok ||
    typeof response.body !== "object" ||
    response.body === null ||
    !("status" in response.body) ||
    response.body.status !== "ok"
  ) {
    throw new ImuUploadFailure(response);
  }
  return parseHealthUploadResponse(response.body);
}
