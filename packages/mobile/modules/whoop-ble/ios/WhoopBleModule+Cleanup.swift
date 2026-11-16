import Darwin
import Foundation
import RNSentry

extension WhoopBleModule {
    func disableUploads() throws {
        let operationId = UUID().uuidString
        let startedAt = ProcessInfo.processInfo.systemUptime
        var stage = "ble_suspend"
        var cacheWritePageBaseline: Int?
        var currentCacheWritePages: (() -> Int?)?

        func recordStage(_ nextStage: String, cacheWritePages: Int? = nil) {
            stage = nextStage
            if nextStage == "uploader_cancel_tasks" { cacheWritePageBaseline = cacheWritePages }
            var attributes: [String: Any] = [
                "operation": "disableUploads", "operationId": operationId, "stage": stage,
                "isMainThread": Thread.isMainThread, "threadId": Int(pthread_mach_thread_np(pthread_self())),
                "durationMs": (ProcessInfo.processInfo.systemUptime - startedAt) * 1_000
            ]
            if let cacheWritePages, let cacheWritePageBaseline {
                attributes["sqliteCacheWritePages"] = max(0, cacheWritePages - cacheWritePageBaseline)
            }
            SentrySDK.logger.info("WHOOP cleanup stage", attributes: attributes)
        }

        recordStage("ble_suspend")
        connectionManager.syncOnBleQueue {
            captureSuspended = true
            watchdog.stop()
        }
        recordStage("disconnect")
        connectionManager.disconnect()
        do {
            recordStage("uploader_bootstrap")
            let uploader = try self.uploader
            currentCacheWritePages = { uploader.sqliteCacheWritePages }
            recordStage("uploader_disable")
            let cutoff = UserDefaults.standard.object(forKey: Self.deviceErasureCutoffKey) as? Date
            try uploader.disable(cutoff: cutoff) { nextStage in
                recordStage(nextStage, cacheWritePages: uploader.sqliteCacheWritePages)
            }
            recordStage("completed", cacheWritePages: uploader.sqliteCacheWritePages)
            cleanupFailure = nil
        } catch {
            cleanupFailure = error.localizedDescription
            var attributes: [String: Any] = [
                "operation": "disableUploads", "operationId": operationId,
                "stage": "failed", "failedStage": stage,
                "isMainThread": Thread.isMainThread, "threadId": Int(pthread_mach_thread_np(pthread_self())),
                "durationMs": (ProcessInfo.processInfo.systemUptime - startedAt) * 1_000
            ]
            if let pages = currentCacheWritePages?(), let cacheWritePageBaseline {
                attributes["sqliteCacheWritePages"] = max(0, pages - cacheWritePageBaseline)
            }
            SentrySDK.logger.error("WHOOP cleanup failed", attributes: attributes)
            SentrySDK.capture(error: error) { scope in scope.setUser(nil) }
            throw error
        }
    }
}
