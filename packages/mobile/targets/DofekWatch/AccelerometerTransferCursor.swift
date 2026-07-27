import Foundation

enum AccelerometerTransferCompletion {
    case confirmed(Date)
    case failed(Error)
    case invalidMetadata
}

/// Owns the durable boundary for accelerometer samples confirmed by the iPhone.
///
/// Preparing or queueing a file never mutates this cursor. The boundary travels
/// with the queued file and is persisted only after WatchConnectivity reports a
/// successful completion for that exact transfer.
final class AccelerometerTransferCursor {
    private static let defaultsKey = "com.dofek.watch.accelerometer.lastQueryCursor"
    private static let metadataKey = "accelerometerCursorTimeIntervalSinceReferenceDate"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var confirmedBoundary: Date? {
        defaults.object(forKey: Self.defaultsKey) as? Date
    }

    func metadata(through boundary: Date) -> [String: Any] {
        [
            Self.metadataKey: boundary.timeIntervalSinceReferenceDate,
        ]
    }

    func completeTransfer(
        metadata: [String: Any]?,
        error: Error?
    ) -> AccelerometerTransferCompletion {
        if let error {
            return .failed(error)
        }

        guard let rawBoundary = metadata?[Self.metadataKey] as? TimeInterval else {
            return .invalidMetadata
        }

        let boundary = Date(timeIntervalSinceReferenceDate: rawBoundary)
        confirm(through: boundary)
        return .confirmed(boundary)
    }

    func confirm(through boundary: Date) {
        defaults.set(boundary, forKey: Self.defaultsKey)
    }

    func purge() {
        defaults.removeObject(forKey: Self.defaultsKey)
    }
}
