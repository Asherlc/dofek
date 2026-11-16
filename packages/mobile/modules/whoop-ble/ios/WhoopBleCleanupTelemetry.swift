import Darwin
import Foundation
import RNSentry

struct WhoopBleCleanupTelemetry {
    let operationId = UUID().uuidString
    let startedAt = ProcessInfo.processInfo.systemUptime
    private(set) var stage = "ble_suspend"

    mutating func record(_ nextStage: String, attributes extraAttributes: [String: WhoopCleanupAttribute] = [:]) {
        stage = nextStage
        var attributes: [String: SentryAttribute] = [:]
        attributes["operation"] = SentryAttribute(string: "disableUploads")
        attributes["operationId"] = SentryAttribute(string: operationId)
        attributes["stage"] = SentryAttribute(string: stage)
        attributes["isMainThread"] = SentryAttribute(boolean: Thread.isMainThread)
        attributes["threadId"] = SentryAttribute(integer: Int(pthread_mach_thread_np(pthread_self())))
        attributes["durationMs"] = SentryAttribute(
            double: (ProcessInfo.processInfo.systemUptime - startedAt) * 1_000
        )
        for (key, value) in extraAttributes {
            switch value {
            case let .string(value): attributes[key] = SentryAttribute(string: value)
            case let .integer(value): attributes[key] = SentryAttribute(integer: value)
            }
        }
        SentrySDK.logger.info("WHOOP cleanup stage", attributes: attributes)
    }

    func recordFailure() {
        SentrySDK.logger.error("WHOOP cleanup failed", attributes: [
            "operation": "disableUploads", "operationId": operationId,
            "stage": "failed", "failedStage": stage,
            "isMainThread": Thread.isMainThread, "threadId": Int(pthread_mach_thread_np(pthread_self())),
            "durationMs": (ProcessInfo.processInfo.systemUptime - startedAt) * 1_000
        ])
    }
}
