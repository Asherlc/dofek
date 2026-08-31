const unsupported = () => new Error("Wear OS is not configured. Pair a supported Wear OS watch to use watch recording.");
const reject = async (): Promise<never> => { throw unsupported(); };

export const watchGateway = { kind: "wear-os" as const };
export function isWatchSupported() { return false; }
export function isWatchPaired() { return false; }
export function isWatchAppInstalled() { return false; }
export function getWatchSyncStatus() { return { isSupported: false, isPaired: false, isReachable: false, isWatchAppInstalled: false, pendingFileCount: 0 }; }
export const requestWatchSync = reject as () => Promise<boolean>;
export const requestWatchRecording = reject as () => Promise<boolean>;
export const enableAccountSync = reject as () => Promise<boolean>;
export function getPendingWatchFileNames() { return []; }
export function getPendingWatchAltitudeFileNames() { return []; }
export const readWatchFile = reject as (name: string) => Promise<never[]>;
export const readWatchAltitudeFile = reject as (name: string) => Promise<never[]>;
export function deleteWatchFile() {}
export const purgeAccountState = reject as (cutoff: string) => Promise<boolean>;
