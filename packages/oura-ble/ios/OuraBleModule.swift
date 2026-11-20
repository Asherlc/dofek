import ExpoModulesCore
import Foundation

private struct PairOptions: Record {
    @Field var requestedMeasurements: [String]?
}

private struct ReadOptions: Record {
    @Field var pageToken: String?
    @Field var limit: Int?
}

public final class OuraBleModule: Module {
    private let client = OuraIOSClient()

    public func definition() -> ModuleDefinition {
        Name("OuraBle")

        AsyncFunction("discoverRings") { (promise: Promise) in
            resolve(promise) { try await self.client.discover() }
        }

        AsyncFunction("pairRing") { (peripheralID: String, options: PairOptions?, promise: Promise) in
            resolve(promise) {
                try await self.client.pair(peripheralID, settings: options?.requestedMeasurements ?? [])
            }
        }

        AsyncFunction("syncRing") { (ringID: String, promise: Promise) in
            resolve(promise) { try await self.client.sync(ringID) }
        }

        AsyncFunction("readEvents") { (ringID: String, options: ReadOptions?, promise: Promise) in
            resolve(promise) {
                try self.client.read(ringID, pageToken: options?.pageToken, limit: options?.limit ?? 100)
            }
        }

        AsyncFunction("forgetRing") { (ringID: String, promise: Promise) in
            resolve(promise) {
                try self.client.forget(ringID)
                return nil
            }
        }
    }
}

private func resolve(_ promise: Promise, operation: @escaping @MainActor () async throws -> Any?) {
    Task { @MainActor in
        do {
            promise.resolve(try await operation())
        } catch OuraError.Operation(let message) {
            promise.reject("ERR_OURA_OPERATION", message)
        } catch OuraError.Disconnected {
            promise.reject("ERR_OURA_DISCONNECTED", "The ring disconnected. Reconnect to continue.")
        } catch OuraError.PairingReset {
            promise.reject("ERR_OURA_PAIRING_RESET", "The ring is in its factory-reset state. Pair it again to sync.")
        } catch {
            promise.reject("ERR_OURA_OPERATION", error.localizedDescription)
        }
    }
}

@MainActor
private final class OuraIOSClient {
    private var operationInProgress = false

    nonisolated init() {}

    func discover() async throws -> [[String: Any]] {
        try beginOperation()
        defer { operationInProgress = false }
        return try await OuraBluetoothTransport(bundle: .main).discover().map { ring in
            ["peripheralId": ring.peripheralID.uuidString, "name": ring.name as Any? ?? NSNull()]
        }
    }

    func pair(_ peripheral: String, settings: [String]) async throws -> [String: Any] {
        guard let peripheralID = UUID(uuidString: peripheral) else {
            throw OuraAdapterError("Use a peripheral identifier returned by discoverRings().")
        }
        return try await withSession(peripheralID: peripheralID) { session in
            let serial = try await session.identify()
            let saved = try OuraPairings.matching(serialNumber: serial)
            var pairing = try saved ?? OuraPairing(serialNumber: serial, peripheralID: peripheralID)
            var recovering = saved != nil
            if pairing.confirmed {
                do {
                    try await session.verifyPairing(serialNumber: serial, key: pairing.key)
                } catch OuraError.PairingReset {
                    pairing.archived = true
                    try OuraPairings.save(pairing)
                    pairing = try OuraPairing(serialNumber: serial, peripheralID: peripheralID)
                    recovering = false
                }
            }
            if !pairing.confirmed {
                try OuraPairings.save(pairing)
                try await session.pair(
                    serialNumber: serial,
                    key: pairing.key,
                    recovering: recovering
                )
                pairing.confirmed = true
            }
            pairing.peripheralID = peripheralID
            try OuraPairings.save(pairing)
            let firmware = try await session.firmwareVersion()
            let outcomes = try await session.configureMeasurements(settings: settings).map { outcome in
                [
                    "setting": outcome.setting,
                    "accepted": outcome.accepted,
                    "reason": outcome.reason as Any? ?? NSNull(),
                ] as [String: Any]
            }
            return [
                "ringId": pairing.id.uuidString,
                "deviceInfo": [
                    "serialNumber": serial,
                    "firmwareVersion": firmware as Any? ?? NSNull(),
                ],
                "measurementOutcomes": outcomes,
            ]
        }
    }

    func sync(_ ringID: String) async throws -> [String: Any] {
        let pairing = try syncablePairing(ringID)
        return try await withSession(peripheralID: pairing.peripheralID) { session in
            var directory = try storeDirectory(pairing.id)
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
            )
            var storageValues = URLResourceValues()
            storageValues.isExcludedFromBackup = true
            try directory.setResourceValues(storageValues)
            let report = try await session.syncHistory(
                databasePath: directory.appendingPathComponent("events.sqlite").path,
                serialNumber: pairing.serialNumber,
                key: pairing.key
            )
            return [
                "ringId": pairing.id.uuidString,
                "syncedEventCount": report.inserted,
                "warnings": report.warnings,
            ]
        }
    }

    func read(_ ringID: String, pageToken: String?, limit: Int) throws -> [String: Any] {
        try beginOperation()
        defer { operationInProgress = false }
        let pairing = try readablePairing(ringID)
        guard (1...500).contains(limit) else {
            throw OuraAdapterError("Event pages require a limit from 1 to 500.")
        }
        var afterRowID: Int64 = 0
        if let pageToken {
            let parts = pageToken.split(separator: "/", omittingEmptySubsequences: false)
            guard parts.count == 2, parts[0] == pairing.id.uuidString,
                  let parsedRowID = Int64(parts[1]), parsedRowID > 0 else {
                throw OuraAdapterError("Use a page token returned for this ring pairing.")
            }
            afterRowID = parsedRowID
        }
        let database = try storeDirectory(pairing.id).appendingPathComponent("events.sqlite")
        guard try itemExists(database) else {
            return ["events": [], "nextPageToken": NSNull()]
        }
        let page = try readEventPage(
            databasePath: database.path,
            serialNumber: pairing.serialNumber,
            afterRowId: afterRowID,
            limit: UInt32(limit)
        )
        let dateFormatter = ISO8601DateFormatter()
        let events = try page.events.map { event in
            var record: [String: Any] = [
                "ringId": pairing.id.uuidString,
                "tag": event.tag,
                "eventType": event.name,
                "ringRelativeTimestamp": ["value": event.ringTimestamp, "unit": "milliseconds"],
                "captureTime": dateFormatter.string(from: Date(timeIntervalSince1970: Double(event.capturedUnix))),
                "rawBodyBase64": event.body.base64EncodedString(),
            ]
            if let decoded = event.decodedJson {
                record["decodedFields"] = try JSONSerialization.jsonObject(with: Data(decoded.utf8))
            }
            return record
        }
        let next = page.nextRowId.map { "\(pairing.id.uuidString)/\($0)" }
        return ["events": events, "nextPageToken": next as Any? ?? NSNull()]
    }

    func forget(_ ringID: String) throws {
        try beginOperation()
        defer { operationInProgress = false }
        let id = try pairingID(ringID)
        let directory = try storeDirectory(id)
        if try itemExists(directory) {
            try FileManager.default.removeItem(at: directory)
        }
        try OuraPairings.remove(id)
    }

    private func beginOperation() throws {
        guard !operationInProgress else {
            throw OuraAdapterError("Another Oura Bluetooth operation is in progress. Wait for it to finish.")
        }
        operationInProgress = true
    }

    private func withSession<Result>(
        peripheralID: UUID,
        operation: (OuraSession) async throws -> Result
    ) async throws -> Result {
        try beginOperation()
        defer { operationInProgress = false }
        let transport = OuraBluetoothTransport(bundle: .main)
        try await transport.connect(peripheralID: peripheralID)

        let writer = RingPacketWriter { [weak transport] frame in
            guard let transport else { throw OuraError.Disconnected }
            try await transport.write(frame)
        }
        let session = OuraSession(writer: writer)
        transport.onFrame = { [weak session] data in session?.pushFrame(data: data) }
        transport.onDisconnection = { [weak session] in session?.close() }
        defer {
            writer.active = false
            session.close()
            transport.onFrame = nil
            transport.onDisconnection = nil
            transport.disconnect()
        }
        do {
            return try await operation(session)
        } catch {
            throw writer.failure ?? error
        }
    }

    private func readablePairing(_ ringID: String) throws -> OuraPairing {
        let id = try pairingID(ringID)
        guard let pairing = try OuraPairings.lookup(id), pairing.confirmed else {
            throw OuraAdapterError("The ring is not paired in this app. Discover it and pair it first.")
        }
        return pairing
    }

    private func syncablePairing(_ ringID: String) throws -> OuraPairing {
        let pairing = try readablePairing(ringID)
        guard !pairing.archived else {
            throw OuraAdapterError("This ring pairing was replaced after a factory reset. Pair the ring again to sync new data.")
        }
        return pairing
    }

    private func pairingID(_ ringID: String) throws -> UUID {
        guard let id = UUID(uuidString: ringID) else {
            throw OuraAdapterError("Use a ring identifier returned by pairRing().")
        }
        return id
    }

    private func storeDirectory(_ id: UUID) throws -> URL {
        let applicationSupport = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: false
        )
        return applicationSupport.appendingPathComponent("OuraBle", isDirectory: true)
            .appendingPathComponent(id.uuidString, isDirectory: true)
    }

    private func itemExists(_ url: URL) throws -> Bool {
        do {
            _ = try FileManager.default.attributesOfItem(atPath: url.path)
            return true
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
            return false
        }
    }
}

private final class RingPacketWriter: OuraPacketWriter {
    private let send: @MainActor @Sendable (Data) async throws -> Void
    @MainActor var active = true
    @MainActor private(set) var failure: Error?

    init(send: @escaping @MainActor @Sendable (Data) async throws -> Void) {
        self.send = send
    }

    @MainActor func write(data: Data) async -> Bool {
        guard active else { return false }
        do {
            try await send(data)
            return true
        } catch {
            failure = error
            return false
        }
    }
}
