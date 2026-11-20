import Foundation

/// Serializes the durable runtime without blocking application lifecycle callbacks.
final class WhoopBleUploadBootstrap {
    /// A cold cleanup created a temporary uploader with the app's fixed background
    /// session identifier. Ordinary consumers are rejected until that cleanup
    /// succeeds, so no second transport/session can be created for the same id.
    struct CleanupIncompleteError: Error, LocalizedError {
        var errorDescription: String? {
            "WHOOP account cleanup must finish before uploads resume"
        }
    }

    private let queue = DispatchQueue(label: "app.dofek.whoop-ble.bootstrap", qos: .utility)
    private let makeUploader: () throws -> WhoopBleBackgroundUploader
    private let reportError: (Error) -> Void
    private var uploader: WhoopBleBackgroundUploader?
    /// A retained cleanup-only uploader is waiting for a successful retry before
    /// it may be published as the shared service or superseded by a normal load.
    private var cleanupIncomplete = false

    init(makeUploader: @escaping () throws -> WhoopBleBackgroundUploader,
         reportError: @escaping (Error) -> Void) {
        self.makeUploader = makeUploader
        self.reportError = reportError
    }

    func shared() throws -> WhoopBleBackgroundUploader {
        try queue.sync { try loadUploader() }
    }

    func prepare(onFailure: @escaping (Error) -> Void) {
        queue.async {
            do { _ = try self.loadUploader() } catch { onFailure(error) }
        }
    }

    func handleBackgroundEvents(completionHandler: @escaping () -> Void) {
        queue.async {
            do { try self.loadUploader().handleBackgroundEvents(completionHandler: completionHandler) } catch {
                self.reportError(error)
                DispatchQueue.main.async(execute: completionHandler)
            }
        }
    }

    /// Whole-account cleanup may run cold while a persisted cutoff exists. Use
    /// the shared service when present; otherwise build a cleanup-only service
    /// that cannot reconcile or index staged chunks before the purge. On failure
    /// the temporary service is retained privately for retry and ordinary loads
    /// are rejected until a subsequent cleanup succeeds and publishes it. An
    /// already-normal service is reused unchanged whether cleanup succeeds or fails.
    func withUploaderForCleanup<T>(
        makeCleanupUploader: () throws -> WhoopBleBackgroundUploader,
        operation: (WhoopBleBackgroundUploader) throws -> T
    ) throws -> T {
        try queue.sync {
            let service: WhoopBleBackgroundUploader
            if let uploader {
                service = uploader
            } else {
                service = try makeCleanupUploader()
                // Retain the owner of the background session across cleanup retries.
                uploader = service
                cleanupIncomplete = true
            }
            let result = try operation(service)
            cleanupIncomplete = false
            return result
        }
    }

    private func loadUploader() throws -> WhoopBleBackgroundUploader {
        if cleanupIncomplete { throw CleanupIncompleteError() }
        if let uploader { return uploader }
        let service = try makeUploader()
        uploader = service
        return service
    }
}
