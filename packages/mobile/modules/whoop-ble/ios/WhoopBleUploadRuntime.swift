import Foundation
import RNSentry

/// Dofek application bootstrap; excluded from the standalone protocol package.
enum WhoopBleUploadRuntime {
    static let sessionIdentifier = "app.dofek.whoop-ble.upload.v1"
    private static let sharedLock = NSLock()
    private static var instance: WhoopBleBackgroundUploader?

    static func shared() throws -> WhoopBleBackgroundUploader {
        sharedLock.lock(); defer { sharedLock.unlock() }
        if let instance { return instance }
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("WhoopBleUploads", isDirectory: true)
        let store = try WhoopBleSampleStore(directory: base)
        if let cutoff = UserDefaults.standard.object(forKey: "dofek_device_erasure_cutoff_v1") as? Date {
            try store.advanceErasureCutoff(to: cutoff)
        }
        let service = try WhoopBleBackgroundUploader(
            store: store,
            directory: base.appendingPathComponent("bodies", isDirectory: true),
            transport: WhoopURLSessionTransport(), reportError: reportNativeError
        )
        instance = service
        return service
    }

    static func reportNativeError(_ error: Error) {
        SentrySDK.capture(error: error)
    }
}
