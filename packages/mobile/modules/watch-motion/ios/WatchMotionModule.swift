import ExpoModulesCore
import Sentry
import WatchConnectivity

public class WatchMotionModule: Module, WatchFileReceiverObserver {
    private var session: WCSession?
    private let pendingDirectory = WatchFileInbox.shared.pendingDirectory
    private let accountStateStore = WatchMotionAccountStateStore(userDefaults: .standard)

    public func definition() -> ModuleDefinition {
        Name("WatchMotion")

        Events("onWatchFileReceived")

        OnCreate {
            self.initializeSession()
        }

        Function("isWatchSupported") {
            return WCSession.isSupported()
        }

        Function("isWatchPaired") { () -> Bool in
            self.isWatchPaired()
        }

        Function("isWatchAppInstalled") { () -> Bool in
            self.isWatchAppInstalled()
        }

        Function("getWatchSyncStatus") { () -> [String: Any] in
            self.watchSyncStatus()
        }

        AsyncFunction("requestWatchSync") { (promise: Promise) in
            self.requestWatchSync(promise: promise)
        }

        /// Ask the Watch to restart its accelerometer recording session.
        /// This ensures continuous coverage even if the user never opens
        /// the Watch app — the iPhone can keep the 12-hour sessions rolling.
        AsyncFunction("requestWatchRecording") { (promise: Promise) in
            self.requestWatchRecording(promise: promise)
        }

        /// List the file names in the pending transfer directory.
        /// Used by the per-file sync to process files individually.
        Function("getPendingWatchFileNames") { () -> [String] in
            let names = self.listPendingFileNames()
            NSLog("[WatchMotion] getPendingWatchFileNames: %d files", names.count)
            return names
        }

        /// Read and parse a single pending Watch transfer file.
        /// Returns the parsed accelerometer samples from that file.
        AsyncFunction("readWatchFile") { (fileName: String, promise: Promise) in
            self.readWatchFile(fileName: fileName, promise: promise)
        }

        /// Read and parse a single pending Watch altitude transfer file.
        AsyncFunction("readWatchAltitudeFile") { (fileName: String, promise: Promise) in
            self.readWatchAltitudeFile(fileName: fileName, promise: promise)
        }

        /// Delete a single pending Watch transfer file after successful upload.
        Function("deleteWatchFile") { (fileName: String) in
            self.deleteWatchFile(fileName: fileName)
        }

        AsyncFunction("enableAccountSync") { (promise: Promise) in
            self.enableAccountSync(promise: promise)
        }

        AsyncFunction("purgeAccountState") { (cutoffString: String, promise: Promise) in
            self.purgeAccountState(cutoffString: cutoffString, promise: promise)
        }
    }

    private func initializeSession() {
        guard WCSession.isSupported() else { return }
        let wcSession = WCSession.default
        wcSession.delegate = WatchSessionDelegateHolder.shared
        WatchSessionDelegateHolder.shared.module = self
        wcSession.activate()
        session = wcSession
    }

    private func isWatchPaired() -> Bool {
        session?.isPaired ?? false
    }

    private func isWatchAppInstalled() -> Bool {
        session?.isWatchAppInstalled ?? false
    }

    private func watchSyncStatus() -> [String: Any] {
        guard let session else {
            return [
                "isSupported": false,
                "isPaired": false,
                "isReachable": false,
                "isWatchAppInstalled": false,
                "pendingFileCount": 0,
            ]
        }
        return [
            "isSupported": true,
            "isPaired": session.isPaired,
            "isReachable": session.isReachable,
            "isWatchAppInstalled": session.isWatchAppInstalled,
            "pendingFileCount": countPendingFiles(),
        ]
    }

    private func requestWatchSync(promise: Promise) {
        guard accountStateStore.isSyncEnabled,
              let session,
              session.isReachable else {
            promise.resolve(false)
            return
        }
        session.sendMessage(["action": "sync_accelerometer"], replyHandler: { _ in
            promise.resolve(true)
        }, errorHandler: { _ in
            promise.resolve(false)
        })
    }

    private func requestWatchRecording(promise: Promise) {
        guard accountStateStore.isSyncEnabled,
              let session,
              session.isReachable else {
            promise.resolve(false)
            return
        }
        session.sendMessage(["action": "sync_and_record"], replyHandler: { _ in
            promise.resolve(true)
        }, errorHandler: { _ in
            promise.resolve(false)
        })
    }

    private func readWatchFile(fileName: String, promise: Promise) {
        readWatchFile(fileName: fileName, promise: promise, logPrefix: "readWatchFile")
    }

    private func readWatchAltitudeFile(fileName: String, promise: Promise) {
        readWatchFile(fileName: fileName, promise: promise, logPrefix: "readWatchAltitudeFile")
    }

    private func readWatchFile(fileName: String, promise: Promise, logPrefix: String) {
        DispatchQueue.global(qos: .userInitiated).async {
            guard let fileURL = self.pendingFileURL(for: fileName) else {
                promise.reject("INVALID_FILENAME", "Invalid pending file name")
                return
            }
            do {
                let fileData = try Data(contentsOf: fileURL)
                NSLog("[WatchMotion] %@ %@: %d bytes", logPrefix, fileName, fileData.count)
                let samples = self.filterAfterDeviceErasureCutoff(
                    try SampleFileParser.parse(fileData)
                )
                NSLog("[WatchMotion] %@ %@: parsed %d samples", logPrefix, fileName, samples.count)
                promise.resolve(samples)
            } catch {
                NSLog("[WatchMotion] %@ %@ FAILED: %@", logPrefix, fileName, error.localizedDescription)
                promise.reject("PARSE_ERROR", "Failed to parse \(fileName): \(error.localizedDescription)")
            }
        }
    }

    private func deleteWatchFile(fileName: String) {
        guard let fileURL = pendingFileURL(for: fileName) else {
            NSLog("[WatchMotion] deleteWatchFile rejected invalid name: %@", fileName)
            return
        }
        NSLog("[WatchMotion] deleteWatchFile: %@", fileName)
        try? FileManager.default.removeItem(at: fileURL)
    }

    private func enableAccountSync(promise: Promise) {
        accountStateStore.enableSync()
        guard let session else {
            promise.resolve(true)
            return
        }
        session.transferUserInfo(["action": "enable_account_sync"])
        promise.resolve(true)
    }

    private func purgeAccountState(cutoffString: String, promise: Promise) {
        guard let cutoff = parseIsoDate(cutoffString) else {
            promise.reject("WATCH_INVALID_ERASURE_CUTOFF", "Invalid device erasure cutoff")
            return
        }
        accountStateStore.purge(at: cutoff)
        do {
            try WatchFileInbox.shared.purgePendingFiles()
        } catch {
            SentrySDK.capture(error: error)
            promise.reject(
                "WATCH_PENDING_FILE_PURGE_ERROR",
                "Failed to clear pending Watch files: \(error.localizedDescription)"
            )
            return
        }
        if let session {
            session.transferUserInfo([
                "action": "purge_account_state",
                "deviceErasureCutoff": cutoffString,
            ])
        }
        promise.resolve(true)
    }

    // MARK: - File received from Watch

    func watchFileReceiver(
        didPersist fileName: String,
        metadata: [String: Any]?
    ) {
        let sampleCount = metadata?["sampleCount"] as? Int ?? -1
        let fileType = metadata?["type"] as? String ?? "accelerometer_samples"
        NSLog(
            "[WatchMotion] Saved Watch file to pending: %@ (%d samples, type=%@, total pending: %d)",
            fileName,
            sampleCount,
            fileType,
            countPendingFiles()
        )
        sendEvent("onWatchFileReceived", [
            "fileName": fileName,
            "metadata": metadata ?? [:],
        ])
    }

    // MARK: - Pending file operations

    private func isSafePendingFileName(_ fileName: String) -> Bool {
        if fileName.isEmpty { return false }
        if fileName.contains("..") { return false }
        if fileName.contains("/") || fileName.contains("\\") { return false }
        return fileName == (fileName as NSString).lastPathComponent
    }

    private func pendingFileURL(for fileName: String) -> URL? {
        guard isSafePendingFileName(fileName) else { return nil }
        return pendingDirectory.appendingPathComponent(fileName)
    }

    private func listPendingFileNames() -> [String] {
        let contents = try? FileManager.default.contentsOfDirectory(
            at: pendingDirectory,
            includingPropertiesForKeys: nil
        )
        return contents?.map { $0.lastPathComponent } ?? []
    }

    private func countPendingFiles() -> Int {
        let contents = try? FileManager.default.contentsOfDirectory(
            at: pendingDirectory,
            includingPropertiesForKeys: nil
        )
        return contents?.count ?? 0
    }

    private func filterAfterDeviceErasureCutoff(
        _ samples: [[String: Any]]
    ) -> [[String: Any]] {
        guard accountStateStore.deviceErasureCutoff != nil else {
            return samples
        }
        return samples.filter { sample in
            guard let timestamp = sample["timestamp"] as? String,
                  let date = parseIsoDate(timestamp) else {
                return false
            }
            return accountStateStore.shouldInclude(timestamp: date)
        }
    }

    private func parseIsoDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = formatter.date(from: value) {
            return parsed
        }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}

// MARK: - WCSession Delegate (singleton holder to avoid retain cycles)

private class WatchSessionDelegateHolder: NSObject, WCSessionDelegate {
    static let shared = WatchSessionDelegateHolder()
    private let receiver = WatchFileReceiver(
        inbox: .shared,
        shouldAcceptFile: {
            WatchMotionAccountStateStore(userDefaults: .standard).isSyncEnabled
        },
        reportError: { error in
            NSLog("[WatchMotion] Failed to persist received Watch file: %@", error.localizedDescription)
            SentrySDK.capture(error: error)
        }
    )
    weak var module: WatchMotionModule? {
        didSet {
            receiver.observer = module
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        NSLog("[WatchMotion] WCSession activation: %@ (error: %@)",
              activationState == .activated ? "activated" : "failed",
              error?.localizedDescription ?? "none")
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate for multi-watch support
        session.activate()
    }

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        NSLog("[WatchMotion] didReceive file: %@, module attached: %@",
              file.fileURL.lastPathComponent,
              module != nil ? "YES" : "NO")
        receiver.receive(fileURL: file.fileURL, metadata: file.metadata)
    }
}
