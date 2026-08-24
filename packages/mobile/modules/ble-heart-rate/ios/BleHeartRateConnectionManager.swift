import CoreBluetooth
import Foundation

/// Manages independent BLE sessions for standard Heart Rate Service devices.
/// Core Bluetooth objects remain queue-confined here; session lifecycle state
/// stays in `BleHeartRatePeripheralSession` so one device cannot mutate another.
final class BleHeartRateConnectionManager: NSObject {
    weak var delegate: BleHeartRateConnectionManagerDelegate?

    let bleQueue: DispatchQueue
    private let centralManagerOwner: BleHeartRateCentralManagerOwner<CBCentralManager>
    private var centralManager: CBCentralManager? { centralManagerOwner.current }
    private var sessions: [UUID: BleHeartRatePeripheralSession] = [:]
    private var peripherals: [UUID: CBPeripheral] = [:]
    private var connectCompletions: [
        UUID: (Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void
    ] = [:]
    private var pendingBluetoothConnects: Set<UUID> = []

    /// Scanning is the only lifecycle operation without a peripheral ID, so it
    /// remains a single request while identified peripherals use sessions.
    private var scanCompletion: ((Result<BleHeartRateDevice, BleHeartRateConnectionError>) -> Void)?
    private var scanState: BleHeartRateConnectionState = .idle
    private var pendingScan = false
    private var scanToken: UUID?

    private static let poweredOnTimeoutSeconds: TimeInterval = 5
    private static let scanTimeoutSeconds: TimeInterval = 15
    private static let connectTimeoutSeconds: TimeInterval = 10

    override init() {
        let queue = DispatchQueue(label: "com.dofek.ble-heart-rate", qos: .userInitiated)
        bleQueue = queue
        centralManagerOwner = BleHeartRateCentralManagerOwner(queue: queue)
        super.init()
    }

    private func ensureCentralManager() -> CBCentralManager {
        centralManagerOwner.getOrCreate {
            CBCentralManager(delegate: self, queue: bleQueue)
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

    func disconnectAll() {
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

    private func runOrDeferScan(manager: CBCentralManager) {
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
        manager: CBCentralManager
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

    private func startScan(_ manager: CBCentralManager) {
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

    private func performConnect(
        id: UUID,
        session: BleHeartRatePeripheralSession,
        manager: CBCentralManager
    ) {
        guard sessions[id] === session else { return }
        guard let peripheral = manager.retrievePeripherals(withIdentifiers: [id]).first else {
            failUnassociatedSession(id: id, error: .peripheralNotFound(session.id))
            return
        }
        beginConnecting(to: peripheral, session: session, manager: manager)
    }

    private func beginConnecting(
        to peripheral: CBPeripheral,
        session: BleHeartRatePeripheralSession,
        manager: CBCentralManager
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

    private func setState(
        _ state: BleHeartRateConnectionState,
        for session: BleHeartRatePeripheralSession
    ) {
        guard session.state != state else { return }
        session.state = state
        emitState(for: session)
    }

    private func markDisconnected(_ session: BleHeartRatePeripheralSession) {
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

    private func completeConnect(
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

    private func cancelScan(with error: BleHeartRateConnectionError) {
        centralManager?.stopScan()
        pendingScan = false
        scanState = .idle
        scanToken = nil
        let completion = scanCompletion
        scanCompletion = nil
        completion?(.failure(error))
    }

    private func takeScanCompletion(
        manager: CBCentralManager
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

    private func isManaged(_ peripheral: CBPeripheral) -> Bool {
        peripherals[peripheral.identifier] === peripheral
    }
}

// MARK: - CBCentralManagerDelegate

extension BleHeartRateConnectionManager: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if pendingScan {
                startScan(central)
            }
            let pendingIds = Array(pendingBluetoothConnects)
            pendingBluetoothConnects.removeAll()
            for id in pendingIds {
                guard let session = sessions[id] else { continue }
                performConnect(id: id, session: session, manager: central)
            }
            return
        case .unknown, .resetting:
            return
        default:
            break
        }

        if pendingScan || scanState != .idle {
            cancelScan(with: .bluetoothUnavailable)
        }

        for id in Array(sessions.keys) {
            guard let session = sessions[id] else { continue }
            let wasReady = session.state == .ready
            markDisconnected(session)
            completeConnect(id: id, with: .failure(.bluetoothUnavailable))
            pendingBluetoothConnects.remove(id)
            sessions.removeValue(forKey: id)
            peripherals.removeValue(forKey: id)
            if wasReady {
                delegate?.connectionManagerDidDisconnect(
                    self,
                    peripheralId: id.uuidString,
                    error: nil
                )
            }
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard scanState == .scanning else { return }
        let id = peripheral.identifier
        guard sessions[id] == nil, peripherals[id] == nil else { return }
        guard let completion = takeScanCompletion(manager: central) else { return }

        let session = BleHeartRatePeripheralSession(id: id.uuidString)
        sessions[id] = session
        connectCompletions[id] = completion
        beginConnecting(to: peripheral, session: session, manager: central)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard
            isManaged(peripheral),
            let session = sessions[peripheral.identifier],
            session.state == .connecting
        else { return }
        setState(.discoveringServices, for: session)
        peripheral.discoverServices([BleHeartRateConstants.heartRateServiceUUID])
    }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        let id = peripheral.identifier
        guard isManaged(peripheral), let session = sessions[id] else { return }
        markDisconnected(session)
        completeConnect(id: id, with: .failure(.connectTimeout))
        sessions.removeValue(forKey: id)
        peripherals.removeValue(forKey: id)
    }

    func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        let id = peripheral.identifier
        guard isManaged(peripheral), let session = sessions[id] else { return }
        markDisconnected(session)
        completeConnect(
            id: id,
            with: .failure(.disconnected(error?.localizedDescription))
        )
        sessions.removeValue(forKey: id)
        peripherals.removeValue(forKey: id)
        delegate?.connectionManagerDidDisconnect(
            self,
            peripheralId: id.uuidString,
            error: error
        )
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
