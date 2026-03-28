import Compression
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

                // Decompress zlib. The Watch app compresses with NSData.compressed(using: .zlib)
                // which produces zlib-format data (magic byte 0x78), not gzip (0x1f 0x8b).
                let decompressedData: Data
                if let firstByte = fileData.first, firstByte == 0x78 {
                    // Zlib magic byte — decompress
                    decompressedData = try (fileData as NSData).decompressed(using: .zlib) as Data
                } else if fileData.starts(with: [0x1f, 0x8b]) {
                    // Gzip: strip the header to get raw DEFLATE, then decompress.
                    // NSData.decompressed(using: .zlib) only handles zlib format, not gzip.
                    decompressedData = try Self.decompressGzip(fileData)
                } else {
                    // Already uncompressed (plain JSON)
                    decompressedData = fileData
                }

                // Parse JSON array of samples
                guard let jsonArray = try JSONSerialization.jsonObject(with: decompressedData) as? [[String: Any]] else {
                    NSLog("[WatchMotion] Skipping file %@ — JSON is not an array", fileURL.lastPathComponent)
                    continue
                }
                allSamples.append(contentsOf: jsonArray)
            } catch {
                NSLog("[WatchMotion] Failed to parse pending file %@: %@", fileURL.lastPathComponent, error.localizedDescription)
                // Skip this file and continue processing others.
                // The file will be deleted when acknowledgeWatchSamples() runs,
                // preventing it from blocking future syncs.
            }
        }

        return allSamples
    }

    /// Decompress gzip data by stripping the gzip header and decompressing
    /// the raw DEFLATE payload using the Compression framework.
    private static func decompressGzip(_ data: Data) throws -> Data {
        guard data.count >= 10, data[0] == 0x1f, data[1] == 0x8b else {
            throw NSError(domain: "WatchMotion", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Invalid gzip header",
            ])
        }

        var offset = 10  // Minimum gzip header size
        let flags = data[3]

        // FEXTRA — skip extra field
        if flags & 0x04 != 0 {
            guard data.count > offset + 2 else {
                throw NSError(domain: "WatchMotion", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "Truncated gzip FEXTRA",
                ])
            }
            let extraLength = Int(data[offset]) | (Int(data[offset + 1]) << 8)
            offset += 2 + extraLength
        }
        // FNAME — skip null-terminated name
        if flags & 0x08 != 0 {
            while offset < data.count && data[offset] != 0 { offset += 1 }
            offset += 1
        }
        // FCOMMENT — skip null-terminated comment
        if flags & 0x10 != 0 {
            while offset < data.count && data[offset] != 0 { offset += 1 }
            offset += 1
        }
        // FHCRC — skip header CRC16
        if flags & 0x02 != 0 { offset += 2 }

        guard data.count > offset + 8 else {
            throw NSError(domain: "WatchMotion", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Truncated gzip data",
            ])
        }

        // Strip gzip header and 8-byte trailer (CRC32 + uncompressed size)
        let deflatePayload = data.subdata(in: offset ..< (data.count - 8))

        // Read the original uncompressed size from the last 4 bytes (little-endian)
        let uncompressedSize = Int(data[data.count - 4])
            | (Int(data[data.count - 3]) << 8)
            | (Int(data[data.count - 2]) << 16)
            | (Int(data[data.count - 1]) << 24)

        // Allocate output buffer (use uncompressed size hint, with a safety cap)
        let bufferSize = min(max(uncompressedSize, deflatePayload.count * 4), 50 * 1024 * 1024)
        let destinationBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { destinationBuffer.deallocate() }

        let decodedSize = deflatePayload.withUnsafeBytes { sourcePointer -> Int in
            guard let baseAddress = sourcePointer.baseAddress else { return 0 }
            return compression_decode_buffer(
                destinationBuffer, bufferSize,
                baseAddress.assumingMemoryBound(to: UInt8.self), deflatePayload.count,
                nil,
                COMPRESSION_ZLIB
            )
        }

        guard decodedSize > 0 else {
            throw NSError(domain: "WatchMotion", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "Gzip decompression failed (decoded 0 bytes)",
            ])
        }

        return Data(bytes: destinationBuffer, count: decodedSize)
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
