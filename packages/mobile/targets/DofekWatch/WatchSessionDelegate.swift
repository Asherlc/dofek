#if canImport(Sentry)
import Sentry
#endif
import Foundation
import WatchConnectivity

/// WCSession delegate for the Watch side.
/// Handles activation, receives sync requests from the iPhone,
/// and tracks transfer completion.
final class WatchSessionDelegate: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = WatchSessionDelegate()

    @Published var isActivated: Bool = false
    @Published var isIPhoneReachable: Bool = false

    /// Callback triggered when the iPhone requests a sync.
    var onSyncRequested: (() -> Void)?
    /// Callback triggered when the iPhone requests recording to start/restart.
    var onRecordingRequested: (() -> Void)?
    var onPurgeRequested: ((Date) -> Void)?
    var onAccountSyncEnabled: (() -> Void)?
    /// Callback triggered when a queued file transfer finishes.
    var onFileTransferFinished: ((WCSessionFileTransfer, Error?) -> Void)?

    override private init() {
        super.init()
    }

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    // MARK: - WCSessionDelegate

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        DispatchQueue.main.async {
            self.isActivated = activationState == .activated
            self.isIPhoneReachable = session.isReachable
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.isIPhoneReachable = session.isReachable
        }
    }

    func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        replyHandler(["status": handle(message)])
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        _ = handle(userInfo)
    }

    func session(
        _ session: WCSession,
        didFinish fileTransfer: WCSessionFileTransfer,
        error: Error?
    ) {
        let transferredURL = fileTransfer.file.fileURL
        if let error = error {
            NSLog("[DofekWatch] File transfer failed: %@", error.localizedDescription)
        } else {
            NSLog("[DofekWatch] File transfer completed successfully")
        }

        do {
            try FileManager.default.removeItem(at: transferredURL)
        } catch {
            NSLog("[DofekWatch] Failed to remove transferred file: %@", error.localizedDescription)
            #if canImport(Sentry)
            SentrySDK.capture(error: error)
            #endif
        }

        onFileTransferFinished?(fileTransfer, error)
    }

    private func handle(_ message: [String: Any]) -> String {
        guard let action = message["action"] as? String else {
            return "unknown_action"
        }

        switch action {
        case "sync_accelerometer":
            onSyncRequested?()
            return "sync_started"
        case "start_recording":
            onRecordingRequested?()
            return "recording_started"
        case "sync_and_record":
            onRecordingRequested?()
            onSyncRequested?()
            return "recording_and_sync_started"
        case "purge_account_state":
            guard
                let cutoffString = message["deviceErasureCutoff"] as? String,
                let cutoff = Self.parseIsoDate(cutoffString)
            else {
                return "invalid_erasure_cutoff"
            }
            onPurgeRequested?(cutoff)
            return "account_state_purged"
        case "enable_account_sync":
            onAccountSyncEnabled?()
            return "account_sync_enabled"
        default:
            return "unknown_action"
        }
    }

    private static func parseIsoDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = formatter.date(from: value) {
            return parsed
        }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}
