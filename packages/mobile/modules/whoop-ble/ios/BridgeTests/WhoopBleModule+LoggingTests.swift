import RNSentry
import XCTest
@testable import ExpoWhoopBle

extension WhoopBleModuleTests {
    func testCleanupLogAttributionPreservesCallbackResults() throws {
        let options = Sentry.Options()
        let log = SentryLog(level: .info, body: "WHOOP cleanup stage", attributes: [
            "operation": .init(string: "disableUploads"),
            "user.id": .init(string: "account-B")
        ])
        WhoopBleModule.configureCleanupLogAttribution(options)
        let unfiltered = try XCTUnwrap(options.beforeSendLog?(log))
        XCTAssertTrue(unfiltered === log)
        XCTAssertNil(unfiltered.attributes["user.id"])

        options.beforeSendLog = { _ in nil }
        WhoopBleModule.configureCleanupLogAttribution(options)
        XCTAssertNil(options.beforeSendLog?(log))

        let replacement = SentryLog(level: .warn, body: "Filtered cleanup", attributes: [
            "retained": .init(boolean: true)
        ])
        options.beforeSendLog = { _ in replacement }
        WhoopBleModule.configureCleanupLogAttribution(options)
        let filtered = try XCTUnwrap(options.beforeSendLog?(log))
        XCTAssertTrue(filtered === replacement)
        XCTAssertEqual(filtered.attributes["retained"]?.value as? Bool, true)
    }
}
