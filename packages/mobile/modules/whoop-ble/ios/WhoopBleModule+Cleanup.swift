import Darwin
import Foundation
import RNSentry

extension WhoopBleModule {
    func disableUploads() throws {
        var telemetry = WhoopBleCleanupTelemetry()
        var currentCacheWritePages: (() -> Int?)?
        telemetry.record("ble_suspend")
        connectionManager.syncOnBleQueue {
            captureSuspended = true
            stopManagedHistory()
            watchdog.stop()
        }
        telemetry.record("disconnect")
        connectionManager.disconnect()
        do {
            telemetry.record("uploader_bootstrap")
            try WhoopBleUploadRuntime.withUploaderForCleanup { uploader in
                currentCacheWritePages = { uploader.sqliteCacheWritePages }
                telemetry.record("uploader_disable")
                let cutoff = UserDefaults.standard.object(forKey: Self.deviceErasureCutoffKey) as? Date
                try uploader.disable(cutoff: cutoff) { nextStage in
                    telemetry.record(
                        nextStage.name,
                        attributes: nextStage.attributes,
                        cacheWritePages: uploader.sqliteCacheWritePages
                    )
                }
                telemetry.record("completed", cacheWritePages: uploader.sqliteCacheWritePages)
            }
            cleanupFailure = nil
        } catch {
            cleanupFailure = error.localizedDescription
            telemetry.recordFailure(cacheWritePages: currentCacheWritePages?())
            SentrySDK.capture(error: error) { scope in scope.setUser(nil) }
            throw error
        }
    }
}
