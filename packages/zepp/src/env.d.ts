declare module "@zos/fs" {
  export function writeFileSync(options: { path: string; data: ArrayBuffer | string }): void;
  export function readFileSync(options: {
    path: string;
    options?: { encoding?: string };
  }): ArrayBuffer | string;
  export function openSync(options: { path: string; flag: number }): number;
  export function writeSync(options: { fd: number; buffer: ArrayBuffer }): number;
  export function closeSync(options: { fd: number }): void;
  export const O_WRONLY: number;
  export const O_RDWR: number;
  export const O_APPEND: number;
  export const O_CREAT: number;
}

declare module "@zos/app-access" {
  export const getSportData: import("./workout-live.ts").GetSportData;
}

declare module "@zos/sensor" {
  export const FREQ_MODE_LOW: 0;
  export const FREQ_MODE_NORMAL: 1;
  export const FREQ_MODE_HIGH: 2;

  export class Accelerometer {
    setFreqMode(mode: number): void;
    getFreqMode(): number;
    onChange(callback: (value: { x: number; y: number; z: number }) => void): void;
    offChange(callback: (value: { x: number; y: number; z: number }) => void): void;
    start(): void;
    stop(): void;
    getCurrent(): { x: number; y: number; z: number };
  }

  export class Gyroscope {
    setFreqMode(mode: number): void;
    getFreqMode(): number;
    onChange(callback: (value: { x: number; y: number; z: number }) => void): void;
    offChange(callback: (value: { x: number; y: number; z: number }) => void): void;
    start(): void;
    stop(): void;
    getCurrent(): { x: number; y: number; z: number };
  }

  export class HeartRate {
    getToday(): number[];
    getResting(): number;
    getDailySummary(): { maximum?: { hr_value: number; time: number } };
    getLast(): number;
  }

  export class Step {
    getCurrent(): number;
    getTarget(): number;
  }

  export class Distance {
    getCurrent(): number;
  }

  export class Sleep {
    updateInfo(): void;
    getInfo(): {
      score: number;
      deepTime: number;
      startTime: number;
      endTime: number;
      totalTime: number;
    };
    getStage(): Array<{ model: number; start: number; stop: number }>;
    getNap(): Array<{ length: number; start: number; stop: number }>;
  }

  export class BloodOxygen {
    getCurrent(): { value: number };
    getLastDay(): number[];
    getLastFewHour(hours: number): Array<{ spo2: number; time: number }>;
  }

  export class BodyTemperature {
    getCurrent(): { current: number };
    getToday(): number[];
  }

  export class Stress {
    getToday(): number[];
    getTodayByHour(): number[];
    getLastWeek(): number[];
  }

  export class Stand {
    getCurrent(): number;
  }

  export class Pai {
    getCurrent(): number;
  }

  export class FatBurning {
    getCurrent(): number;
  }

  export class Workout {
    getHistory(): Array<{ startTime: number; duration: number }>;
  }

  export class Time {
    onPerMinute(callback: () => void): void;
  }

  export function checkSensor(sensor: new () => Accelerometer | Gyroscope): boolean;
}

declare module "@zos/utils" {
  export const log: {
    getLogger(tag: string): { log(...args: unknown[]): void; error(...args: unknown[]): void };
  };
  export function px(value: number): number;
}

declare module "@zos/device" {
  export const SCREEN_SHAPE_ROUND: number;
  export function getDeviceInfo(): { width: number; height: number; screenShape: number };
}

declare module "@zos/interaction" {
  export function showToast(options: { content: string }): void;
}

declare module "@zos/app" {
  export function queryPermission(options: { permissions: string[] }): [number];
  export function requestPermission(options: {
    permissions: string[];
    callback: (result: [number]) => void;
  }): void;
}

declare module "@zos/app-service" {
  export function start(options: {
    url: string;
    param?: string;
    reload?: boolean;
    complete_func?: (info: unknown) => void;
  }): void;
}

declare module "@zos/ble/TransferFile" {
  class Outbox {
    enqueueFile(path: string, params: Record<string, string>): Task;
  }

  class Task {
    on(event: string, callback: (event: { data: Record<string, unknown> }) => void): void;
  }

  class TransferFile {
    getOutbox(): Outbox;
  }

  export default TransferFile;
}

declare module "@zos/ui" {
  export type WidgetType = number;
  export interface WidgetInstance {
    setProperty(prop: number, value: string | number): void;
  }

  export const widget: {
    TEXT: number;
    BUTTON: number;
    IMAGE: number;
    QRCODE: number;
    [key: string]: number;
  };
  export const prop: { TEXT: number; VISIBLE: number; [key: string]: number };
  export const align: { CENTER_H: number; LEFT: number; [key: string]: number };
  export const text_style: { NONE: number; WRAP: number; [key: string]: number };
  export const inputType: { CHAR: number; NUM: number; EMOJI: number; VOICE: number };

  export function createWidget(type: WidgetType, options: Record<string, unknown>): WidgetInstance;
  export function deleteWidget(widget: WidgetInstance): void;
  export function createKeyboard(options: {
    inputType: number;
    text?: string;
    onComplete: (keyboardWidget: unknown, result: string) => void;
    onCancel: (keyboardWidget: unknown, result?: string) => void;
  }): unknown;
}

type PageHelpers = {
  request(options: {
    method: string;
    params: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  sendFile(
    path: string,
    params: Record<string, string>,
  ): { on(event: string, callback: (event: { data: Record<string, unknown> }) => void): void };
};

type SideServiceHelpers = {
  call(options: { method: string; params: Record<string, unknown> }): void;
};

declare module "@zeppos/zml/base-app" {
  export const BaseApp: {
    use(plugin: unknown): void;
    <T>(config: T): T;
  };
}

declare module "@zeppos/zml/base-page" {
  export const BasePage: {
    use(plugin: unknown): void;
    <T>(config: T & ThisType<T & PageHelpers>): T;
  };
}

declare module "@zeppos/zml/base-side" {
  export const BaseSideService: {
    use(plugin: unknown): void;
    <T>(config: T & ThisType<T & SideServiceHelpers>): T;
  };
}

declare module "@zeppos/zml/3.0/module/messaging/plugin/app" {
  export const appPlugin: unknown;
}

declare module "@zeppos/zml/3.0/module/messaging/plugin/page" {
  export const pagePlugin: unknown;
}

declare module "@zeppos/zml/3.0/module/messaging/plugin/side" {
  export const messagingPlugin: unknown;
}

declare function App<T>(config: T): void;
declare function Page<T>(config: T): void;
declare function DataWidget<T>(config: T): void;
declare function AppService<T>(config: T): void;
declare function AppSideService<T>(config: T): void;
declare function AppSettingsPage<T>(config: T): void;

interface PageContext {
  state: Record<string, unknown>;
  request(options: { method: string; params: Record<string, unknown> }): Promise<unknown>;
  sendFile(
    path: string,
    params: Record<string, string>,
  ): { on(event: string, callback: (event: { data: Record<string, unknown> }) => void): void };
  [key: string]: unknown;
}

interface SideServiceContext {
  call(options: { method: string; params: Record<string, unknown> }): void;
  getPreferences(): {
    enableGyro: boolean;
    freqModeIndex: number;
    hasCredentials: boolean;
    serverUrl: string;
    pairing: Record<string, unknown> | null;
  };
  setSessionStatus(payload: Record<string, unknown>): void;
  [key: string]: unknown;
}

interface ZeppFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface ZeppFetchResponse {
  status?: number;
  statusCode?: number;
  body?: unknown;
}

declare function fetch(options: ZeppFetchRequest): Promise<ZeppFetchResponse>;

interface AppServiceContext {
  scheduleTransferPoll(): void;
  transferPendingFile(): boolean;
  [key: string]: unknown;
}

declare const Logger: {
  getLogger(tag: string): { log(...args: unknown[]): void; error(...args: unknown[]): void };
};

declare const settings: {
  settingsStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    addListener(event: string, callback: (event: { key: string; newValue: string }) => void): void;
  };
};

declare function View(style: Record<string, unknown>, children: unknown[]): unknown;
declare function Button(options: Record<string, unknown>): unknown;
declare function TextInput(options: Record<string, unknown>): unknown;
declare function Toggle(options: Record<string, unknown>): unknown;
declare const DOFEK_COMPANION_CONNECTION_TYPE: "zepp-main" | "zepp-workout";
