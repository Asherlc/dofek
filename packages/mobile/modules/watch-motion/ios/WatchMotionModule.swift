import ExpoModulesCore
import WatchConnectivity

public class WatchMotionModule: Module {
    private var session: WCSession?
    private let pendingDirectory: URL = {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let directory = appSupport.appendingPathComponent("watch-motion-pending", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }()
    private let defaults = UserDefaults.standard
    private let lastSyncKey = "com.dofek.watch-motion.lastSyncTimestamp"

    public func definition() -> ModuleDefinition {
        Name("WatchMotion")

        Events("onWatchFileReceived")

        OnCreate {
            if WCSession.isSupported() {
                let wcSession = WCSession.default
                wcSession.delegate = WatchSessionDelegateHolder.shared
                WatchSessionDelegateHolder.shared.module = self
                wcSession.activate()
                self.session = wcSession
            }
        }

        Function("isWatchSupported") {
            return WCSession.isSupported()
        }

        Function("isWatchPaired") { () -> Bool in
            guard let session = self.session else { return false }
            return session.isPaired
        }

        Function("isWatchAppInstalled") { () -> Bool in
            guard let session = self.session else { return false }
            return session.isWatchAppInstalled
        }

        Function("getWatchSyncStatus") { () -> [String: Any] in
            guard let session = self.session else {
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
                "pendingFileCount": self.countPendingFiles(),
            ]
        }

        AsyncFunction("requestWatchSync") { (promise: Promise) in
            guard let session = self.session, session.isReachable else {
                promise.resolve(false)
                return
            }
            session.sendMessage(["action": "sync_accelerometer"], replyHandler: { _ in
                promise.resolve(true)
            }, errorHandler: { _ in
                promise.resolve(false)
            })
        }

        /// Ask the Watch to restart its accelerometer recording session.
        /// This ensures continuous coverage even if the user never opens
        /// the Watch app — the iPhone can keep the 12-hour sessions rolling.
        AsyncFunction("requestWatchRecording") { (promise: Promise) in
            guard let session = self.session, session.isReachable else {
                promise.resolve(false)
                return
            }
            session.sendMessage(["action": "sync_and_record"], replyHandler: { _ in
                promise.resolve(true)
            }, errorHandler: { _ in
                promise.resolve(false)
            })
        }

        AsyncFunction("getPendingWatchSamples") { (promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let samples = try self.readAndParsePendingFiles()
                    promise.resolve(samples)
                } catch {
                    promise.reject("PARSE_ERROR", "Failed to parse Watch samples: \(error.localizedDescription)")
                }
            }
        }

        Function("acknowledgeWatchSamples") {
            self.deletePendingFiles()
        }

        /// List the file names in the pending transfer directory.
        /// Used by the per-file sync to process files individually.
        Function("getPendingWatchFileNames") { () -> [String] in
            return self.listPendingFileNames()
        }

        /// Read and parse a single pending Watch transfer file.
        /// Returns the parsed accelerometer samples from that file.
        AsyncFunction("readWatchFile") { (fileName: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                let fileURL = self.pendingDirectory.appendingPathComponent(fileName)
                do {
                    let fileData = try Data(contentsOf: fileURL)
                    let samples = try SampleFileParser.parse(fileData)
                    promise.resolve(samples)
                } catch {
                    promise.reject("PARSE_ERROR", "Failed to parse \(fileName): \(error.localizedDescription)")
                }
            }
        }

        /// Delete a single pending Watch transfer file after successful upload.
        Function("deleteWatchFile") { (fileName: String) in
            let fileURL = self.pendingDirectory.appendingPathComponent(fileName)
            try? FileManager.default.removeItem(at: fileURL)
        }

        Function("getLastWatchSyncTimestamp") { () -> String? in
            return self.defaults.string(forKey: self.lastSyncKey)
        }

        Function("setLastWatchSyncTimestamp") { (timestamp: String) in
            self.defaults.set(timestamp, forKey: self.lastSyncKey)
        }
    }

    // MARK: - File received from Watch

    func handleReceivedFile(fileURL: URL, metadata: [String: Any]?) {
        // Move the file to our pending directory
        let destinationName = "watch-accel-\(UUID().uuidString).json.gz"
        let destination = pendingDirectory.appendingPathComponent(destinationName)

        do {
            try FileManager.default.moveItem(at: fileURL, to: destination)
            sendEvent("onWatchFileReceived", [
                "fileName": destinationName,
                "metadata": metadata ?? [:],
            ])
        } catch {
            // If move fails, try copy + delete
            try? FileManager.default.copyItem(at: fileURL, to: destination)
            try? FileManager.default.removeItem(at: fileURL)
        }
    }

    // MARK: - Pending file operations

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

    private func readAndParsePendingFiles() throws -> [[String: Any]] {
        let fileManager = FileManager.default
        let contents = try fileManager.contentsOfDirectory(
            at: pendingDirectory,
            includingPropertiesForKeys: nil
        )

        var allSamples: [[String: Any]] = []

        for fileURL in contents {
            do {
                let fileData = try Data(contentsOf: fileURL)
                let samples = try SampleFileParser.parse(fileData)
                allSamples.append(contentsOf: samples)
            } catch {
                NSLog("[WatchMotion] Failed to parse pending file %@: %@", fileURL.lastPathComponent, error.localizedDescription)
                // Skip this file and continue processing others.
                // The file will be deleted when acknowledgeWatchSamples() runs,
                // preventing it from blocking future syncs.
            }
        }

        return allSamples
    }

    private func deletePendingFiles() {
        let fileManager = FileManager.default
        guard let contents = try? fileManager.contentsOfDirectory(
            at: pendingDirectory,
            includingPropertiesForKeys: nil
        ) else { return }

        for fileURL in contents {
            try? fileManager.removeItem(at: fileURL)
        }
    }
}

// MARK: - WCSession Delegate (singleton holder to avoid retain cycles)

private class WatchSessionDelegateHolder: NSObject, WCSessionDelegate {
    static let shared = WatchSessionDelegateHolder()
    weak var module: WatchMotionModule?

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        // Activation complete — no action needed
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate for multi-watch support
        session.activate()
    }

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        module?.handleReceivedFile(fileURL: file.fileURL, metadata: file.metadata as? [String: Any])
    }
}
