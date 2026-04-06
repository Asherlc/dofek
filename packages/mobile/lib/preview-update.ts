import * as Updates from "expo-updates";
import { captureException } from "./telemetry";

type PreviewUpdateResult =
  | { status: "no-update" }
  | { status: "reloading" }
  | { status: "error"; message: string };

export async function checkAndApplyPreviewUpdate(): Promise<PreviewUpdateResult> {
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) {
      return { status: "no-update" };
    }

    const fetch = await Updates.fetchUpdateAsync();
    if (!fetch.isNew) {
      return { status: "no-update" };
    }

    await Updates.reloadAsync();
    return { status: "reloading" };
  } catch (error) {
    captureException(error, { source: "preview-update" });
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
