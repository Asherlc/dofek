import Foundation
import SQLite3
import XCTest
@testable import WhoopBLE

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
