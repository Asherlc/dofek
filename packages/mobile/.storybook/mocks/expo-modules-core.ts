import { createRef, type RefObject, useEffect, useState } from "react";

export function createSnapshotFriendlyRef<T>(): RefObject<T | null> {
  return createRef<T>();
}

export const PermissionStatus = {
  GRANTED: "granted",
  UNDETERMINED: "undetermined",
  DENIED: "denied",
} as const;

interface StorybookPermissionResponse {
  status: (typeof PermissionStatus)[keyof typeof PermissionStatus];
  expires: "never" | number;
  granted: boolean;
  canAskAgain: boolean;
}

export function createPermissionHook<Permission extends StorybookPermissionResponse>(methods: {
  getMethod(): Promise<Permission>;
  requestMethod(): Promise<Permission>;
}) {
  return function usePermissions() {
    const [permission, setPermission] = useState<Permission | null>(null);
    useEffect(() => {
      void methods.getMethod().then(setPermission);
    }, []);

    const requestPermission = async () => {
      const response = await methods.requestMethod();
      setPermission(response);
      return response;
    };
    const getPermission = async () => {
      const response = await methods.getMethod();
      setPermission(response);
      return response;
    };

    return [permission, requestPermission, getPermission] as const;
  };
}

interface EventSubscription {
  remove(): void;
}

type Listener = (...args: unknown[]) => void;

class StorybookEventEmitter {
  addListener(_eventName: string, _listener: Listener): EventSubscription {
    return { remove: () => {} };
  }

  removeAllListeners(_eventName?: string): void {}

  emit(_eventName: string, ..._args: unknown[]): void {}
}

class StorybookNativeModule {}

class StorybookSharedObject extends StorybookEventEmitter {
  release(): void {}
}

class StorybookSharedRef extends StorybookSharedObject {
  nativeRefType = "unknown";
}

interface StorybookLegacyEventEmitterConstructor {
  new (_nativeModule?: unknown): StorybookEventEmitter;
}

const StorybookLegacyEventEmitter: StorybookLegacyEventEmitterConstructor = StorybookEventEmitter;

export type { EventSubscription };
export {
  StorybookEventEmitter as EventEmitter,
  StorybookLegacyEventEmitter as LegacyEventEmitter,
  StorybookNativeModule as NativeModule,
  StorybookSharedObject as SharedObject,
  StorybookSharedRef as SharedRef,
};

export const uuid = {
  v4: (): string => globalThis.crypto.randomUUID(),
};

export class CodedError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class UnavailabilityError extends CodedError {
  constructor(moduleName: string, propertyName: string) {
    super("ERR_UNAVAILABLE", `${moduleName}.${propertyName} is unavailable in Storybook.`);
  }
}

export function useReleasingSharedObject(): never {
  throw new UnavailabilityError("expo-modules-core", "useReleasingSharedObject");
}

export function useReleasingSharedObjectWithLifecycle(): never {
  throw new UnavailabilityError("expo-modules-core", "useReleasingSharedObjectWithLifecycle");
}

export async function reloadAppAsync(_reason?: string): Promise<void> {
  throw new UnavailabilityError("expo-modules-core", "reloadAppAsync");
}

export function installOnUIRuntime(_uiRuntimeHolder: object): void {
  throw new UnavailabilityError("expo-modules-core", "installOnUIRuntime");
}

export const Platform = {
  OS: "web",
  select<T>(options: Partial<Record<string, T>>): T | undefined {
    return options.web ?? options.default;
  },
};

export function requireNativeModule(_moduleName: string): Record<string, unknown> {
  return {};
}

export function requireOptionalNativeModule(_moduleName: string): Record<string, unknown> | null {
  return {};
}

export function requireNativeViewManager(_moduleName: string): Record<string, unknown> {
  return {};
}

const webModules = new Map<string, StorybookNativeModule>();

export function registerWebModule<T extends StorybookNativeModule>(
  moduleImplementation: new () => T,
  moduleName = moduleImplementation.name,
): T {
  const registered = webModules.get(moduleName);
  if (registered instanceof moduleImplementation) return registered;
  const instance = new moduleImplementation();
  webModules.set(moduleName, instance);
  return instance;
}
