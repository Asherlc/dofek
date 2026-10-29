import {
  type StaticMapCreateOptions,
  StaticMapImageManager,
} from "@maplibre/maplibre-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { captureException } from "./telemetry";

export function useNativeMapSnapshot(options: StaticMapCreateOptions | null) {
  const requestKey = JSON.stringify(options);
  const cachedRequest = useRef({ requestKey, options });
  if (cachedRequest.current.requestKey !== requestKey)
    cachedRequest.current = { requestKey, options };
  const request = cachedRequest.current.options;
  const [uri, setUri] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!request) return;
    let active = true;
    setUri(null);
    setReady(false);
    setFailed(false);
    StaticMapImageManager.createImage(request)
      .then((image) => {
        if (active) setUri(image);
      })
      .catch((error: unknown) => {
        captureException(error);
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [request]);
  const onLoad = useCallback(() => setReady(true), []);
  const onError = useCallback(() => {
    captureException(new Error("Map preview image failed to load"));
    setFailed(true);
  }, []);
  return { uri, ready, failed, onLoad, onError };
}
