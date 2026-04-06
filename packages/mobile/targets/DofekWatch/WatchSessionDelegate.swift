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

    private override init() {
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
        guard let action = message["action"] as? String else {
            replyHandler(["status": "unknown_action"])
            return
        }

        switch action {
        case "sync_accelerometer":
            onSyncRequested?()
            replyHandler(["status": "sync_started"])
        case "start_recording":
            onRecordingRequested?()
            replyHandler(["status": "recording_started"])
        case "sync_and_record":
            onRecordingRequested?()
            onSyncRequested?()
            replyHandler(["status": "recording_and_sync_started"])
        default:
            replyHandler(["status": "unknown_action"])
        }
    }

    func session(
        _ session: WCSession,
        didFinish fileTransfer: WCSessionFileTransfer,
        error: Error?
    ) {
        if let error = error {
            print("[DofekWatch] File transfer failed: \(error.localizedDescription)")
        } else {
            print("[DofekWatch] File transfer completed successfully")
        }
    }
}
