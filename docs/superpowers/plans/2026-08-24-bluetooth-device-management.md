# Bluetooth Device Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give iOS users a Settings-based list of standard Bluetooth heart-rate monitors and WHOOP, with detail diagnostics and the ability to connect additional heart-rate monitors concurrently.

**Architecture:** BleHeartRateModule becomes the source of truth for an app-owned persisted registry and per-device snapshots, backed by independent peripheral sessions in its Core Bluetooth manager. A mobile catalog adapter merges those snapshots with a read-only WHOOP summary for a single Settings list and device-detail routes. Activity recording consumes the shared buffer only, rather than owning one device connection.

**Tech Stack:** Expo Router, React Native, TypeScript, Expo Modules, Swift/Core Bluetooth, XCTest, Vitest.

**Spec:** docs/superpowers/specs/2026-08-24-bluetooth-device-management-design.md

## Global Constraints

- Support multiple concurrent standard Bluetooth SIG Heart Rate Service (0x180D) monitors; WHOOP remains protocol-isolated.
- A paired-device list means devices Dofek has previously connected to, not iOS Settings' global Bluetooth inventory.
- Preserve device attribution and the existing peek → upload → confirm-drain contract; do not add server storage or schema.
- Do not derive or aggregate health metrics in React Native; render native-provided device snapshots only.
- Keep route-only files under packages/mobile/app/; put route tests in packages/mobile/app-tests/.
- Every unexpected mobile catch reports through captureException() and user-visible errors use the specific native message.
- Run BLE acceptance on a physical iPhone; Simulator results cannot validate radio behavior.

---

### Task 1: Define persistent standard-monitor snapshots and public bridge contract

**Files:**

- Create: packages/mobile/modules/ble-heart-rate/ios/BleHeartRateDeviceRegistry.swift
- Create: packages/mobile/modules/ble-heart-rate/Tests/BleHeartRateDeviceRegistryTests.swift
- Modify: packages/mobile/modules/ble-heart-rate/ios/BleHeartRateSampleBuffer.swift
- Modify: packages/mobile/modules/ble-heart-rate/ios/BleHeartRateModule.swift
- Modify: packages/mobile/modules/ble-heart-rate/index.ts
- Test: packages/mobile/modules/ble-heart-rate/Tests/BleHeartRateSampleBufferTests.swift

**Interfaces:**

- Consumes: native measurements as BleHeartRateSample(deviceId:timestamp:heartRateBpm:rrIntervalsMs:).
- Produces: BleHeartRateDeviceSnapshot { id, name, connectionState, lastMeasurementAt, lastHeartRateBpm, lastRrIntervalsMs, bufferedSampleCount }; TypeScript exports the equivalent snapshot type plus getDevices(), disconnect(peripheralId), forget(peripheralId), and addDeviceStateListener(callback).

- [ ] **Step 1: Write the failing registry tests**

~~~swift
func testRegistersADeviceOnceAndPersistsItsName() {
    let registry = BleHeartRateDeviceRegistry(defaults: makeDefaults())
    registry.register(BleHeartRateDevice(id: "strap-a", name: "Polar H10"))
    registry.register(BleHeartRateDevice(id: "strap-a", name: nil))

    XCTAssertEqual(registry.devices.map(\.id), ["strap-a"])
    XCTAssertEqual(registry.devices.first?.name, "Polar H10")
}

func testRecordsOnlyTheMatchingDevicesLatestMeasurement() {
    let registry = BleHeartRateDeviceRegistry(defaults: makeDefaults())
    registry.register(BleHeartRateDevice(id: "strap-a", name: "Polar H10"))
    registry.register(BleHeartRateDevice(id: "strap-b", name: "Wahoo TICKR"))

    registry.recordMeasurement(deviceId: "strap-b", heartRateBpm: 141, rrIntervalsMs: [823], at: date)

    XCTAssertNil(registry.snapshot(id: "strap-a", bufferedSampleCount: 0)?.lastHeartRateBpm)
    XCTAssertEqual(registry.snapshot(id: "strap-b", bufferedSampleCount: 3)?.lastHeartRateBpm, 141)
}

func testForgetsOnlyTheRequestedDevice() {
    let registry = BleHeartRateDeviceRegistry(defaults: makeDefaults())
    registry.register(BleHeartRateDevice(id: "strap-a", name: "Polar H10"))
    registry.register(BleHeartRateDevice(id: "strap-b", name: "Wahoo TICKR"))
    registry.remove(id: "strap-a")

    XCTAssertEqual(registry.devices.map(\.id), ["strap-b"])
}
~~~

- [ ] **Step 2: Run the registry tests to verify they fail**

Run: cd packages/mobile/modules/ble-heart-rate && swift test --filter BleHeartRateDeviceRegistryTests

Expected: FAIL because BleHeartRateDeviceRegistry and its snapshot API do not exist.

- [ ] **Step 3: Write the minimal registry, snapshot, buffer query, and bridge code**

~~~swift
struct BleHeartRateDeviceSnapshot: Codable {
    let id: String
    let name: String?
    let connectionState: String
    let lastMeasurementAt: Date?
    let lastHeartRateBpm: Int?
    let lastRrIntervalsMs: [Int]
    let bufferedSampleCount: Int
}

func sampleCount(for deviceId: String) -> Int {
    lock.lock(); defer { lock.unlock() }
    return samples.count(where: { $0.deviceId == deviceId })
}
~~~

Add BleHeartRateDeviceRegistry using injected UserDefaults, persist peripheral IDs and best-known names, update only the reporting device's latest measurement, and remove only requested registry metadata. Wire getDevices, per-device disconnect/forget, and onDeviceStateChanged through BleHeartRateModule. Include explicit null bridge values for absent measurements. Retain scanAndConnect as the add-device operation; success registers and emits the added device.

- [ ] **Step 4: Run the registry and buffer tests to verify they pass**

Run: cd packages/mobile/modules/ble-heart-rate && swift test --filter 'BleHeartRate(DeviceRegistry|SampleBuffer)Tests'

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add packages/mobile/modules/ble-heart-rate/ios/BleHeartRateDeviceRegistry.swift packages/mobile/modules/ble-heart-rate/ios/BleHeartRateSampleBuffer.swift packages/mobile/modules/ble-heart-rate/ios/BleHeartRateModule.swift packages/mobile/modules/ble-heart-rate/index.ts packages/mobile/modules/ble-heart-rate/Tests/BleHeartRateDeviceRegistryTests.swift packages/mobile/modules/ble-heart-rate/Tests/BleHeartRateSampleBufferTests.swift
git commit -m "feat: expose paired heart-rate devices"
~~~

### Task 2: Make the standard heart-rate manager own independent peripheral sessions

**Files:**

- Create: packages/mobile/modules/ble-heart-rate/ios/BleHeartRatePeripheralSession.swift
- Create: packages/mobile/modules/ble-heart-rate/Tests/BleHeartRatePeripheralSessionTests.swift
- Modify: packages/mobile/modules/ble-heart-rate/ios/BleHeartRateConnectionManager.swift
- Modify: packages/mobile/modules/ble-heart-rate/ios/BleHeartRateConnectionManagerDelegate.swift
- Modify: packages/mobile/modules/ble-heart-rate/ios/BleHeartRateModule.swift

**Interfaces:**

- Consumes: one peripheral identifier and session callbacks from CBCentralManager/CBPeripheral.
- Produces: BleHeartRatePeripheralSession state transitions and manager operations connect(peripheralId:completion:), disconnect(peripheralId:), and disconnectAll().

- [ ] **Step 1: Write the failing session-state tests**

~~~swift
func testReadySessionIsUnaffectedWhenAnotherSessionDisconnects() {
    var sessions = [
        "strap-a": BleHeartRatePeripheralSession(id: "strap-a", state: .ready),
        "strap-b": BleHeartRatePeripheralSession(id: "strap-b", state: .connecting),
    ]

    sessions["strap-b"]?.markDisconnected()

    XCTAssertEqual(sessions["strap-a"]?.state, .ready)
    XCTAssertEqual(sessions["strap-b"]?.state, .idle)
}

func testTimeoutOnlyFailsItsOwnConnectingSession() {
    let ready = BleHeartRatePeripheralSession(id: "strap-a", state: .ready)
    let connecting = BleHeartRatePeripheralSession(id: "strap-b", state: .connecting)
    connecting.markTimedOut()

    XCTAssertEqual(ready.state, .ready)
    XCTAssertEqual(connecting.state, .idle)
}
~~~

- [ ] **Step 2: Run the session tests to verify they fail**

Run: cd packages/mobile/modules/ble-heart-rate && swift test --filter BleHeartRatePeripheralSessionTests

Expected: FAIL because the session type does not exist.

- [ ] **Step 3: Implement per-peripheral state and refactor the manager**

~~~swift
final class BleHeartRatePeripheralSession {
    let peripheral: CBPeripheral
    var state: BleHeartRateConnectionState = .idle
    var completion: ((Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void)?
}

private var sessions: [UUID: BleHeartRatePeripheralSession] = [:]

func disconnect(peripheralId: String) {
    bleQueue.async {
        guard let id = UUID(uuidString: peripheralId), let session = self.sessions[id] else { return }
        self.centralManager?.cancelPeripheralConnection(session.peripheral)
    }
}
~~~

Replace single state, connectedPeripheral, and connectCompletion ownership with sessions keyed by peripheral UUID. Retain one scan request/timeout, but permit it to start a new session while ready sessions continue. Scope every discovery, notification subscription, timeout, and didDisconnectPeripheral branch to the matching session. Delegate callbacks identify the affected device so Task 1 emits only that snapshot.

- [ ] **Step 4: Run all BLE Swift tests to verify they pass**

Run: cd packages/mobile/modules/ble-heart-rate && swift test

Expected: PASS, including parser and buffer suites.

- [ ] **Step 5: Commit**

~~~bash
git add packages/mobile/modules/ble-heart-rate/ios/BleHeartRatePeripheralSession.swift packages/mobile/modules/ble-heart-rate/ios/BleHeartRateConnectionManager.swift packages/mobile/modules/ble-heart-rate/ios/BleHeartRateConnectionManagerDelegate.swift packages/mobile/modules/ble-heart-rate/ios/BleHeartRateModule.swift packages/mobile/modules/ble-heart-rate/Tests/BleHeartRatePeripheralSessionTests.swift
git commit -m "feat: connect multiple heart-rate monitors"
~~~

### Task 3: Provide a unified mobile Bluetooth device catalog, including WHOOP

**Files:**

- Create: packages/mobile/lib/bluetooth-device-catalog.ts
- Create: packages/mobile/lib/bluetooth-device-catalog.test.ts
- Modify: packages/mobile/modules/whoop-ble/index.ts
- Modify: packages/mobile/modules/whoop-ble/ios/WhoopBleModule.swift

**Interfaces:**

- Consumes: BleHeartRateDeviceSnapshot[], state subscriptions, and current WHOOP connection/buffer diagnostics.
- Produces: BluetoothDevice { id, kind: "whoop" | "heart-rate", name, connectionState, diagnostics }, getBluetoothDevices(), and subscribeBluetoothDevices(listener).

- [ ] **Step 1: Write the failing catalog tests**

~~~ts
it("lists WHOOP before every persisted heart-rate monitor", async () => {
  mockHeartRate.getDevices.mockResolvedValue([polar, wahoo]);
  mockWhoop.getDeviceSummary.mockReturnValue({
    name: null,
    connectionState: "ready",
    imuBufferedSamples: 12,
    realtimeBufferedSamples: 4,
  });

  await expect(getBluetoothDevices()).resolves.toEqual([
    expect.objectContaining({ id: "whoop", kind: "whoop", name: "WHOOP" }),
    expect.objectContaining({ id: "polar", kind: "heart-rate" }),
    expect.objectContaining({ id: "wahoo", kind: "heart-rate" }),
  ]);
});

it("publishes an updated list when the heart-rate module emits a device change", async () => {
  const listener = vi.fn();
  subscribeBluetoothDevices(listener);
  mockHeartRate.emitDeviceStateChanged([polar]);

  await waitFor(() => expect(listener).toHaveBeenCalledWith([expect.objectContaining({ id: "whoop" }), expect.objectContaining({ id: "polar" })]));
});
~~~

- [ ] **Step 2: Run the catalog tests to verify they fail**

Run: pnpm vitest run --project mobile packages/mobile/lib/bluetooth-device-catalog.test.ts

Expected: FAIL because the catalog and WHOOP summary API do not exist.

- [ ] **Step 3: Implement the catalog and read-only WHOOP summary**

~~~ts
export type BluetoothDevice =
  | { id: "whoop"; kind: "whoop"; name: string; connectionState: string; diagnostics: WhoopDiagnostics }
  | { id: string; kind: "heart-rate"; name: string; connectionState: string; diagnostics: HeartRateDiagnostics };

export async function getBluetoothDevices(): Promise<BluetoothDevice[]> {
  const heartRateDevices = await getHeartRateDevices();
  return [toWhoopDevice(getWhoopDeviceSummary()), ...heartRateDevices.map(toHeartRateDevice)];
}
~~~

Add getDeviceSummary() to whoop-ble and its Expo bridge. It reads existing connection state, connectedPeripheral identity when available, and IMU/realtime buffer counts without initiating a scan or moving WHOOP protocol behavior. The catalog always includes a WHOOP row with fallback name WHOOP, but uses its actual name/ID when known. Subscribe to heart-rate device-state and WHOOP connection-state events; the returned subscription removes both native listeners.

- [ ] **Step 4: Run the catalog tests and mobile typecheck to verify they pass**

Run: pnpm vitest run --project mobile packages/mobile/lib/bluetooth-device-catalog.test.ts && pnpm --dir packages/mobile typecheck

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add packages/mobile/lib/bluetooth-device-catalog.ts packages/mobile/lib/bluetooth-device-catalog.test.ts packages/mobile/modules/whoop-ble/index.ts packages/mobile/modules/whoop-ble/ios/WhoopBleModule.swift
git commit -m "feat: add unified Bluetooth device catalog"
~~~

### Task 4: Build Settings list, detail routes, and add-device flow

**Files:**

- Create: packages/mobile/components/BluetoothDeviceList.tsx
- Create: packages/mobile/components/BluetoothDeviceList.test.tsx
- Create: packages/mobile/components/BluetoothDeviceList.stories.tsx
- Create: packages/mobile/app/bluetooth-devices/index.tsx
- Create: packages/mobile/app/bluetooth-devices/[id].tsx
- Create: packages/mobile/app-tests/bluetooth-devices.test.tsx
- Create: packages/mobile/app-tests/bluetooth-device-detail.test.tsx
- Modify: packages/mobile/app/settings.tsx
- Modify: packages/mobile/app-tests/settings.test.tsx
- Modify: packages/mobile/app/_layout.tsx

**Interfaces:**

- Consumes: getBluetoothDevices, subscribeBluetoothDevices, heart-rate scanAndConnect/connect/disconnect/forget, and existing WHOOP connection methods.
- Produces: /bluetooth-devices and /bluetooth-devices/[id] flows reached from Settings' Bluetooth Devices row.

- [ ] **Step 1: Write the failing list and route tests**

~~~tsx
it("renders WHOOP and each paired heart-rate monitor as separate accessible rows", async () => {
  mockCatalog.getBluetoothDevices.mockResolvedValue([whoop, polar, wahoo]);
  render(<BluetoothDevicesScreen />);

  expect(await screen.findByRole("button", { name: "WHOOP, ready" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Polar H10, disconnected" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Wahoo TICKR, ready" })).toBeTruthy();
});

it("starts pairing an additional monitor without removing listed devices", async () => {
  render(<BluetoothDevicesScreen />);
  fireEvent.click(screen.getByRole("button", { name: "Connect Bluetooth device" }));
  await waitFor(() => expect(mockHeartRate.scanAndConnect).toHaveBeenCalledOnce());
  expect(screen.getByText("Polar H10")).toBeTruthy();
});

it("shows a device's incoming data and specific connection error", async () => {
  mockCatalog.getBluetoothDevices.mockResolvedValue([{ ...polar, diagnostics: { lastHeartRateBpm: 142, lastRrIntervalsMs: [820], bufferedSampleCount: 3 } }]);
  mockHeartRate.connect.mockRejectedValueOnce(new Error("Heart-rate monitor not found: polar"));
  render(<BluetoothDeviceDetailScreen />);

  expect(await screen.findByText("142 bpm")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Connect Polar H10" }));
  expect(await screen.findByText("Heart-rate monitor not found: polar")).toBeTruthy();
});

it("keeps the Bluetooth Devices settings entry discoverable", () => {
  render(<SettingsScreen />);
  fireEvent.click(screen.getByRole("button", { name: "Data Sources" }));
  expect(screen.getByRole("button", { name: "Bluetooth Devices" })).toBeTruthy();
});
~~~

- [ ] **Step 2: Run the list and route tests to verify they fail**

Run: pnpm vitest run --project mobile packages/mobile/components/BluetoothDeviceList.test.tsx packages/mobile/app-tests/bluetooth-devices.test.tsx packages/mobile/app-tests/bluetooth-device-detail.test.tsx

Expected: FAIL because the list component and routes do not exist.

- [ ] **Step 3: Implement presentation and routes**

~~~tsx
<TouchableOpacity
  accessibilityRole="button"
  accessibilityLabel={device.name + ", " + device.connectionState}
  onPress={() => router.push("/bluetooth-devices/" + encodeURIComponent(device.id))}
>
  <Text>{device.name}</Text>
  <Text>{device.connectionState}</Text>
  <Text>{device.diagnostics.summary}</Text>
</TouchableOpacity>
~~~

BluetoothDeviceList is presentational and receives devices, loading/error state, selection callback, and connect callback. The list route loads the catalog, preserves prior data while refreshing, subscribes/unsubscribes on mount, invokes scanAndConnect, calls captureException() for unexpected failures, and displays error.message. The dynamic detail route resolves its ID with useLocalSearchParams, displays only native-provided diagnostics, and routes WHOOP actions to its existing API and heart-rate actions to the per-device API. Add the two route entries to _layout.tsx and a Settings data-sources row opening /bluetooth-devices.

- [ ] **Step 4: Run focused mobile tests and typecheck to verify they pass**

Run: pnpm vitest run --project mobile packages/mobile/components/BluetoothDeviceList.test.tsx packages/mobile/app-tests/bluetooth-devices.test.tsx packages/mobile/app-tests/bluetooth-device-detail.test.tsx packages/mobile/app-tests/settings.test.tsx && pnpm --dir packages/mobile typecheck

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add packages/mobile/components/BluetoothDeviceList.tsx packages/mobile/components/BluetoothDeviceList.test.tsx packages/mobile/components/BluetoothDeviceList.stories.tsx packages/mobile/app/bluetooth-devices/index.tsx packages/mobile/app/bluetooth-devices/[id].tsx packages/mobile/app-tests/bluetooth-devices.test.tsx packages/mobile/app-tests/bluetooth-device-detail.test.tsx packages/mobile/app/settings.tsx packages/mobile/app-tests/settings.test.tsx packages/mobile/app/_layout.tsx
git commit -m "feat: manage Bluetooth devices from settings"
~~~

### Task 5: Replace activity recording's single-device ownership with shared device data

**Files:**

- Modify: packages/mobile/app/record.tsx
- Modify: packages/mobile/components/HeartRateDeviceCard.tsx
- Modify: packages/mobile/components/HeartRateDeviceCard.test.tsx
- Modify: packages/mobile/components/HeartRateDeviceCard.stories.tsx
- Modify: packages/mobile/lib/heart-rate-recording-service.ts
- Modify: packages/mobile/lib/heart-rate-recording-service.test.ts

**Interfaces:**

- Consumes: device-attributed buffered samples and Bluetooth-device management navigation.
- Produces: recording upload behavior that does not rely on a one-device fallback and a recording card that directs users to the shared manager.

- [ ] **Step 1: Write the failing activity and upload tests**

~~~ts
it("uploads a buffered sample under its captured device ID without a selected monitor", async () => {
  deps.ble.peekBufferedSamples.mockResolvedValueOnce([sampleForDevice("polar", 140)]).mockResolvedValue([]);
  await createHeartRateRecordingService(deps).syncForTimeRange(START, END);

  expect(pushSamples).toHaveBeenCalledWith({
    deviceId: "polar",
    samples: [expect.objectContaining({ heartRateBpm: 140 })],
  });
});
~~~

~~~tsx
it("opens Bluetooth device management instead of offering a single-device connection", () => {
  render(<HeartRateDeviceCard onManageDevices={onManageDevices} connectedDeviceCount={2} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage Bluetooth devices" }));
  expect(onManageDevices).toHaveBeenCalledOnce();
});
~~~

- [ ] **Step 2: Run the tests to verify they fail**

Run: pnpm vitest run --project mobile packages/mobile/lib/heart-rate-recording-service.test.ts packages/mobile/components/HeartRateDeviceCard.test.tsx

Expected: FAIL because the service requires a selected-device fallback and the card owns connect/disconnect.

- [ ] **Step 3: Implement shared-device recording behavior**

~~~ts
export interface HeartRateBleDeps {
  peekBufferedSamples(): Promise<BleHeartRateSample[]>;
  confirmSamplesDrain(count: number): void;
}

const groups = new DeviceSampleGroups(null, toBleHeartRateUploadSample);
~~~

Remove getDeviceId and record.tsx's local device/connection/listener state. Keep every upload keyed by the captured sample's required deviceId; if an unexpected legacy sample lacks it, throw a specific error rather than assigning it to an arbitrary connected device. Change HeartRateDeviceCard into a summary that displays connected count and links to /bluetooth-devices; it no longer scans, connects, or disconnects devices.

- [ ] **Step 4: Run the focused tests and typecheck to verify they pass**

Run: pnpm vitest run --project mobile packages/mobile/lib/heart-rate-recording-service.test.ts packages/mobile/components/HeartRateDeviceCard.test.tsx && pnpm --dir packages/mobile typecheck

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add packages/mobile/app/record.tsx packages/mobile/components/HeartRateDeviceCard.tsx packages/mobile/components/HeartRateDeviceCard.test.tsx packages/mobile/components/HeartRateDeviceCard.stories.tsx packages/mobile/lib/heart-rate-recording-service.ts packages/mobile/lib/heart-rate-recording-service.test.ts
git commit -m "refactor: share Bluetooth devices with activity recording"
~~~

### Task 6: Verify behavior and document support boundaries

**Files:**

- Modify: packages/mobile/modules/ble-heart-rate/README.md
- Modify: docs/ble-heart-rate.md

**Interfaces:**

- Consumes: the final ble-heart-rate public API and Settings UX.
- Produces: source-cited documentation describing app-managed devices, concurrent monitor support, device diagnostics, and physical-device validation.

- [ ] **Step 1: Update documentation and complete static verification**

Document the app-managed registry distinction, per-device state/data diagnostics, concurrent standard-monitor behavior, and physical-device acceptance. Cite the Bluetooth SIG Heart Rate Service and Core Bluetooth retrieval APIs used in the design spec. Do not add a dedicated test for declarative configuration.

- [ ] **Step 2: Run final automated checks**

Run: cd packages/mobile/modules/ble-heart-rate && swift test && cd ../../../.. && pnpm test:mobile && pnpm --dir packages/mobile typecheck && pnpm --dir packages/mobile lint && pnpm lint:mobile-telemetry && pnpm check:mobile-app-routes

Expected: PASS with no warnings.

- [ ] **Step 3: Run physical-device acceptance**

On a physical iPhone, connect two standard heart-rate monitors, verify both appear and remain independently connected when the other disconnects, confirm list/detail diagnostics update after notifications, add another device from Settings, and confirm WHOOP is visible with correct connected/disconnected status. Record hardware, OS, build, and observed result in the PR description; do not claim BLE radio verification from Simulator.

- [ ] **Step 4: Commit**

~~~bash
git add packages/mobile/modules/ble-heart-rate/README.md docs/ble-heart-rate.md
git commit -m "docs: describe Bluetooth device management"
~~~

## Plan Self-Review

- **Spec coverage:** Tasks 1–2 implement the persisted multi-monitor registry and independent Core Bluetooth sessions; Task 3 includes WHOOP without mixing protocols; Task 4 implements Settings, detail, add, and errors; Task 5 removes invalid single-device activity state; Task 6 covers documentation and validation.
- **Placeholder scan:** No TBD, TODO, deferred implementation, or unspecified error-handling directives remain.
- **Type consistency:** The public snapshot begins in Task 1, Task 3 maps it into BluetoothDevice, Task 4 consumes that catalog type, and Task 5 relies only on captured sample IDs.
