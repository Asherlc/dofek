import Foundation

protocol WatchFileReceiverObserver: AnyObject {
    func watchFileReceiver(
        didPersist fileName: String,
        metadata: [String: Any]?
    )
}

final class WatchFileInbox {
    static let shared = WatchFileInbox(pendingDirectory: defaultPendingDirectory)

    let pendingDirectory: URL

    private static let defaultPendingDirectory: URL = {
        guard let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            preconditionFailure("Application Support directory is unavailable")
        }
        return appSupport.appendingPathComponent("watch-motion-pending", isDirectory: true)
    }()

    private let fileManager: FileManager
    private let operationLock = NSLock()

    init(pendingDirectory: URL, fileManager: FileManager = .default) {
        self.pendingDirectory = pendingDirectory
        self.fileManager = fileManager
    }

    func persistReceivedFile(at sourceURL: URL, metadata: [String: Any]?) throws -> String {
        operationLock.lock()
        defer { operationLock.unlock() }
        return try persistReceivedFileWithoutLock(at: sourceURL, metadata: metadata)
    }

    func persistReceivedFileIfAccepted(
        at sourceURL: URL,
        metadata: [String: Any]?,
        shouldAccept: () -> Bool
    ) throws -> String? {
        operationLock.lock()
        defer { operationLock.unlock() }
        guard shouldAccept() else {
            try fileManager.removeItem(at: sourceURL)
            return nil
        }
        return try persistReceivedFileWithoutLock(at: sourceURL, metadata: metadata)
    }

    private func persistReceivedFileWithoutLock(
        at sourceURL: URL,
        metadata: [String: Any]?
    ) throws -> String {
        try fileManager.createDirectory(
            at: pendingDirectory,
            withIntermediateDirectories: true
        )

        let fileType = metadata?["type"] as? String ?? "accelerometer_samples"
        let destinationPrefix = fileType == "altitude_samples" ? "watch-altitude-" : "watch-accel-"
        let destinationName = "\(destinationPrefix)\(UUID().uuidString).json.gz"
        let destinationURL = pendingDirectory.appendingPathComponent(destinationName)

        do {
            try fileManager.moveItem(at: sourceURL, to: destinationURL)
        } catch {
            let moveError = error
            do {
                try fileManager.copyItem(at: sourceURL, to: destinationURL)
            } catch {
                throw WatchFilePersistenceError(moveError: moveError, copyError: error)
            }
        }

        return destinationName
    }

    func listPendingFileNames() throws -> [String] {
        try fileManager.contentsOfDirectory(
            at: pendingDirectory,
            includingPropertiesForKeys: nil
        )
        .map(\.lastPathComponent)
        .sorted()
    }

    func purgePendingFiles() throws {
        operationLock.lock()
        defer { operationLock.unlock() }
        guard fileManager.fileExists(atPath: pendingDirectory.path) else {
            return
        }
        for fileURL in try fileManager.contentsOfDirectory(
            at: pendingDirectory,
            includingPropertiesForKeys: nil
        ) {
            try fileManager.removeItem(at: fileURL)
        }
    }
}

final class WatchFileReceiver {
    var observer: WatchFileReceiverObserver? {
        get {
            observerLock.lock()
            defer { observerLock.unlock() }
            return storedObserver
        }
        set {
            observerLock.lock()
            storedObserver = newValue
            observerLock.unlock()
        }
    }

    private let inbox: WatchFileInbox
    private let shouldAcceptFile: () -> Bool
    private let reportError: (Error) -> Void
    private let observerLock = NSLock()
    private weak var storedObserver: WatchFileReceiverObserver?

    init(
        inbox: WatchFileInbox,
        shouldAcceptFile: @escaping () -> Bool = { true },
        reportError: @escaping (Error) -> Void
    ) {
        self.inbox = inbox
        self.shouldAcceptFile = shouldAcceptFile
        self.reportError = reportError
    }

    func receive(fileURL: URL, metadata: [String: Any]?) {
        do {
            guard let fileName = try inbox.persistReceivedFileIfAccepted(
                at: fileURL,
                metadata: metadata,
                shouldAccept: shouldAcceptFile
            ) else {
                return
            }
            let observer = observer
            observer?.watchFileReceiver(didPersist: fileName, metadata: metadata)
        } catch {
            reportError(error)
        }
    }
}

private struct WatchFilePersistenceError: LocalizedError {
    let moveError: Error
    let copyError: Error

    var errorDescription: String? {
        "Failed to move received Watch file (\(moveError.localizedDescription)) " +
            "or copy it (\(copyError.localizedDescription))"
    }
}
