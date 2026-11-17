import Darwin
import Foundation
import RNSentry

struct WhoopBleCleanupTelemetry {
    let operationId = UUID().uuidString
    let startedAt = ProcessInfo.processInfo.systemUptime
    private(set) var stage = "ble_suspend"
    private var cacheWritePageBaseline: Int?

    mutating func record(
        _ nextStage: String,
        attributes extraAttributes: [String: WhoopCleanupAttribute] = [:],
        cacheWritePages: Int? = nil
    ) {
        stage = nextStage
        if nextStage == "uploader_cancel_tasks" { cacheWritePageBaseline = cacheWritePages }
        var stageAttributes = extraAttributes
        if let cacheWritePages, let cacheWritePageBaseline {
            stageAttributes["sqliteCacheWritePages"] = .integer(max(0, cacheWritePages - cacheWritePageBaseline))
        }
        var attributes: [String: SentryAttribute] = [:]
        attributes["operation"] = SentryAttribute(string: "disableUploads")
        attributes["operationId"] = SentryAttribute(string: operationId)
        attributes["stage"] = SentryAttribute(string: stage)
        attributes["isMainThread"] = SentryAttribute(boolean: Thread.isMainThread)
        attributes["threadId"] = SentryAttribute(integer: Int(pthread_mach_thread_np(pthread_self())))
        attributes["durationMs"] = SentryAttribute(
            double: (ProcessInfo.processInfo.systemUptime - startedAt) * 1_000
        )
        for (key, value) in stageAttributes {
            switch value {
            case let .string(value): attributes[key] = SentryAttribute(string: value)
            case let .integer(value): attributes[key] = SentryAttribute(integer: value)
            }
        }
        SentrySDK.logger.info("WHOOP cleanup stage", attributes: attributes)
    }

    func recordFailure(cacheWritePages: Int? = nil) {
        var attributes: [String: SentryAttribute] = [
            "operation": SentryAttribute(string: "disableUploads"),
            "operationId": SentryAttribute(string: operationId),
            "stage": SentryAttribute(string: "failed"),
            "failedStage": SentryAttribute(string: stage),
            "isMainThread": SentryAttribute(boolean: Thread.isMainThread),
            "threadId": SentryAttribute(integer: Int(pthread_mach_thread_np(pthread_self()))),
            "durationMs": SentryAttribute(double: (ProcessInfo.processInfo.systemUptime - startedAt) * 1_000)
        ]
        if let cacheWritePages, let cacheWritePageBaseline {
            attributes["sqliteCacheWritePages"] = SentryAttribute(
                integer: max(0, cacheWritePages - cacheWritePageBaseline)
            )
        }
        SentrySDK.logger.error("WHOOP cleanup failed", attributes: attributes)
    }
}
