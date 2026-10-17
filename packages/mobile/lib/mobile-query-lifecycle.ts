import { focusManager, onlineManager } from "@tanstack/react-query";
import * as Network from "expo-network";
import { AppState, Platform } from "react-native";
import { captureException } from "./telemetry";

export function registerMobileQueryLifecycle(): () => void {
  if (Platform.OS === "web") return () => undefined;

  let disposed = false;
  let receivedNetworkEvent = false;
  let active = AppState.currentState === "active";
  let connected = false;
  const updateOnline = () => onlineManager.setOnline(active && connected);

  focusManager.setFocused(active);
  // Wait for the initial native connectivity snapshot before issuing requests.
  updateOnline();
  const appSubscription = AppState.addEventListener("change", (state) => {
    if (disposed) return;
    active = state === "active";
    focusManager.setFocused(active);
    // Focus alone does not pause reconnect or invalidation-triggered refetches.
    updateOnline();
  });
  const updateNetwork = (state: Network.NetworkState) => {
    connected = state.isConnected === true && state.isInternetReachable !== false;
    updateOnline();
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
      if (!disposed && !receivedNetworkEvent) {
        connected = true;
        updateOnline();
      }
    });

  return () => {
    disposed = true;
    appSubscription.remove();
    networkSubscription.remove();
  };
}
