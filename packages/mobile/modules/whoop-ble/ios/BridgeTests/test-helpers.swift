@testable import ExpoModulesCore
import ExpoModulesTestCore
import RNSentry
import XCTest
@testable import ExpoWhoopBle

final class CleanupLogRecorder {
    private let lock = NSLock()
    private var records: [SentryLog] = []

    @MainActor
    func start(entry: XCTestExpectation) {
        SentrySDK.start { options in
            options.dsn = "https://key@sentry.example/123"
            options.beforeSendLog = { log in
                guard log.attributes["operation"]?.value as? String == "disableUploads" else { return nil }
                self.append(log)
                if log.attributes["stage"]?.value as? String == "ble_suspend" { entry.fulfill() }
                return nil
            }
        }
    }

    func append(_ log: SentryLog) {
        lock.withLock { records.append(log) }
    }

    var snapshot: [SentryLog] { lock.withLock { records } }

    func assertOperationMetadata(file: StaticString = #filePath, line: UInt = #line) throws {
        let records = snapshot
        let operationId = try XCTUnwrap(records.first?.attributes["operationId"]?.value as? String, file: file, line: line)
        XCTAssertNotNil(UUID(uuidString: operationId), file: file, line: line)
        XCTAssertTrue(records.allSatisfy { $0.attributes["operationId"]?.value as? String == operationId }, file: file, line: line)
        for record in records {
            XCTAssertNotNil(record.attributes["durationMs"]?.value as? Double, file: file, line: line)
            XCTAssertEqual(record.attributes["isMainThread"]?.value as? Bool, false, file: file, line: line)
            XCTAssertGreaterThan(try XCTUnwrap(record.attributes["threadId"]?.value as? Int), 0, file: file, line: line)
        }
    }
}

struct SentryCapturedEvent: CustomStringConvertible {
    let userId: String?
    let errorText: String

    var description: String { "userId=\(userId ?? "nil"), error=\(errorText)" }
}

final class SentryCaptureRecorder {
    private let lock = NSLock()
    private var events: [SentryCapturedEvent] = []
    private var pendingExpectations: [(text: String, expectation: XCTestExpectation)] = []

    @MainActor
    func start(userId: String, logs: CleanupLogRecorder? = nil, logEntry: XCTestExpectation? = nil) {
        SentrySDK.start { options in
            options.dsn = "https://key@sentry.example/123"
            options.beforeSend = { event in
                let errorText = [event.error?.localizedDescription]
                    .compactMap { $0 }
                    .joined(separator: " ") + " " + (event.exceptions?.compactMap(\.value).joined(separator: " ") ?? "")
                self.record(userId: event.user?.userId, errorText: errorText)
                return nil
            }
            options.beforeSendLog = { log in
                guard log.attributes["operation"]?.value as? String == "disableUploads" else { return nil }
                logs?.append(log)
                if log.attributes["stage"]?.value as? String == "ble_suspend" { logEntry?.fulfill() }
                return nil
            }
        }
        SentrySDK.configureScope { scope in
            scope.setUser(Sentry.User(userId: userId))
        }
    }

    func expect(_ expectation: XCTestExpectation, matching text: String) {
        lock.withLock { pendingExpectations.append((text, expectation)) }
    }

    func record(userId: String?, errorText: String) {
        let expectation = lock.withLock { () -> XCTestExpectation? in
            events.append(SentryCapturedEvent(userId: userId, errorText: errorText))
            guard let index = pendingExpectations.firstIndex(where: { errorText.contains($0.text) }) else { return nil }
            return pendingExpectations.remove(at: index).expectation
        }
        expectation?.fulfill()
    }

    var snapshot: [SentryCapturedEvent] { lock.withLock { events } }
}

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
