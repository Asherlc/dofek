import Foundation
import RNSentry

/// Dofek application bootstrap; excluded from the standalone protocol package.
enum WhoopBleUploadRuntime {
    static let sessionIdentifier = "app.dofek.whoop-ble.upload.v1"
    private static let bootstrap = WhoopBleUploadBootstrap(makeUploader: makeUploader, reportError: reportNativeError)

    static func shared() throws -> WhoopBleBackgroundUploader {
        try bootstrap.shared()
    }

    static func prepare(onFailure: @escaping (Error) -> Void) {
        bootstrap.prepare(onFailure: onFailure)
    }

    static func handleBackgroundEvents(completionHandler: @escaping () -> Void) {
        bootstrap.handleBackgroundEvents(completionHandler: completionHandler)
    }

    private static func makeUploader() throws -> WhoopBleBackgroundUploader {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("WhoopBleUploads", isDirectory: true)
        let store = try WhoopBleSampleStore(directory: base)
        if let cutoff = UserDefaults.standard.object(forKey: "dofek_device_erasure_cutoff_v1") as? Date {
            try store.advanceErasureCutoff(to: cutoff)
        }
        return try WhoopBleBackgroundUploader(
            store: store,
            directory: base.appendingPathComponent("bodies", isDirectory: true),
            transport: WhoopURLSessionTransport(), reportError: reportNativeError
        )
    }

    static func reportNativeError(_ error: Error) {
        SentrySDK.capture(error: error)
    }
}
