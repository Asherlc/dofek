import { Linking } from "react-native";
import { captureException, logger } from "./telemetry";

export async function openExternalUrl(url: string, source: string): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch (error) {
    captureException(error, {
      source: "open-external-url",
      caller: source,
    });
    logger.warn(source, "Unable to open external URL", {
      url,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
