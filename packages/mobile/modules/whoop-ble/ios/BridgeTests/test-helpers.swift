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
        [(WhoopBleModule.self, "WhoopBle")]
    }
}
