import type { WhoopCaptureStats } from "./whoop-ble-diagnostics";

export type { WhoopUploadContext } from "../modules/whoop-ble";

import type { WhoopUploadContext } from "../modules/whoop-ble";

/** Native capture and durable delivery boundary. */
export interface WhoopBleSyncDeps {
  addCaptureErrorListener(callback: (event: { message: string }) => void): { remove(): void };
  configureUpload(context: WhoopUploadContext): Promise<void>;
  flushUploads(): Promise<void>;
  getDataPathStats(): Promise<WhoopCaptureStats>;
  findWhoop(): Promise<{ id: string; name: string | null } | null>;
  connect(peripheralId: string): Promise<boolean>;
  retryConnection(): Promise<boolean>;
  startImuStreaming(): Promise<boolean>;
  stopImuStreaming(): Promise<boolean>;
  addConnectionStateListener(
    callback: (event: { state: string; peripheralId?: string; error?: string }) => void,
  ): { remove(): void };
  disconnect(): void;
}
