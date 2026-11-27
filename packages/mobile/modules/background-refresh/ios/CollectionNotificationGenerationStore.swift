import Foundation

enum CollectionNotificationGenerationError: LocalizedError {
    case unreadable(underlying: Error)
    case corrupt
    case unwritable(underlying: Error)
    case missingApplicationSupportDirectory
    case retirementInProgress

    var errorDescription: String? {
        switch self {
        case .unreadable(let underlying):
            return "Collection notification generation is unreadable: \(underlying.localizedDescription)"
        case .corrupt:
            return "Collection notification generation file is corrupt"
        case .unwritable(let underlying):
            return "Collection notification generation could not be written: \(underlying.localizedDescription)"
        case .missingApplicationSupportDirectory:
            return "Application Support directory is unavailable"
        case .retirementInProgress:
            return "Collection notification generation retirement is in progress"
        }
    }
}

/// One opaque generation UUID under Application Support. A missing file is legacy.
final class CollectionNotificationGenerationStore {
    private let resolveFileURL: () throws -> URL
    private let queue: DispatchQueue
    private let fileManager: FileManager

    /// Resolves the default Application Support path lazily on the store queue.
    /// Directory creation happens only inside `write`.
    static func makeDefault(
        queue: DispatchQueue = DispatchQueue(label: "com.dofek.collection-notification-generation-io"),
        fileManager: FileManager = .default
    ) -> CollectionNotificationGenerationStore {
        CollectionNotificationGenerationStore(
            fileURL: {
                // urls(...).first returns the path even when the directory does not exist yet
                // in a fresh sandbox; create the Dofek directory only on write.
                guard let base = fileManager.urls(
                    for: .applicationSupportDirectory,
                    in: .userDomainMask
                ).first else {
                    throw CollectionNotificationGenerationError.missingApplicationSupportDirectory
                }
                return base
                    .appendingPathComponent("Dofek", isDirectory: true)
                    .appendingPathComponent("collection-notification-generation", isDirectory: false)
            },
            queue: queue,
            fileManager: fileManager
        )
    }

    convenience init(
        fileURL: URL,
        queue: DispatchQueue = DispatchQueue(label: "com.dofek.collection-notification-generation-io"),
        fileManager: FileManager = .default
    ) {
        self.init(fileURL: { fileURL }, queue: queue, fileManager: fileManager)
    }

    init(
        fileURL: @escaping () throws -> URL,
        queue: DispatchQueue = DispatchQueue(label: "com.dofek.collection-notification-generation-io"),
        fileManager: FileManager = .default
    ) {
        self.resolveFileURL = fileURL
        self.queue = queue
        self.fileManager = fileManager
    }

    /// Missing file (`NSFileReadNoSuchFileError`) → `.success(nil)`.
    /// Any other I/O or corrupt content → `.failure`.
    func read(completion: @escaping (Result<UUID?, Error>) -> Void) {
        queue.async {
            completion(Result { try self.readSync() })
        }
    }

    func write(_ generation: UUID, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            completion(Result { try self.writeSync(generation) })
        }
    }

    private func readSync() throws -> UUID? {
        let fileURL: URL
        do {
            fileURL = try resolveFileURL()
        } catch {
            throw CollectionNotificationGenerationError.unreadable(underlying: error)
        }
        let data: Data
        do {
            data = try Data(contentsOf: fileURL)
        } catch let error as NSError
            where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
            return nil
        } catch {
            throw CollectionNotificationGenerationError.unreadable(underlying: error)
        }
        guard let string = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            let generation = UUID(uuidString: string)
        else {
            throw CollectionNotificationGenerationError.corrupt
        }
        return generation
    }

    private func writeSync(_ generation: UUID) throws {
        let fileURL: URL
        do {
            fileURL = try resolveFileURL()
        } catch {
            throw CollectionNotificationGenerationError.unwritable(underlying: error)
        }
        let directory = fileURL.deletingLastPathComponent()
        do {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            try Data(generation.uuidString.utf8).write(to: fileURL, options: .atomic)
        } catch {
            throw CollectionNotificationGenerationError.unwritable(underlying: error)
        }
    }
}

enum CollectionNotificationIdentity {
    static let logicalPrefixes = [
        CollectionNotification.whoopDisconnected.identifier,
        CollectionNotification.appClosed.identifier,
    ]

    static func makeRequestIdentifier(logicalPrefix: String, generation: UUID?) -> String {
        let request = UUID().uuidString
        if let generation {
            return "\(logicalPrefix).\(generation.uuidString).\(request)"
        }
        return "\(logicalPrefix).\(request)"
    }

    static func isCollectionAlert(_ identifier: String) -> Bool {
        remainderAfterLogicalPrefix(identifier) != nil
    }

    /// When `current` is nil (missing file), every collection-alert ID is legacy/current.
    /// When set, only `prefix.current.requestUUID` IDs belong; legacy IDs are retired.
    static func belongsToCurrentGeneration(_ identifier: String, current: UUID?) -> Bool {
        guard let remainder = remainderAfterLogicalPrefix(identifier) else { return false }
        guard let current else { return true }
        let parts = remainder.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        return parts.count >= 2
            && parts[0].caseInsensitiveCompare(current.uuidString) == .orderedSame
    }

    static func remainderAfterLogicalPrefix(_ identifier: String) -> String? {
        for prefix in logicalPrefixes where identifier == prefix || identifier.hasPrefix("\(prefix).") {
            if identifier == prefix { return "" }
            return String(identifier.dropFirst(prefix.count + 1))
        }
        return nil
    }
}
