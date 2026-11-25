import Foundation

/// Atomically replaces the purgeable Sleep widget snapshot in an App Group container.
enum SleepWidgetSnapshotWriter {
    static let fileName = "DofekSleepWidget.json"
    static let relativeCachePath = "Library/Caches/\(fileName)"
    static let widgetKind = "DofekSleepWidget"

    enum WriterError: Error, Equatable {
        case writeFailed
    }

    static func appGroupIdentifier(hostBundleIdentifier: String) -> String {
        "group.\(hostBundleIdentifier).sleep-widget"
    }

    static func snapshotURL(containerURL: URL) -> URL {
        containerURL.appendingPathComponent(relativeCachePath, isDirectory: false)
    }

    /// Returns whether the on-disk bytes changed. `nil` removes the snapshot file.
    /// Callers resolve the App Group container and pass it in.
    static func replaceSnapshot(
        _ snapshot: String?,
        containerURL: URL,
        fileManager: FileManager = .default
    ) throws -> Bool {
        let destination = snapshotURL(containerURL: containerURL)
        let cacheDirectory = destination.deletingLastPathComponent()

        guard let snapshot else {
            // Do not probe with fileExists — it can return false for inaccessible paths.
            // Attempt removal and treat only the Cocoa no-such-file error as unchanged.
            do {
                try fileManager.removeItem(at: destination)
                return true
            } catch {
                let nsError = error as NSError
                if nsError.domain == NSCocoaErrorDomain,
                   nsError.code == CocoaError.fileNoSuchFile.rawValue {
                    return false
                }
                throw WriterError.writeFailed
            }
        }

        guard let data = snapshot.data(using: .utf8) else {
            throw WriterError.writeFailed
        }

        if let existing = try? Data(contentsOf: destination), existing == data {
            return false
        }

        do {
            try fileManager.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
            // Atomic + complete protection together on iOS so the first durable bytes are
            // protected. macOS SwiftPM hosts reject completeFileProtection with atomic writes.
            #if os(iOS)
            try data.write(to: destination, options: [.atomic, .completeFileProtection])
            #else
            try data.write(to: destination, options: [.atomic])
            #endif
            return true
        } catch {
            throw WriterError.writeFailed
        }
    }
}
