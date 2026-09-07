import { summarizeZeppFetchResponse, type ZeppFetchResponse } from "./zepp-fetch.ts";

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

export async function postImuBatch(
  serverUrl: string,
  token: string,
  data: Record<string, unknown>,
  fetch: SideFetch,
): Promise<{ ok: true }> {
  if (!token.trim()) throw new Error("Connect Dofek from Zepp settings first.");
  const { connection } = data;
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
        data: data.data,
        sampleOffset: data.sampleOffset,
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
    throw new Error(response.errorMessage ?? "Dofek did not acknowledge the IMU batch.");
  }
  return { ok: true };
}
