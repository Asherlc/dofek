@testable import ExpoModulesCore
import ExpoModulesTestCore
import RNSentry
import SQLite3
import XCTest
@testable import ExpoWhoopBle

var captureError: NSError {
    NSError(domain: "CaptureTest", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "The capture database is unavailable"
    ])
}

func makeModule() throws -> (TestAppContext, WhoopBleModule) {
    let context = TestAppContext()
    context.registerNativeModules(provider: WhoopBridgeModulesProvider())
    let module = try XCTUnwrap(context.moduleRegistry.get(moduleWithName: "WhoopBle") as? WhoopBleModule)
    return (context, module)
}

func outcome(_ call: String, in context: TestAppContext) async throws -> String {
    let runtime = try context.runtime
    let result = try await runtime.evalAsync("""
        expo.modules.WhoopBle.\(call).then(
            () => 'unexpected success',
            error => error.code + ': ' + error.message
        )
        """).ref()
    return try await runtime.execute { try result.take().asString() }
}

func queuedOutcomes(_ calls: [String], in context: TestAppContext) async throws -> [String] {
    let expressions = calls.map { "expo.modules.WhoopBle.\($0)" }.joined(separator: ", ")
    let runtime = try context.runtime
    let result = try await runtime.evalAsync("""
        Promise.all([\(expressions)].map(call => call.then(
            () => 'unexpected success', error => error.code + ': ' + error.message
        ))).then(JSON.stringify)
        """).ref()
    let json = try await runtime.execute { try result.take().asString() }
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String])
}

func whoopUploadDatabaseDirectory() throws -> URL {
    try FileManager.default.url(
        for: .applicationSupportDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
    ).appendingPathComponent("WhoopBleUploads", isDirectory: true)
}

func restoreCutoffFixture(_ fixture: SQLiteCutoffFailureFixture, uploader: WhoopBleBackgroundUploader) {
    var failures: [String] = []
    do { try fixture.dropFailureTrigger() } catch { failures.append("drop trigger: \(error)") }
    do { try uploader.disable() } catch { failures.append("settle uploader: \(error)") }
    do { try fixture.restore() } catch { failures.append("restore cutoff fixture: \(error)") }
    XCTAssertTrue(failures.isEmpty, failures.joined(separator: "; "))
}

private final class WhoopBridgeModulesProvider: ModulesProvider {
    override func getModuleClasses() -> [ExpoModuleTupleType] {
        [(WhoopBleModule.self, "WhoopBle"), (BridgeProbeModule.self, "BridgeProbe")]
    }
}

final class BridgeProbeModule: Module {
    func definition() -> ModuleDefinition {
        Name("BridgeProbe")

        AsyncFunction("probe") { () -> Bool in
            return true
        }
    }
}

func makeBodyRemovalFailure() throws -> (directory: URL, backup: URL) {
    let directory = try FileManager.default.url(
        for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("WhoopBleUploads/bodies")
    let backup = directory.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
    try FileManager.default.moveItem(at: directory, to: backup)
    try Data().write(to: directory)
    return (directory, backup)
}

func restoreBodyDirectory(_ directory: URL, backup: URL) throws {
    guard FileManager.default.fileExists(atPath: backup.path) else { return }
    if FileManager.default.fileExists(atPath: directory.path) {
        try FileManager.default.removeItem(at: directory)
    }
    try FileManager.default.moveItem(at: backup, to: directory)
}

final class SQLiteCutoffFailureFixture {
    private static let cutoffTrigger = "reject_device_cutoff_advance"
    private let database: OpaquePointer
    private(set) var triggerInstalled = false
    let databaseDirectory: URL
    let originalCutoff: String?
    private let originalUserDefaultsCutoff: Any?
    let cutoff: Date

    init(databaseDirectory: URL, userDefaultsCutoff: Any?) throws {
        self.databaseDirectory = databaseDirectory
        originalUserDefaultsCutoff = userDefaultsCutoff
        let path = databaseDirectory.appendingPathComponent("samples.sqlite").path
        var handle: OpaquePointer?
        let result = sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
        guard result == SQLITE_OK, let handle else {
            let failure = Self.error(handle, message: "Cannot open test host WHOOP database at \(path)")
            if let handle { sqlite3_close(handle) }
            throw failure
        }
        let storedCutoff: String?
        do {
            storedCutoff = try Self.textValue(handle, sql: "SELECT value FROM metadata WHERE key = 'cutoff'")
        } catch {
            sqlite3_close(handle)
            throw error
        }
        database = handle
        originalCutoff = storedCutoff
        let epoch = Date(timeIntervalSince1970: 0)
        let defaultsDate = userDefaultsCutoff as? Date ?? epoch
        let sqliteDate = storedCutoff.flatMap(Double.init).map(Date.init(timeIntervalSince1970:)) ?? epoch
        let baseline = max(Date(), max(defaultsDate, sqliteDate))
        self.cutoff = Date(timeIntervalSince1970: floor(baseline.timeIntervalSince1970) + 2)
    }

    deinit { sqlite3_close(database) }

    var persistedCutoff: String? {
        get throws { try Self.textValue(database, sql: "SELECT value FROM metadata WHERE key = 'cutoff'") }
    }

    func installFailureTrigger() throws {
        try execute("""
            CREATE TRIGGER \(Self.cutoffTrigger) BEFORE INSERT ON metadata
            WHEN NEW.key = 'cutoff'
            BEGIN SELECT RAISE(ABORT, 'cutoff fixture rejected write'); END;
            """)
        triggerInstalled = true
    }

    func dropFailureTrigger() throws {
        guard triggerInstalled else { return }
        try execute("DROP TRIGGER \(Self.cutoffTrigger)")
        triggerInstalled = false
    }

    func restore() throws {
        try dropFailureTrigger()
        if let originalCutoff {
            try Self.setText(originalCutoff, key: "cutoff", in: database)
        } else {
            try execute("DELETE FROM metadata WHERE key = 'cutoff'")
        }
        if let originalUserDefaultsCutoff {
            UserDefaults.standard.set(originalUserDefaultsCutoff, forKey: "dofek_device_erasure_cutoff_v1")
        } else {
            UserDefaults.standard.removeObject(forKey: "dofek_device_erasure_cutoff_v1")
        }
    }

    private func execute(_ sql: String) throws {
        var errorMessage: UnsafeMutablePointer<CChar>?
        let result = sqlite3_exec(database, sql, nil, nil, &errorMessage)
        guard result == SQLITE_OK else {
            let message = errorMessage.map { String(cString: $0) } ?? String(cString: sqlite3_errmsg(database))
            sqlite3_free(errorMessage)
            throw NSError(domain: "SQLiteCutoffFailureFixture", code: Int(result), userInfo: [
                NSLocalizedDescriptionKey: message,
            ])
        }
    }

    private static func textValue(_ database: OpaquePointer, sql: String) throws -> String? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw error(database, message: "Cannot prepare cutoff query")
        }
        defer { sqlite3_finalize(statement) }
        switch sqlite3_step(statement) {
        case SQLITE_ROW:
            guard let value = sqlite3_column_text(statement, 0) else {
                throw error(database, message: "Cutoff metadata value is not text")
            }
            return String(cString: value)
        case SQLITE_DONE:
            return nil
        default:
            throw error(database, message: "Cannot read cutoff metadata")
        }
    }

    private static func setText(_ value: String, key: String, in database: OpaquePointer) throws {
        var statement: OpaquePointer?
        let sql = "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)"
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw error(database, message: "Cannot prepare cutoff restoration")
        }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        guard sqlite3_bind_text(statement, 1, key, -1, transient) == SQLITE_OK,
              sqlite3_bind_text(statement, 2, value, -1, transient) == SQLITE_OK,
              sqlite3_step(statement) == SQLITE_DONE else {
            throw error(database, message: "Cannot restore cutoff metadata")
        }
    }

    private static func error(_ database: OpaquePointer?, message: String) -> NSError {
        let detail = database.map { String(cString: sqlite3_errmsg($0)) } ?? message
        return NSError(domain: "SQLiteCutoffFailureFixture", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "\(message): \(detail)",
        ])
    }
}

extension WhoopBleModuleTests {
    func startCleanupAndProbe(_ runtime: JavaScriptRuntime) async throws {
        try await runtime.execute {
            _ = try runtime.eval("""
                globalThis.cleanupFinished = false;
                globalThis.configureFinished = false;
                globalThis.purgeFinished = false;
                globalThis.cleanupPromise = expo.modules.WhoopBle.disableUploads().then(() => {
                    globalThis.cleanupFinished = true;
                    return true;
                });
                globalThis.configurePromise = expo.modules.WhoopBle.configureUpload({
                    userId: 'bridge-test-account', serverURL: 'https://example.com',
                    token: 'test-session', headers: {}
                }).then(() => {
                    globalThis.configureFinished = true;
                    return true;
                });
                globalThis.purgePromise = expo.modules.WhoopBle.purgeAccountState('2000-01-01T00:00:00Z').then(() => {
                    globalThis.purgeFinished = true;
                    return true;
                });
                globalThis.probePromise = expo.modules.BridgeProbe.probe();
                """)
        }
    }

    func queueErasureWhileBleQueueIsBlocked(
        _ context: TestAppContext,
        module: WhoopBleModule,
        blocked: XCTestExpectation,
        release: DispatchSemaphore,
        cutoffWritten: XCTNSPredicateExpectation
    ) async throws -> JavaScriptRuntime {
        blockBleQueue(module, until: release, signals: blocked)
        await fulfillment(of: [blocked], timeout: 5)
        let runtime = try context.runtime
        try await runtime.execute {
            _ = try runtime.eval("""
                globalThis.purgeResult = expo.modules.WhoopBle.purgeAccountState('2001-01-01T00:00:00Z').then(
                    () => 'unexpected success', error => error.code
                );
                globalThis.queuedConfigureResult = expo.modules.WhoopBle.configureUpload({
                    userId: 'bridge-test-account', serverURL: 'https://example.com',
                    token: 'test-session', headers: {}
                }).then(
                    () => 'unexpected success', error => error.code + ': ' + error.message
                );
                """)
        }
        await fulfillment(of: [cutoffWritten], timeout: 5)
        return runtime
    }

    func assertConfigureWaitsBehindPurge(_ runtime: JavaScriptRuntime) async -> Task<Void, Error> {
        let returned = expectation(description: "Configuration remains queued behind the blocked purge")
        returned.isInverted = true
        let task = Task {
            let result = try await runtime.evalAsync("globalThis.queuedConfigureResult").ref()
            _ = try await runtime.execute { try result.take().asString() }
            returned.fulfill()
        }
        let response = await XCTWaiter.fulfillment(of: [returned], timeout: 1)
        XCTAssertEqual(response, .completed)
        return task
    }

    func assertBlockedPurgeResults(
        _ runtime: JavaScriptRuntime,
        expectedCutoff: Date,
        configureWaiter: Task<Void, Error>
    ) async throws {
        let purge = try await runtime.evalAsync("globalThis.purgeResult").ref()
        let purgeResult = try await runtime.execute { try purge.take().asString() }
        XCTAssertEqual(purgeResult, "WHOOP_BLE_PURGE_FAILED")
        XCTAssertEqual(
            UserDefaults.standard.object(forKey: "dofek_device_erasure_cutoff_v1") as? Date,
            expectedCutoff
        )
        let configure = try await runtime.evalAsync("globalThis.queuedConfigureResult").ref()
        let result = try await runtime.execute { try configure.take().asString() }
        XCTAssertTrue(result.contains("configuration is blocked because cleanup failed"), result)
        try await configureWaiter.value
    }

    func probeResolvesBeforeRelease(_ runtime: JavaScriptRuntime, release: DispatchSemaphore) async throws -> Bool {
        let returned = expectation(description: "Unrelated Expo async probe Promise resolves with true")
        let probe = Task {
            let result = try await runtime.evalAsync("globalThis.probePromise").ref()
            let value = try await runtime.execute { try result.take().asBool() }
            XCTAssertTrue(value)
            returned.fulfill()
        }
        let response = await XCTWaiter.fulfillment(of: [returned], timeout: 5)
        XCTAssertEqual(response, .completed)
        guard response == .completed else {
            release.signal()
            try await probe.value
            return false
        }
        try await probe.value
        return true
    }

    func assertCleanupResolves(_ runtime: JavaScriptRuntime) async throws {
        for promise in ["cleanupPromise", "configurePromise", "purgePromise"] {
            let result = try await runtime.evalAsync("globalThis.\(promise)").ref()
            let succeeded = try await runtime.execute { try result.take().asBool() }
            XCTAssertTrue(succeeded)
        }
    }

    func assertCaptureStaysSuspended(_ context: TestAppContext) async throws {
        for call in ["connect('invalid-peripheral-id')", "retryConnection()"] {
            let rejection = try await outcome(call, in: context)
            XCTAssertTrue(rejection.contains("WHOOP_BLE_CAPTURE_SUSPENDED"), rejection)
        }
    }

    func assertSentryErasureAttribution(
        _ captures: SentryCaptureRecorder,
        cleanupCaptured: XCTestExpectation,
        controlCaptured: XCTestExpectation
    ) async {
        await fulfillment(of: [cleanupCaptured], timeout: 5)
        XCTAssertEqual(captures.snapshot.count, 1, "Captured Sentry events: \(captures.snapshot)")
        let cleanup = captures.snapshot.first { $0.errorText.contains("bodies") }
        XCTAssertEqual(captures.snapshot.filter { $0.errorText.contains("bodies") }.count, 1)
        if let cleanup {
            XCTAssertNotEqual(cleanup.userId, "account-B")
        } else {
            XCTFail("Expected the erasure failure event to reach beforeSend")
        }

        SentrySDK.capture(error: NSError(domain: "NativeAttributionControl", code: 1))
        await fulfillment(of: [controlCaptured], timeout: 5)
        XCTAssertEqual(captures.snapshot.count, 2, "Captured Sentry events: \(captures.snapshot)")
        let control = captures.snapshot.first { $0.errorText.contains("NativeAttributionControl") }
        XCTAssertEqual(captures.snapshot.filter { $0.errorText.contains("NativeAttributionControl") }.count, 1)
        if let control {
            XCTAssertEqual(control.userId, "account-B")
        } else {
            XCTFail("Expected the control event to reach beforeSend")
        }
    }

    func assertFailureFencePersistsAfterRestore(
        directory: URL,
        backup: URL,
        context: TestAppContext,
        module: WhoopBleModule
    ) async throws {
        try restoreBodyDirectory(directory, backup: backup)
        let configure = """
            configureUpload({
                userId: 'bridge-test-account', serverURL: 'https://example.com',
                token: 'test-session', headers: {}
            })
            """
        let rejected = try await outcome(configure, in: context)
        XCTAssertTrue(rejected.contains("configuration is blocked because cleanup failed"), rejected)
        module.connectionManager.syncOnBleQueue { XCTAssertTrue(module.captureSuspended) }

        let cleaned = try await outcome("disableUploads()", in: context)
        XCTAssertEqual(cleaned, "unexpected success")
        let reconfigured = try await outcome(configure, in: context)
        XCTAssertEqual(reconfigured, "unexpected success")
    }
}

func expectedCleanupStages(hasRetainedCutoff: Bool) -> [String] {
    var stages = [
        "ble_suspend", "disconnect", "uploader_bootstrap", "uploader_disable",
        "uploader_queue_wait", "uploader_cancel_tasks", "uploader_store_purge",
        "store_lock_wait", "store_begin", "store_reset_stats", "store_delete_samples",
        "store_delete_batches", "store_clear_binding", "store_rotate_generation",
        "store_commit", "store_completed", "store_vacuum", "uploader_remove_bodies", "completed"
    ]
    if hasRetainedCutoff, let purgeIndex = stages.firstIndex(of: "uploader_store_purge") {
        stages.insert("uploader_advance_erasure_cutoff", at: purgeIndex)
    }
    return stages
}
