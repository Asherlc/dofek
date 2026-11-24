import Foundation

/// Watch-to-iPhone file-transfer glance state for the first screen.
///
/// Precedence: paused, queued (`waitingForPhone`), unavailable, preparing,
/// failed, empty. Callers gate session-derived queue and companion flags on
/// activation. Live reachability never gates a valid existing queue.
enum WatchPhoneTransferStatus: Equatable, Sendable {
    case paused
    case waitingForPhone
    case unavailable
    case preparing
    case failed
    case empty

    static func resolve(
        isSyncEnabled: Bool,
        isCompanionAvailable: Bool,
        hasOutstandingFileTransfers: Bool,
        isTransferring: Bool,
        hasFailedAttempt: Bool
    ) -> Self {
        if !isSyncEnabled {
            return .paused
        }

        if hasOutstandingFileTransfers {
            return .waitingForPhone
        }

        if !isCompanionAvailable {
            return .unavailable
        }

        if isTransferring {
            return .preparing
        }

        if hasFailedAttempt {
            return .failed
        }

        return .empty
    }

    var title: String {
        switch self {
        case .paused:
            return "Sync paused"
        case .waitingForPhone:
            return "Waiting for iPhone"
        case .unavailable:
            return "Connection unavailable"
        case .preparing:
            return "Preparing files"
        case .failed:
            return "Transfer failed"
        case .empty:
            return "No files queued"
        }
    }

    var detail: String {
        switch self {
        case .paused:
            return "Sync resumes from your iPhone."
        case .waitingForPhone:
            return "Files send when the iPhone is available."
        case .unavailable:
            return "Check your iPhone connection."
        case .preparing:
            return "Getting motion data ready."
        case .failed:
            return "Try sending the files again."
        case .empty:
            return "Check for new motion data."
        }
    }
}
