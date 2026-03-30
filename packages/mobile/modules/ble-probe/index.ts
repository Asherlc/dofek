import { EventEmitter, type Subscription } from "expo-modules-core";
import BleProbeModule from "./src/BleProbeModule";

const emitter = new EventEmitter(BleProbeModule);

// MARK: - Types

export interface ScanResult {
  id: string;
  name: string | null;
  rssi: number;
}

export interface BleService {
  uuid: string;
  isPrimary: boolean;
}

export interface BleCharacteristic {
  uuid: string;
  suffix: string;
  properties: string;
  isNotifying: boolean;
}

export interface BleNotification {
  index: number;
  suffix: string;
  bytes: number;
  hex: string;
  timestamp: string;
}

// MARK: - Bluetooth state

export function getBluetoothState(): string {
  return BleProbeModule.getBluetoothState();
}

export function initialize(): void {
  BleProbeModule.initialize();
}

// MARK: - Scanning

export async function scan(serviceUUIDs?: string[], durationSeconds = 5): Promise<ScanResult[]> {
  return BleProbeModule.scan(serviceUUIDs ?? null, durationSeconds);
}

export function getConnectedPeripherals(
  serviceUUIDs: string[],
): Array<{ id: string; name: string | null; serviceUUID: string }> {
  return BleProbeModule.getConnectedPeripherals(serviceUUIDs);
}

// MARK: - Connection

export async function connect(
  peripheralId: string,
  timeoutSeconds = 10,
): Promise<{ id: string; name: string | null }> {
  return BleProbeModule.connect(peripheralId, timeoutSeconds);
}

export function disconnect(): void {
  BleProbeModule.disconnect();
}

export function isConnected(): boolean {
  return BleProbeModule.isConnected();
}

// MARK: - Discovery

export async function discoverServices(): Promise<BleService[]> {
  return BleProbeModule.discoverServices();
}

export async function discoverCharacteristics(serviceUUID: string): Promise<BleCharacteristic[]> {
  return BleProbeModule.discoverCharacteristics(serviceUUID);
}

export function getCharacteristics(): BleCharacteristic[] {
  return BleProbeModule.getCharacteristics();
}

// MARK: - Notifications

export async function subscribe(characteristicSuffix: string): Promise<boolean> {
  return BleProbeModule.subscribe(characteristicSuffix);
}

export async function unsubscribe(characteristicSuffix: string): Promise<boolean> {
  return BleProbeModule.unsubscribe(characteristicSuffix);
}

export function addNotificationListener(listener: (event: BleNotification) => void): Subscription {
  return emitter.addListener("onNotification", listener);
}

export function addConnectionStateListener(
  listener: (event: { state: string; peripheralId: string; error?: string }) => void,
): Subscription {
  return emitter.addListener("onConnectionStateChanged", listener);
}

export function addBluetoothStateListener(
  listener: (event: { state: string }) => void,
): Subscription {
  return emitter.addListener("onBluetoothStateChanged", listener);
}

// MARK: - Read/Write

export async function writeRaw(
  characteristicSuffix: string,
  hexString: string,
  withResponse = true,
): Promise<boolean> {
  return BleProbeModule.writeRaw(characteristicSuffix, hexString, withResponse);
}

export async function readCharacteristic(characteristicSuffix: string): Promise<string> {
  return BleProbeModule.readCharacteristic(characteristicSuffix);
}

// MARK: - Notification log

export function getNotificationLog(): BleNotification[] {
  return BleProbeModule.getNotificationLog();
}

export function clearNotificationLog(): void {
  BleProbeModule.clearNotificationLog();
}

export function getNotificationCount(): number {
  return BleProbeModule.getNotificationCount();
}
