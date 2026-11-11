import Foundation

/// Serializes the durable runtime without blocking application lifecycle callbacks.
final class WhoopBleUploadBootstrap {
    private let queue = DispatchQueue(label: "app.dofek.whoop-ble.bootstrap", qos: .utility)
    private let makeUploader: () throws -> WhoopBleBackgroundUploader
    private let reportError: (Error) -> Void
    private var uploader: WhoopBleBackgroundUploader?

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

    private func loadUploader() throws -> WhoopBleBackgroundUploader {
        if let uploader { return uploader }
        let service = try makeUploader()
        uploader = service
        return service
    }
}
