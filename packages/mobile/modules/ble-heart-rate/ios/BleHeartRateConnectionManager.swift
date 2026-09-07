import CoreBluetooth
import Foundation

/// Manages independent BLE sessions for standard Heart Rate Service devices.
/// Core Bluetooth objects remain queue-confined here; session lifecycle state
/// stays in `BleHeartRatePeripheralSession` so one device cannot mutate another.
final class BleHeartRateConnectionManager: NSObject {
    weak var delegate: BleHeartRateConnectionManagerDelegate?

    let bleQueue: DispatchQueue
    private let centralManagerOwner: BleHeartRateCentralManagerOwner<any BleHeartRateCentralManaging>
    private let centralManagerFactory: (
        CBCentralManagerDelegate,
        DispatchQueue
    ) -> any BleHeartRateCentralManaging
    private var centralManager: (any BleHeartRateCentralManaging)? { centralManagerOwner.current }
    internal var sessions: [UUID: BleHeartRatePeripheralSession] = [:]
    internal var peripherals: [UUID: CBPeripheral] = [:]
    internal var connectCompletions: [
        UUID: (Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void
    ] = [:]
    internal var pendingBluetoothConnects: Set<UUID> = []

    /// Scanning is the only lifecycle operation without a peripheral ID, so it
    /// remains a single request while identified peripherals use sessions.
    private var scanCompletion: ((Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void)?
    internal var scanState: BleHeartRateConnectionState = .idle
    internal var pendingScan = false
    private var scanToken: UUID?

    private static let poweredOnTimeoutSeconds: TimeInterval = 5
    private static let scanTimeoutSeconds: TimeInterval = 15
    private static let connectTimeoutSeconds: TimeInterval = 10

    init(
        centralManagerFactory: @escaping (
            CBCentralManagerDelegate,
            DispatchQueue
        ) -> any BleHeartRateCentralManaging = { delegate, queue in
            CBCentralManager(delegate: delegate, queue: queue)
        }
    ) {
        let queue = DispatchQueue(label: "com.dofek.ble-heart-rate", qos: .userInitiated)
        bleQueue = queue
        centralManagerOwner = BleHeartRateCentralManagerOwner(queue: queue)
        self.centralManagerFactory = centralManagerFactory
        super.init()
    }

    private func ensureCentralManager() -> any BleHeartRateCentralManaging {
        centralManagerOwner.getOrCreate {
            centralManagerFactory(self, bleQueue)
        }
    }

    var isBluetoothAvailable: Bool {
        ensureCentralManager().state == .poweredOn
    }

    /// Compatibility aggregate for existing callers. A ready session wins;
    /// device-management callers use the per-device snapshots instead.
    var currentStateValue: String {
        bleQueue.sync {
            if sessions.values.contains(where: { $0.state == .ready }) {
                return BleHeartRateConnectionState.ready.rawValue
            }
            if scanState != .idle {
                return scanState.rawValue
            }
            for state in [
                BleHeartRateConnectionState.subscribing,
                .discoveringServices,
                .connecting,
            ] where sessions.values.contains(where: { $0.state == state }) {
                return state.rawValue
            }
            return BleHeartRateConnectionState.idle.rawValue
        }
    }

    // MARK: - Scan + connect

    func scanAndConnect(
        completion: @escaping (Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void
    ) {
        let manager = ensureCentralManager()
        bleQueue.async {
            guard self.scanCompletion == nil else {
                completion(.failure(.busy))
                return
            }
            self.scanCompletion = completion
            self.runOrDeferScan(manager: manager)
        }
    }

    func connect(
        peripheralId: String,
        completion: @escaping (Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void
    ) {
        let manager = ensureCentralManager()
        bleQueue.async {
            guard let id = UUID(uuidString: peripheralId) else {
                completion(.failure(.invalidPeripheralId(peripheralId)))
                return
            }
            guard self.sessions[id] == nil, self.peripherals[id] == nil else {
                completion(.failure(.busy))
                return
            }

            let session = BleHeartRatePeripheralSession(id: id.uuidString)
            self.sessions[id] = session
            self.connectCompletions[id] = completion
            self.setState(.connecting, for: session)
            self.runOrDeferConnect(id: id, session: session, manager: manager)
        }
    }

    func disconnect(peripheralId: String) {
        bleQueue.async {
            guard
                let id = UUID(uuidString: peripheralId),
                let session = self.sessions[id]
            else { return }

            self.pendingBluetoothConnects.remove(id)
            self.markDisconnected(session)
            self.completeConnect(id: id, with: .failure(.disconnected(nil)))

            if let peripheral = self.peripherals[id] {
                self.centralManager?.cancelPeripheralConnection(peripheral)
            } else {
                self.sessions.removeValue(forKey: id)
                self.delegate?.connectionManagerDidDisconnect(
                    self,
                    peripheralId: id.uuidString,
                    error: nil
                )
            }
        }
    }

    /// Disconnect every app-managed monitor after the current BLE-queue work
    /// completes. The optional completion fences account/session teardown.
    func disconnect(completion: (() -> Void)? = nil) {
        disconnectAll(completion: completion)
    }

    func disconnectAll() {
        disconnectAll(completion: nil)
    }

    private func disconnectAll(completion: (() -> Void)?) {
        bleQueue.async {
            self.cancelScan(with: .disconnected(nil))

            for id in Array(self.sessions.keys) {
                guard let session = self.sessions[id] else { continue }
                self.pendingBluetoothConnects.remove(id)
                self.markDisconnected(session)
                self.completeConnect(id: id, with: .failure(.disconnected(nil)))

                if let peripheral = self.peripherals[id] {
                    self.centralManager?.cancelPeripheralConnection(peripheral)
                } else {
                    self.sessions.removeValue(forKey: id)
                    self.delegate?.connectionManagerDidDisconnect(
                        self,
                        peripheralId: id.uuidString,
                        error: nil
                    )
                }
            }
            completion?()
        }
    }

    /// Establishes an account-erasure boundary on the BLE queue. All work
    /// submitted before the purge drains first; managed sessions are removed
    /// before account-owned storage is cleared, so later Core Bluetooth
    /// callbacks cannot append samples through those sessions.
    func performAccountPurge(
        work: @escaping () throws -> Void,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        bleQueue.async {
            self.cancelScan(with: .disconnected(nil))

            for id in Array(self.sessions.keys) {
                guard let session = self.sessions[id] else { continue }
                self.pendingBluetoothConnects.remove(id)
                self.markDisconnected(session)
                self.completeConnect(id: id, with: .failure(.disconnected(nil)))
                if let peripheral = self.peripherals[id] {
                    peripheral.delegate = nil
                    self.centralManager?.cancelPeripheralConnection(peripheral)
                }
                self.delegate?.connectionManagerDidDisconnect(
                    self,
                    peripheralId: id.uuidString,
                    error: nil
                )
            }
            self.sessions.removeAll()
            self.peripherals.removeAll()
            self.pendingBluetoothConnects.removeAll()
            self.connectCompletions.removeAll()

            completion(Result(catching: work))
        }
    }

    // MARK: - Operation dispatch

    private func runOrDeferScan(manager: any BleHeartRateCentralManaging) {
        switch manager.state {
        case .poweredOn:
            startScan(manager)
        case .unknown, .resetting:
            pendingScan = true
            let token = UUID()
            scanToken = token
            bleQueue.asyncAfter(deadline: .now() + Self.poweredOnTimeoutSeconds) {
                guard self.pendingScan, self.scanToken == token else { return }
                self.cancelScan(with: .bluetoothUnavailable)
            }
        default:
            cancelScan(with: .bluetoothUnavailable)
        }
    }

    private func runOrDeferConnect(
        id: UUID,
        session: BleHeartRatePeripheralSession,
        manager: any BleHeartRateCentralManaging
    ) {
        switch manager.state {
        case .poweredOn:
            performConnect(id: id, session: session, manager: manager)
        case .unknown, .resetting:
            pendingBluetoothConnects.insert(id)
            bleQueue.asyncAfter(deadline: .now() + Self.poweredOnTimeoutSeconds) {
                guard
                    self.pendingBluetoothConnects.remove(id) != nil,
                    self.sessions[id] === session
                else { return }
                self.failUnassociatedSession(id: id, error: .bluetoothUnavailable)
            }
        default:
            failUnassociatedSession(id: id, error: .bluetoothUnavailable)
        }
    }

    internal func startScan(_ manager: any BleHeartRateCentralManaging) {
        pendingScan = false
        scanState = .scanning
        let token = UUID()
        scanToken = token
        manager.scanForPeripherals(
            withServices: [BleHeartRateConstants.heartRateServiceUUID],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
        bleQueue.asyncAfter(deadline: .now() + Self.scanTimeoutSeconds) {
            guard self.scanState == .scanning, self.scanToken == token else { return }
            manager.stopScan()
            self.cancelScan(with: .scanTimeout)
        }
    }

    internal func performConnect(
        id: UUID,
        session: BleHeartRatePeripheralSession,
        manager: any BleHeartRateCentralManaging
    ) {
        guard sessions[id] === session else { return }
        guard let peripheral = manager.retrievePeripherals(withIdentifiers: [id]).first else {
            failUnassociatedSession(id: id, error: .peripheralNotFound(session.id))
            return
        }
        beginConnecting(to: peripheral, session: session, manager: manager)
    }

    internal func beginConnecting(
        to peripheral: CBPeripheral,
        session: BleHeartRatePeripheralSession,
        manager: any BleHeartRateCentralManaging
    ) {
        let id = peripheral.identifier
        peripherals[id] = peripheral
        peripheral.delegate = self
        setState(.connecting, for: session)
        manager.connect(peripheral, options: nil)

        bleQueue.asyncAfter(deadline: .now() + Self.connectTimeoutSeconds) {
            guard
                self.sessions[id] === session,
                self.peripherals[id] === peripheral,
                session.state == .connecting
                    || session.state == .discoveringServices
                    || session.state == .subscribing
            else { return }
            session.markTimedOut()
            self.emitState(for: session)
            self.completeConnect(id: id, with: .failure(.connectTimeout))
            manager.cancelPeripheralConnection(peripheral)
        }
    }

    internal func setState(
        _ state: BleHeartRateConnectionState,
        for session: BleHeartRatePeripheralSession
    ) {
        guard session.state != state else { return }
        session.state = state
        emitState(for: session)
    }

    internal func markDisconnected(_ session: BleHeartRatePeripheralSession) {
        guard session.state != .idle else { return }
        session.markDisconnected()
        emitState(for: session)
    }

    private func emitState(for session: BleHeartRatePeripheralSession) {
        delegate?.connectionManager(
            self,
            didChangeState: session.state,
            for: session.id
        )
    }

    internal func completeConnect(
        id: UUID,
        with result: Result<BleHeartRateDevice, BleHeartRateConnectionError>
    ) {
        let completion = connectCompletions.removeValue(forKey: id)
        completion?(result)
    }

    private func failUnassociatedSession(id: UUID, error: BleHeartRateConnectionError) {
        pendingBluetoothConnects.remove(id)
        if let session = sessions[id] {
            markDisconnected(session)
        }
        completeConnect(id: id, with: .failure(error))
        sessions.removeValue(forKey: id)
        peripherals.removeValue(forKey: id)
    }

    private func abortConnection(
        _ peripheral: CBPeripheral,
        with error: BleHeartRateConnectionError
    ) {
        let id = peripheral.identifier
        guard
            let session = sessions[id],
            peripherals[id] === peripheral
        else { return }

        markDisconnected(session)
        completeConnect(id: id, with: .failure(error))
        centralManager?.cancelPeripheralConnection(peripheral)
    }

    internal func cancelScan(with error: BleHeartRateConnectionError) {
        centralManager?.stopScan()
        pendingScan = false
        scanState = .idle
        scanToken = nil
        let completion = scanCompletion
        scanCompletion = nil
        completion?(.failure(error))
    }

    internal func takeScanCompletion(
        manager: any BleHeartRateCentralManaging
    ) -> ((Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void)? {
        manager.stopScan()
        pendingScan = false
        scanState = .idle
        scanToken = nil
        let completion = scanCompletion
        scanCompletion = nil
        return completion
    }

    private func device(for peripheral: CBPeripheral) -> BleHeartRateDevice {
        BleHeartRateDevice(id: peripheral.identifier.uuidString, name: peripheral.name)
    }

    internal func isManaged(_ peripheral: CBPeripheral) -> Bool {
        peripherals[peripheral.identifier] === peripheral
    }
}

// MARK: - CBPeripheralDelegate

extension BleHeartRateConnectionManager: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard
            isManaged(peripheral),
            let session = sessions[peripheral.identifier],
            session.state == .discoveringServices
        else { return }
        guard
            error == nil,
            let service = peripheral.services?.first(where: {
                $0.uuid == BleHeartRateConstants.heartRateServiceUUID
            })
        else {
            abortConnection(peripheral, with: .serviceNotFound)
            return
        }
        peripheral.discoverCharacteristics(
            [BleHeartRateConstants.heartRateMeasurementUUID],
            for: service
        )
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        guard
            isManaged(peripheral),
            let session = sessions[peripheral.identifier],
            session.state == .discoveringServices
        else { return }
        guard
            error == nil,
            let characteristic = service.characteristics?.first(where: {
                $0.uuid == BleHeartRateConstants.heartRateMeasurementUUID
            })
        else {
            abortConnection(peripheral, with: .characteristicNotFound)
            return
        }

        setState(.subscribing, for: session)
        peripheral.setNotifyValue(true, for: characteristic)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        let id = peripheral.identifier
        guard
            characteristic.uuid == BleHeartRateConstants.heartRateMeasurementUUID,
            isManaged(peripheral),
            let session = sessions[id],
            session.state == .subscribing
        else { return }

        if error != nil || !characteristic.isNotifying {
            abortConnection(peripheral, with: .notificationSubscriptionFailed)
            return
        }

        setState(.ready, for: session)
        let connectedDevice = device(for: peripheral)
        completeConnect(id: id, with: .success(connectedDevice))
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard
            characteristic.uuid == BleHeartRateConstants.heartRateMeasurementUUID,
            isManaged(peripheral),
            sessions[peripheral.identifier]?.state == .ready,
            error == nil,
            let data = characteristic.value,
            let measurement = BleHeartRateMeasurementParser.parse(data)
        else { return }

        delegate?.connectionManager(
            self,
            didReceiveMeasurement: measurement,
            from: peripheral.identifier.uuidString,
            at: Date()
        )
    }
}
