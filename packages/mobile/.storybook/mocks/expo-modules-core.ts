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

interface StorybookLegacyEventEmitterConstructor {
  new (_nativeModule?: unknown): StorybookEventEmitter;
}

const StorybookLegacyEventEmitter: StorybookLegacyEventEmitterConstructor = StorybookEventEmitter;

export type { EventSubscription };
export {
  StorybookEventEmitter as EventEmitter,
  StorybookLegacyEventEmitter as LegacyEventEmitter,
  StorybookNativeModule as NativeModule,
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

export function registerWebModule<T>(moduleImplementation: T, _moduleName?: string): T {
  return moduleImplementation;
}
