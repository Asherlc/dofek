#if canImport(Sentry)
import Sentry
#endif
import Foundation
import WatchConnectivity

/// Coordinates querying accelerometer, gyroscope, and altimeter samples and sending them
/// to the paired iPhone via WCSession.transferFile().
/// Files are gzip-compressed JSON arrays.
///
/// All heavy work (sample querying, compression, file I/O) runs on a background
/// queue to avoid blocking the main thread and triggering watchdog kills.
final class TransferManager: ObservableObject {
    private let accelerometerRecorder: AccelerometerRecorder
    private let gyroscopeRecorder: GyroscopeRecorder
    private let altimeterRecorder: AltimeterRecorder
    private let session: WCSession
    private let workQueue = DispatchQueue(label: "com.dofek.watch.transfer", qos: .utility)
    private let transferStateLock = NSLock()
    private let pendingAltitudeLock = NSLock()
    private var pendingAltitudeSampleCounts: [URL: Int] = [:]
    private let accountStateStore = WatchAccountStateStore()

    @Published var isTransferring: Bool = false
    @Published var lastTransferStatus: String = "Idle"
    @Published private var hasFailedAttempt = false

    /// Glance status from live account, session, queue, and transfer flags.
    var phoneTransferStatus: WatchPhoneTransferStatus {
        WatchPhoneTransferStatus.resolve(
            isSyncEnabled: accountStateStore.isSyncEnabled,
            isCompanionAvailable: isCompanionAvailable,
            hasOutstandingFileTransfers: hasOutstandingFileTransfers,
            isTransferring: isTransferring,
            hasFailedAttempt: hasFailedAttempt
        )
    }

    /// Whether Sync Now may start a new request. Uses the concurrent-transfer
    /// guard plus account/session/companion availability — not the WCSession
    /// file queue, which can still hold altitude after `isTransferring` clears.
    var canRequestManualSync: Bool {
        !isTransferring
            && accountStateStore.isSyncEnabled
            && isSessionActivated
            && isCompanionAvailable
    }

    init(
        accelerometerRecorder: AccelerometerRecorder,
        gyroscopeRecorder: GyroscopeRecorder,
        altimeterRecorder: AltimeterRecorder,
        session: WCSession = .default
    ) {
        self.accelerometerRecorder = accelerometerRecorder
        self.gyroscopeRecorder = gyroscopeRecorder
        self.altimeterRecorder = altimeterRecorder
        self.session = session

        WatchSessionDelegate.shared.onFileTransferFinished = { [weak self] fileTransfer, error in
            self?.handleFileTransferFinished(fileTransfer, error: error)
        }
        WatchSessionDelegate.shared.onPurgeRequested = { [weak self] cutoff in
            self?.purgeAccountState(at: cutoff)
        }
        WatchSessionDelegate.shared.onAccountSyncEnabled = { [weak self] in
            self?.enableAccountSync()
        }
    }

    /// Query new samples from both recorders, merge by timestamp, serialize
    /// to gzip JSON, and transfer to the paired iPhone via WCSession.
    ///
    /// Safe to call from any thread. @Published updates are dispatched to main.
    /// Heavy work (sample iteration, compression) runs on a background queue.
    func transferNewSamples() {
        // Bounce to main thread for @Published property checks
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in
                self?.transferNewSamples()
            }
            return
        }

        guard !isTransferring else { return }
        guard accountStateStore.isSyncEnabled else {
            lastTransferStatus = "Account sync disabled"
            return
        }
        guard isSessionActivated else {
            lastTransferStatus = "Session not active"
            return
        }
        guard isCompanionAvailable else {
            lastTransferStatus = "iPhone not available"
            return
        }

        hasFailedAttempt = false
        isTransferring = true
        lastTransferStatus = "Querying samples..."

        workQueue.async { [weak self] in
            self?.performTransfer()
        }
    }

    private var isSessionActivated: Bool {
        session.activationState == .activated
    }

    private var isCompanionAvailable: Bool {
        guard isSessionActivated else { return false }
        return session.isReachable || session.isCompanionAppInstalled
    }

    private var hasOutstandingFileTransfers: Bool {
        guard isSessionActivated else { return false }
        return !session.outstandingFileTransfers.isEmpty
    }

    private func performTransfer() {
        guard accountStateStore.isSyncEnabled else {
            DispatchQueue.main.async { [weak self] in
                self?.isTransferring = false
            }
            return
        }
        // Stream samples to a temp JSON file (memory-efficient)
        guard let result = accelerometerRecorder.streamSamplesToFile() else {
            let altitudeSamples = altimeterRecorder.copyBufferedSamples()
            transferAltimeterSamples()
            DispatchQueue.main.async { [weak self] in
                self?.isTransferring = false
                if altitudeSamples.isEmpty {
                    self?.lastTransferStatus = "No new samples"
                }
            }
            return
        }

        let gyroSamples = gyroscopeRecorder.copyBufferedSamples()
        processTransfer(result: result, gyroSamples: gyroSamples)
    }

    private func processTransfer(
        result: (url: URL, count: Int, through: Date),
        gyroSamples: [[String: Any]]
    ) {
        var tempFilesToCleanup: [URL] = [result.url]
        var mergedURL: URL?

        DispatchQueue.main.async { [weak self] in
            self?.accelerometerRecorder.samplesSinceLastTransfer = result.count
            self?.lastTransferStatus = "Compressing \(result.count) samples..."
        }

        do {
            let fileToCompress: URL
            if !gyroSamples.isEmpty {
                mergedURL = FileManager.default.temporaryDirectory
                    .appendingPathComponent("imu-merged-\(ISO8601DateFormatter().string(from: Date())).json")
                try mergeGyroscopeIntoFile(
                    accelFileURL: result.url,
                    gyroSamples: gyroSamples,
                    outputURL: mergedURL!
                )
                try? FileManager.default.removeItem(at: result.url)
                fileToCompress = mergedURL!
            } else {
                fileToCompress = result.url
            }

            let compressedURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("imu-\(ISO8601DateFormatter().string(from: Date())).json.gz")
            let compressedSize = try Self.compressFile(from: fileToCompress, to: compressedURL)
            tempFilesToCleanup.append(compressedURL)

            try? FileManager.default.removeItem(at: fileToCompress)

            var metadata = accelerometerRecorder.transferMetadata(through: result.through)
            metadata["type"] = "accelerometer_samples"
            metadata["sampleCount"] = result.count
            metadata["hasGyroscope"] = !gyroSamples.isEmpty
            metadata["gyroscopeSampleCount"] = gyroSamples.count
            metadata["transferredAt"] = ISO8601DateFormatter().string(from: Date())

            guard queueTransferIfSyncEnabled(compressedURL, metadata: metadata) else {
                for url in tempFilesToCleanup {
                    try? FileManager.default.removeItem(at: url)
                }
                DispatchQueue.main.async { [weak self] in
                    self?.isTransferring = false
                    self?.lastTransferStatus = "Account sync disabled"
                }
                return
            }

            DispatchQueue.main.async { [weak self] in
                self?.lastTransferStatus =
                    "Queued \(result.count) samples (\(compressedSize / 1024) KB)"
            }
            transferAltimeterSamples()
        } catch {
            handleTransferFailure(
                tempFilesToCleanup: tempFilesToCleanup,
                mergedURL: mergedURL,
                error: error
            )
        }
    }

    private func handleTransferFailure(
        tempFilesToCleanup: [URL],
        mergedURL: URL?,
        error: Error
    ) {
        reportUnexpectedTransferFailure(error)

        for url in tempFilesToCleanup {
            try? FileManager.default.removeItem(at: url)
        }
        if let mergedURL {
            try? FileManager.default.removeItem(at: mergedURL)
        }

        DispatchQueue.main.async { [weak self] in
            self?.hasFailedAttempt = true
            self?.lastTransferStatus = "Error: \(error.localizedDescription)"
            self?.isTransferring = false
        }
    }

    private func transferAltimeterSamples() {
        guard accountStateStore.isSyncEnabled else { return }
        let altitudeSamples = altimeterRecorder.copyBufferedSamples()
        guard !altitudeSamples.isEmpty else { return }

        var jsonURL: URL?
        var compressedURL: URL?

        do {
            jsonURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("altitude-\(ISO8601DateFormatter().string(from: Date())).json")
            let jsonData = try JSONSerialization.data(withJSONObject: altitudeSamples)
            try jsonData.write(to: jsonURL!)

            compressedURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("altitude-\(ISO8601DateFormatter().string(from: Date())).json.gz")
            _ = try Self.compressFile(from: jsonURL!, to: compressedURL!)
            try? FileManager.default.removeItem(at: jsonURL!)
            jsonURL = nil

            let metadata: [String: Any] = [
                "type": "altitude_samples",
                "sampleCount": altitudeSamples.count,
                "transferredAt": ISO8601DateFormatter().string(from: Date()),
            ]
            guard queueAltitudeTransferIfSyncEnabled(
                compressedURL!,
                metadata: metadata,
                sampleCount: altitudeSamples.count
            ) else {
                if let compressedURL {
                    try? FileManager.default.removeItem(at: compressedURL)
                }
                return
            }
            // Queue changed with no other @Published write on this path.
            DispatchQueue.main.async { [weak self] in
                self?.objectWillChange.send()
            }
        } catch {
            if let jsonURL {
                try? FileManager.default.removeItem(at: jsonURL)
            }
            if let compressedURL {
                try? FileManager.default.removeItem(at: compressedURL)
            }
            DispatchQueue.main.async { [weak self] in
                self?.hasFailedAttempt = true
                self?.lastTransferStatus = "Altitude transfer error: \(error.localizedDescription)"
            }
        }
    }

    private func handleFileTransferFinished(_ fileTransfer: WCSessionFileTransfer, error: Error?) {
        let transferType = fileTransfer.file.metadata?["type"] as? String
        if transferType == "accelerometer_samples" {
            handleAccelerometerTransferFinished(fileTransfer, error: error)
            return
        }
        guard transferType == "altitude_samples" else { return }

        let transferredURL = fileTransfer.file.fileURL
        pendingAltitudeLock.lock()
        let sampleCount = pendingAltitudeSampleCounts.removeValue(forKey: transferredURL)
        pendingAltitudeLock.unlock()

        if let error = error {
            DispatchQueue.main.async { [weak self] in
                self?.hasFailedAttempt = true
                self?.lastTransferStatus = "Altitude transfer error: \(error.localizedDescription)"
            }
            return
        }

        guard let sampleCount else {
            // Queue drained without an in-memory count or other @Published write.
            DispatchQueue.main.async { [weak self] in
                self?.objectWillChange.send()
            }
            return
        }

        altimeterRecorder.clearBufferedSamples(count: sampleCount)

        DispatchQueue.main.async { [weak self] in
            self?.lastTransferStatus = "Sent \(sampleCount) altitude samples"
        }
    }

    private func handleAccelerometerTransferFinished(
        _ fileTransfer: WCSessionFileTransfer,
        error: Error?
    ) {
        let metadata = fileTransfer.file.metadata
        let sampleCount = metadata?["sampleCount"] as? Int ?? 0
        let gyroscopeSampleCount = metadata?["gyroscopeSampleCount"] as? Int ?? 0

        switch accelerometerRecorder.completeTransfer(metadata: metadata, error: error) {
        case .confirmed:
            DispatchQueue.main.async { [weak self] in
                self?.gyroscopeRecorder.confirmTransferredSamples(count: gyroscopeSampleCount)
                self?.accelerometerRecorder.markTransferComplete()
                self?.lastTransferStatus = "Sent \(sampleCount) samples"
                self?.isTransferring = false
            }
        case let .failed(transferError):
            reportUnexpectedTransferFailure(transferError)
            DispatchQueue.main.async { [weak self] in
                self?.hasFailedAttempt = true
                self?.lastTransferStatus =
                    "Transfer error: \(transferError.localizedDescription)"
                self?.isTransferring = false
            }
        case .invalidMetadata:
            let metadataError = NSError(
                domain: "com.dofek.watch.transfer",
                code: 1,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Accelerometer transfer completed without a valid cursor boundary",
                ]
            )
            reportUnexpectedTransferFailure(metadataError)
            DispatchQueue.main.async { [weak self] in
                self?.hasFailedAttempt = true
                self?.lastTransferStatus = "Transfer error: Missing accelerometer cursor"
                self?.isTransferring = false
            }
        }
    }

    private func reportUnexpectedTransferFailure(_ error: Error) {
        NSLog("[DofekWatch] Transfer failed: %@", error.localizedDescription)
        #if canImport(Sentry)
        SentrySDK.capture(error: error)
        #endif
    }

    private func purgeAccountState(at cutoff: Date) {
        transferStateLock.lock()
        defer { transferStateLock.unlock() }
        accountStateStore.purge(at: cutoff)
        gyroscopeRecorder.purgeAccountState()
        altimeterRecorder.purgeAccountState()
        accelerometerRecorder.purgeAccountState()

        for transfer in session.outstandingFileTransfers {
            let fileURL = transfer.file.fileURL
            transfer.cancel()
            do {
                if FileManager.default.fileExists(atPath: fileURL.path) {
                    try FileManager.default.removeItem(at: fileURL)
                }
            } catch {
                reportUnexpectedTransferFailure(error)
            }
        }

        pendingAltitudeLock.lock()
        pendingAltitudeSampleCounts.removeAll()
        pendingAltitudeLock.unlock()

        DispatchQueue.main.async { [weak self] in
            self?.hasFailedAttempt = false
            self?.isTransferring = false
            self?.lastTransferStatus = "Account data cleared"
        }
    }

    private func queueTransferIfSyncEnabled(_ url: URL, metadata: [String: Any]) -> Bool {
        transferStateLock.lock()
        defer { transferStateLock.unlock() }
        guard accountStateStore.isSyncEnabled else { return false }
        session.transferFile(url, metadata: metadata)
        return true
    }

    private func enableAccountSync() {
        let didEnable: Bool
        transferStateLock.lock()
        didEnable = !accountStateStore.isSyncEnabled
        if didEnable {
            accountStateStore.enableSync()
        }
        transferStateLock.unlock()

        guard didEnable else { return }
        DispatchQueue.main.async { [weak self] in
            self?.hasFailedAttempt = false
        }
    }

    private func queueAltitudeTransferIfSyncEnabled(
        _ url: URL,
        metadata: [String: Any],
        sampleCount: Int
    ) -> Bool {
        transferStateLock.lock()
        defer { transferStateLock.unlock() }
        guard accountStateStore.isSyncEnabled else { return false }
        session.transferFile(url, metadata: metadata)
        pendingAltitudeLock.lock()
        pendingAltitudeSampleCounts[url] = sampleCount
        pendingAltitudeLock.unlock()
        return true
    }
}
