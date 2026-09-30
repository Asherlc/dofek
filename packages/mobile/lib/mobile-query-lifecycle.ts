import { focusManager, onlineManager } from "@tanstack/react-query";
import * as Network from "expo-network";
import { AppState, Platform } from "react-native";
import { captureException } from "./telemetry";

export function registerMobileQueryLifecycle(): () => void {
  if (Platform.OS === "web") return () => undefined;

  let disposed = false;
  let receivedNetworkEvent = false;
  focusManager.setFocused(AppState.currentState === "active");
  // Wait for the initial native connectivity snapshot before issuing requests.
  onlineManager.setOnline(false);
  const appSubscription = AppState.addEventListener("change", (state) => {
    if (!disposed) focusManager.setFocused(state === "active");
  });
  const updateNetwork = (state: Network.NetworkState) => {
    onlineManager.setOnline(state.isConnected === true && state.isInternetReachable !== false);
  };
  const networkSubscription = Network.addNetworkStateListener((state) => {
    if (disposed) return;
    receivedNetworkEvent = true;
    updateNetwork(state);
  });
  Network.getNetworkStateAsync()
    .then((state) => {
      if (!disposed && !receivedNetworkEvent) updateNetwork(state);
    })
    .catch((error: unknown) => {
      captureException(new Error("Unable to read mobile network state"), {
        source: "mobile-query-network-state",
        failureKind: error instanceof Error ? "error" : "non-error",
      });
      // An unavailable snapshot is not evidence of an offline device.
      if (!disposed && !receivedNetworkEvent) onlineManager.setOnline(true);
    });

  return () => {
    disposed = true;
    appSubscription.remove();
    networkSubscription.remove();
  };
}
