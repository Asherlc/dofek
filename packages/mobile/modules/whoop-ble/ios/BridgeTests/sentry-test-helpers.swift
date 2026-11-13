import ExpoWhoopBle
import Foundation
import RNSentry
import XCTest

final class CleanupLogRecorder {
    private let lock = NSLock()
    private var records: [SentryLog] = []
    private var controlLog: SentryLog?

    @MainActor
    func start(entry: XCTestExpectation? = nil) {
        SentrySDK.start { options in
            options.dsn = "https://key@sentry.example/123"
            options.beforeSendLog = { log in
                guard log.attributes["operation"]?.value as? String == "disableUploads" else { return nil }
                self.append(log)
                if log.attributes["stage"]?.value as? String == "ble_suspend" { entry?.fulfill() }
                return nil
            }
            WhoopBleModule.configureCleanupLogAttribution(options)
        }
    }

    func append(_ log: SentryLog) {
        lock.withLock { records.append(log) }
    }

    var snapshot: [SentryLog] { lock.withLock { records } }

    func recordControl(_ log: SentryLog) {
        lock.withLock { controlLog = log }
    }

    func assertAnonymousCleanupAndAttributedControl(userId: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(snapshot.isEmpty, file: file, line: line)
        for record in snapshot {
            for key in ["user.id", "user.name", "user.email"] {
                XCTAssertNil(record.attributes[key], "Cleanup stage inherited \(key): \(record.body)", file: file, line: line)
            }
        }
        let control = lock.withLock { controlLog }
        XCTAssertEqual(control?.attributes["user.id"]?.value as? String, userId, file: file, line: line)
        XCTAssertEqual(control?.attributes["user.name"]?.value as? String, "Synthetic \(userId)", file: file, line: line)
        XCTAssertEqual(control?.attributes["user.email"]?.value as? String, "\(userId)@sentry.example", file: file, line: line)
    }

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

func identifySyntheticSentryUser(_ userId: String) {
    let user = Sentry.User(userId: userId)
    user.name = "Synthetic \(userId)"
    user.email = "\(userId)@sentry.example"
    SentrySDK.setUser(user)
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
                if log.body == "NativeAttributionLogControl" { logs?.recordControl(log) }
                guard log.attributes["operation"]?.value as? String == "disableUploads" else { return nil }
                logs?.append(log)
                if log.attributes["stage"]?.value as? String == "ble_suspend" { logEntry?.fulfill() }
                return nil
            }
            WhoopBleModule.configureCleanupLogAttribution(options)
        }
        identifySyntheticSentryUser(userId)
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
