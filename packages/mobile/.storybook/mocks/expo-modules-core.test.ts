import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as expoModulesCore from "./expo-modules-core";
import { LegacyEventEmitter } from "./expo-modules-core";

describe("expo-modules-core Storybook mock", () => {
  it("provides the legacy emitter constructor required by Expo modules", () => {
    const listener = vi.fn();
    const emitter = new LegacyEventEmitter({});
    const subscription = emitter.addListener("notification", listener);

    expect(subscription).toEqual({ remove: expect.any(Function) });
  });

  it("registers a web module instance with the resource classes Expo Crypto extends", () => {
    class BrowserCryptoModule extends expoModulesCore.NativeModule {
      EncryptionKey = class EncryptionKey {};
      SealedData = class SealedData {};
    }

    const module = expoModulesCore.registerWebModule(BrowserCryptoModule, "TestCryptoModule");
    expect(module).toBeInstanceOf(BrowserCryptoModule);
    expect(expoModulesCore.registerWebModule(BrowserCryptoModule, "TestCryptoModule")).toBe(module);
    expect(() => new (class extends module.EncryptionKey {})()).not.toThrow();
    expect(() => new (class extends module.SealedData {})()).not.toThrow();
  });

  it("lets Expo create identifiers for browser resources", () => {
    expect(expoModulesCore.uuid.v4()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("lets Expo modules construct and release shared browser resources", () => {
    const sharedObject = new expoModulesCore.SharedObject();
    const sharedRef = new expoModulesCore.SharedRef();

    expect(() => sharedObject.release()).not.toThrow();
    expect(() => sharedRef.release()).not.toThrow();
    expect(sharedRef.nativeRefType).toBe("unknown");
  });

  it("reports native app reloads as unavailable in the browser preview", async () => {
    await expect(expoModulesCore.reloadAppAsync("Preview restart")).rejects.toMatchObject({
      code: "ERR_UNAVAILABLE",
    });
  });

  it("reports native UI runtimes as unavailable in the browser preview", () => {
    expect(() => expoModulesCore.installOnUIRuntime({})).toThrow(
      expoModulesCore.UnavailabilityError,
    );
  });

  it("lets Expo permission hooks use the supplied browser permission methods", async () => {
    const granted = {
      status: expoModulesCore.PermissionStatus.GRANTED,
      expires: "never" as const,
      granted: true,
      canAskAgain: true,
    };
    const denied = { ...granted, status: expoModulesCore.PermissionStatus.DENIED, granted: false };
    const usePermissions = expoModulesCore.createPermissionHook({
      getMethod: async () => granted,
      requestMethod: async () => denied,
    });
    const { result } = renderHook(() => usePermissions());

    await waitFor(() => expect(result.current[0]).toEqual(granted));
    await act(async () => {
      await result.current[1]();
    });
    expect(result.current[0]).toEqual(denied);
  });
});
