import { parseHealthUploadResponse, type ZeppConnectionType } from "./health-contract.ts";
import { createImuChunkEnvelope } from "./imu-upload.ts";
import type { ImuSample } from "./types.ts";

export async function deliverImuChunk(
  input: {
    connectionType: ZeppConnectionType;
    installId: string;
    segmentId: string;
    sessionStartMs: number;
    hasGyroscope: boolean;
    samples: ImuSample[];
  },
  request: (envelope: unknown) => Promise<unknown>,
): Promise<void> {
  const envelope = createImuChunkEnvelope(input);
  const response = parseHealthUploadResponse(await request(envelope));
  const eventId = envelope.events[0]?.eventId;
  if (!eventId || !response.acceptedEventIds.includes(eventId)) {
    throw new Error("Phone did not persist the IMU chunk.");
  }
}
