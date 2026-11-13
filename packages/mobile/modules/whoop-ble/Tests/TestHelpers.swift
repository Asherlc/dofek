import CoreBluetooth
import Foundation
import SQLite3
import XCTest
@testable import WhoopBLE

final class TestWhoopCentralManager: WhoopBleCentralManaging {
    var state: CBManagerState = .poweredOn
    private(set) var isScanning = false

    func scanForPeripherals(withServices serviceUUIDs: [CBUUID]?, options: [String: Any]?) {
        isScanning = true
    }
    func stopScan() { isScanning = false }
    func retrievePeripherals(withIdentifiers identifiers: [UUID]) -> [CBPeripheral] { [] }
    func retrieveConnectedPeripherals(withServices serviceUUIDs: [CBUUID]) -> [CBPeripheral] { [] }
    func connect(_ peripheral: CBPeripheral, options: [String: Any]?) { XCTFail("Unexpected peripheral connection") }
    func cancelPeripheralConnection(_ peripheral: CBPeripheral) { XCTFail("Unexpected peripheral cancellation") }
}

extension WhoopBleBackgroundUploaderTests {
    func setup(
        reportError: @escaping (Error) -> Void = { _ in },
        now: @escaping () -> Date = Date.init
    ) throws -> (WhoopBleBackgroundUploader, WhoopBleSampleStore, TestWhoopUploadTransport) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let store = try WhoopBleSampleStore(directory: directory)
        let transport = TestWhoopUploadTransport()
        let uploader = try WhoopBleBackgroundUploader(
            store: store, directory: directory.appendingPathComponent("bodies"), transport: transport,
            reportError: reportError, now: now
        )
        try uploader.configure(userId: "alice", serverURL: "https://example.com", token: "secret", headers: [:])
        return (uploader, store, transport)
    }

    func settle(_ uploader: WhoopBleBackgroundUploader) throws {
        // Reconciliation and delegate work return to the serial queue.
        for _ in 0..<4 { _ = try uploader.diagnostics() }
    }
}

func assertUploaderCutoffStageOrder(_ stages: [String]) throws {
    let cancel = try XCTUnwrap(stages.firstIndex(of: "uploader_cancel_tasks"))
    let advance = try XCTUnwrap(stages.firstIndex(of: "uploader_advance_erasure_cutoff"))
    let purge = try XCTUnwrap(stages.firstIndex(of: "uploader_store_purge"))
    XCTAssertLessThan(cancel, advance)
    XCTAssertLessThan(advance, purge)
}

func uploaderCutoffBoundaryRows(_ cutoff: Date) -> [[String: Any]] {
    let formatter = ISO8601DateFormatter()
    return [-1.0, 0.0, 1.0].map {
        ["timestamp": formatter.string(from: cutoff.addingTimeInterval($0)), "heartRateBpm": 70]
    }
}

final class CleanupStageRecorder {
    private let lock = NSLock()
    private var stages: [String] = []

    func append(_ stage: String) { lock.withLock { stages.append(stage) } }
    var snapshot: [String] { lock.withLock { stages } }
}

final class TestWhoopUploadTransport: WhoopUploadTransport {
    var onCompletion: ((String, Int?, Data, URL?, Error?) -> Void)?
    var onFinishEvents: (() -> Void)?
    var tasks: [String] = []
    var requests: [(URLRequest, URL, String)] = []
    var reconciliationCount = 0
    var delayCancellation = false
    var delayedCancellations: [() -> Void] = []
    var cancellations: [String] = []
    var beforeAllTasks: (() -> Void)?
    func allTasks(_ completion: @escaping ([String]) -> Void) {
        reconciliationCount += 1
        beforeAllTasks?()
        completion(tasks)
    }
    func start(request: URLRequest, file: URL, identity: String) {
        tasks.append(identity); requests.append((request, file, identity))
    }
    func cancel(identity: String) {
        cancellations.append(identity)
        let cancel = { self.tasks.removeAll { $0 == identity } }
        if delayCancellation { delayedCancellations.append(cancel) } else { cancel() }
    }
    func complete(_ index: Int, status: Int = 200, body: String = "{\"result\":{\"data\":{\"inserted\":0}}}") {
        let task = requests[index]
        tasks.removeAll { $0 == task.2 }
        onCompletion?(task.2, status, Data(body.utf8), task.0.url, nil)
    }
}

final class TestWhoopPeripheralConnection: WhoopBlePeripheralConnection {
    let identifier: UUID
    let name: String? = "WHOOP test peripheral"
    var state: CBPeripheralState = .connected
    weak var delegate: CBPeripheralDelegate?
    var services: [CBService]?
    private let nativeSource: AnyObject?
    var notificationSource: AnyObject { nativeSource ?? self }
    private(set) var connections = 0
    private(set) var cancellations = 0
    private(set) var discoveredServices: [CBUUID]?
    var onCancel: () -> Void = {}
    private(set) var reads: [CBCharacteristic] = []
    private(set) var writes: [(Data, CBCharacteristic, CBCharacteristicWriteType)] = []

    init(identifier: UUID = UUID(), notificationSource: AnyObject? = nil) {
        self.identifier = identifier
        nativeSource = notificationSource
    }

    func connect() { connections += 1 }
    func cancelConnection() {
        cancellations += 1
        onCancel()
    }
    func discoverServices(_ serviceUUIDs: [CBUUID]?) { discoveredServices = serviceUUIDs }
    func discoverCharacteristics(_ characteristicUUIDs: [CBUUID]?, for service: CBService) {}
    func setNotifyValue(_ enabled: Bool, for characteristic: CBCharacteristic) {}
    func readValue(for characteristic: CBCharacteristic) { reads.append(characteristic) }
    func writeValue(_ data: Data, for characteristic: CBCharacteristic, type: CBCharacteristicWriteType) {
        writes.append((data, characteristic, type))
    }
}

func capturedWhoopR18Data() throws -> Data {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "imu-activation-capture", withExtension: "tsv", subdirectory: "fixtures"))
    let text = try String(contentsOf: url, encoding: .utf8)
    let hex = try XCTUnwrap(text.split(separator: "\n").compactMap { line -> String? in
        let value = String(line.split(separator: "\t").last ?? "")
        return value.count == 248 && value.dropFirst(16).hasPrefix("2f12") ? value : nil
    }.first)
    return try XCTUnwrap(Data(hexString: hex))
}

extension Data {
    init?(hexString: String) {
        let byteCount = hexString.count / 2
        var data = Data(capacity: byteCount)
        var index = hexString.startIndex
        for _ in 0..<byteCount {
            let nextIndex = hexString.index(index, offsetBy: 2)
            guard let byte = UInt8(hexString[index..<nextIndex], radix: 16) else { return nil }
            data.append(byte)
            index = nextIndex
        }
        self = data
    }
}

func makeRealtimeSample(timestampSeconds: UInt32) -> WhoopRealtimeDataSample {
    WhoopRealtimeDataSample(
        timestampSeconds: timestampSeconds,
        subSeconds: 0,
        heartRate: 60,
        rrIntervalMs: 1_000,
        quaternionW: 1,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
        opticalBytes: Data(count: 18)
    )
}
/// Observe the real store connection without adding a test-only production API.
final class SQLiteWorkProbe {
    private let database: OpaquePointer

    private init(database: OpaquePointer) { self.database = database }

    var errorCode: Int32 { sqlite3_errcode(database) }

    var cacheWrites: Int {
        var current: Int32 = 0
        var highwater: Int32 = 0
        XCTAssertEqual(sqlite3_db_status(database, SQLITE_DBSTATUS_CACHE_WRITE, &current, &highwater, 0), SQLITE_OK)
        return Int(current)
    }

    func executeFixture(_ sql: String) throws {
        let result = sqlite3_exec(database, sql, nil, nil, nil)
        guard result == SQLITE_OK else {
            throw NSError(domain: "SQLiteFixture", code: Int(result), userInfo: [
                NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(database)),
            ])
        }
    }

    func integer(_ sql: String) throws -> Int {
        var statement: OpaquePointer?
        XCTAssertEqual(sqlite3_prepare_v2(database, sql, -1, &statement, nil), SQLITE_OK)
        let prepared = try XCTUnwrap(statement)
        defer { sqlite3_finalize(prepared) }
        XCTAssertEqual(sqlite3_step(prepared), SQLITE_ROW)
        return Int(sqlite3_column_int64(prepared, 0))
    }

    static func opening<T>(_ open: () throws -> T) throws -> (T, SQLiteWorkProbe) {
        let value = try open()
        // Borrow the handle only to instrument public calls. Apple does not
        // support process-global SQLite auto extensions for observing opens.
        let handle = Mirror(reflecting: value).children.first { $0.label == "database" }?.value
        let database = try XCTUnwrap(handle as? OpaquePointer)
        return (value, SQLiteWorkProbe(database: database))
    }

    func withInstructionLimit<T>(_ limit: Int, _ operation: () throws -> T) rethrows -> T {
        let remaining = UnsafeMutablePointer<Int>.allocate(capacity: 1)
        remaining.initialize(to: limit)
        sqlite3_progress_handler(database, 1, { context in
            guard let context else { return 1 }
            let remaining = context.assumingMemoryBound(to: Int.self)
            remaining.pointee -= 1
            return remaining.pointee < 0 ? 1 : 0
        }, remaining)
        defer {
            sqlite3_progress_handler(database, 0, nil, nil)
            remaining.deinitialize(count: 1)
            remaining.deallocate()
        }
        return try operation()
    }
}
