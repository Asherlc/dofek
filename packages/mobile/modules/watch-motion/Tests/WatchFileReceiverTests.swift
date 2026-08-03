import Foundation
import XCTest
@testable import WatchMotionLib

final class WatchFileReceiverTests: XCTestCase {
    private var temporaryDirectories: [URL] = []

    override func tearDown() {
        for directory in temporaryDirectories {
            try? FileManager.default.removeItem(at: directory)
        }
        temporaryDirectories = []
        super.tearDown()
    }

    func testPersistsFileReceivedBeforeModuleAttachment() throws {
        let rootDirectory = try makeTemporaryDirectory()
        let sourceURL = rootDirectory.appendingPathComponent("received.json.gz")
        let pendingDirectory = rootDirectory.appendingPathComponent("pending", isDirectory: true)
        let fixtureData = Data("watch samples".utf8)
        try fixtureData.write(to: sourceURL)

        let inbox = WatchFileInbox(pendingDirectory: pendingDirectory)
        let receiver = WatchFileReceiver(inbox: inbox) { error in
            XCTFail("Unexpected persistence error: \(error)")
        }

        receiver.receive(
            fileURL: sourceURL,
            metadata: ["type": "accelerometer_samples", "sampleCount": 1]
        )

        let moduleObserver = ModuleObserverSpy()
        receiver.observer = moduleObserver

        let pendingFileNames = try inbox.listPendingFileNames()
        XCTAssertEqual(pendingFileNames.count, 1)
        let pendingFileName = try XCTUnwrap(pendingFileNames.first)
        XCTAssertTrue(pendingFileName.hasPrefix("watch-accel-"))
        XCTAssertTrue(pendingFileName.hasSuffix(".json.gz"))
        XCTAssertEqual(
            try Data(contentsOf: pendingDirectory.appendingPathComponent(pendingFileName)),
            fixtureData
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: sourceURL.path))
        XCTAssertTrue(moduleObserver.receivedFileNames.isEmpty)
    }

    func testReportsPersistenceFailureAndRetainsReceivedFile() throws {
        let rootDirectory = try makeTemporaryDirectory()
        let sourceURL = rootDirectory.appendingPathComponent("received.json.gz")
        let invalidPendingDirectory = rootDirectory.appendingPathComponent("pending")
        try Data("watch samples".utf8).write(to: sourceURL)
        try Data("not a directory".utf8).write(to: invalidPendingDirectory)

        var reportedErrors: [Error] = []
        let inbox = WatchFileInbox(pendingDirectory: invalidPendingDirectory)
        let receiver = WatchFileReceiver(inbox: inbox) { error in
            reportedErrors.append(error)
        }

        receiver.receive(
            fileURL: sourceURL,
            metadata: ["type": "altitude_samples", "sampleCount": 1]
        )

        XCTAssertEqual(reportedErrors.count, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: sourceURL.path))
        XCTAssertEqual(try Data(contentsOf: sourceURL), Data("watch samples".utf8))
    }

    func testCopiesAndRetainsSourceWhenMoveFails() throws {
        let rootDirectory = try makeTemporaryDirectory()
        let sourceURL = rootDirectory.appendingPathComponent("received.json.gz")
        let pendingDirectory = rootDirectory.appendingPathComponent("pending", isDirectory: true)
        let fixtureData = Data("watch samples".utf8)
        try fixtureData.write(to: sourceURL)

        var reportedErrors: [Error] = []
        let inbox = WatchFileInbox(
            pendingDirectory: pendingDirectory,
            fileManager: ControlledFileManager(copyFails: false)
        )
        let receiver = WatchFileReceiver(inbox: inbox) { error in
            reportedErrors.append(error)
        }

        receiver.receive(fileURL: sourceURL, metadata: ["type": "altitude_samples"])

        XCTAssertTrue(reportedErrors.isEmpty)
        XCTAssertEqual(try Data(contentsOf: sourceURL), fixtureData)
        let pendingFileName = try XCTUnwrap(inbox.listPendingFileNames().first)
        XCTAssertTrue(pendingFileName.hasPrefix("watch-altitude-"))
        XCTAssertEqual(
            try Data(contentsOf: pendingDirectory.appendingPathComponent(pendingFileName)),
            fixtureData
        )
    }

    func testReportsMoveAndCopyFailuresAndRetainsSource() throws {
        let rootDirectory = try makeTemporaryDirectory()
        let sourceURL = rootDirectory.appendingPathComponent("received.json.gz")
        let pendingDirectory = rootDirectory.appendingPathComponent("pending", isDirectory: true)
        try Data("watch samples".utf8).write(to: sourceURL)

        var reportedErrors: [Error] = []
        let inbox = WatchFileInbox(
            pendingDirectory: pendingDirectory,
            fileManager: ControlledFileManager(copyFails: true)
        )
        let receiver = WatchFileReceiver(inbox: inbox) { error in
            reportedErrors.append(error)
        }

        receiver.receive(fileURL: sourceURL, metadata: nil)

        let reportedError = try XCTUnwrap(reportedErrors.first)
        XCTAssertEqual(reportedErrors.count, 1)
        XCTAssertTrue(reportedError.localizedDescription.contains("forced move failure"))
        XCTAssertTrue(reportedError.localizedDescription.contains("forced copy failure"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: sourceURL.path))
        XCTAssertTrue(try inbox.listPendingFileNames().isEmpty)
    }

    func testNotifiesAttachedModuleAfterPersistenceCompletes() throws {
        let rootDirectory = try makeTemporaryDirectory()
        let sourceURL = rootDirectory.appendingPathComponent("received.json.gz")
        let pendingDirectory = rootDirectory.appendingPathComponent("pending", isDirectory: true)
        let fixtureData = Data("watch samples".utf8)
        try fixtureData.write(to: sourceURL)

        let inbox = WatchFileInbox(pendingDirectory: pendingDirectory)
        let receiver = WatchFileReceiver(inbox: inbox) { error in
            XCTFail("Unexpected persistence error: \(error)")
        }
        let moduleObserver = ModuleObserverSpy { fileName, metadata in
            XCTAssertEqual(
                try Data(contentsOf: pendingDirectory.appendingPathComponent(fileName)),
                fixtureData
            )
            XCTAssertEqual(metadata?["sampleCount"] as? Int, 1)
        }
        receiver.observer = moduleObserver

        receiver.receive(fileURL: sourceURL, metadata: ["sampleCount": 1])

        XCTAssertEqual(moduleObserver.receivedFileNames.count, 1)
    }

    func testDropsLateTransferWhileAccountSyncIsDisabled() throws {
        let rootDirectory = try makeTemporaryDirectory()
        let sourceURL = rootDirectory.appendingPathComponent("received.json.gz")
        let pendingDirectory = rootDirectory.appendingPathComponent("pending", isDirectory: true)
        try Data("old account samples".utf8).write(to: sourceURL)
        let inbox = WatchFileInbox(pendingDirectory: pendingDirectory)
        let receiver = WatchFileReceiver(
            inbox: inbox,
            shouldAcceptFile: { false },
            reportError: { error in
                XCTFail("Unexpected discard error: \(error)")
            }
        )

        receiver.receive(fileURL: sourceURL, metadata: nil)

        XCTAssertFalse(FileManager.default.fileExists(atPath: sourceURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: pendingDirectory.path))
    }

    func testPurgePendingFilesRemovesOnlyInboxContents() throws {
        let rootDirectory = try makeTemporaryDirectory()
        let pendingDirectory = rootDirectory.appendingPathComponent("pending", isDirectory: true)
        let unrelatedURL = rootDirectory.appendingPathComponent("keep.txt")
        try FileManager.default.createDirectory(
            at: pendingDirectory,
            withIntermediateDirectories: true
        )
        try Data("pending".utf8).write(
            to: pendingDirectory.appendingPathComponent("watch-accel.json.gz")
        )
        try Data("keep".utf8).write(to: unrelatedURL)
        let inbox = WatchFileInbox(pendingDirectory: pendingDirectory)

        try inbox.purgePendingFiles()

        XCTAssertTrue(try inbox.listPendingFileNames().isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelatedURL.path))
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("WatchFileReceiverTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        temporaryDirectories.append(directory)
        return directory
    }
}

private final class ModuleObserverSpy: WatchFileReceiverObserver {
    var receivedFileNames: [String] = []
    private let onReceive: (String, [String: Any]?) throws -> Void

    init(onReceive: @escaping (String, [String: Any]?) throws -> Void = { _, _ in }) {
        self.onReceive = onReceive
    }

    func watchFileReceiver(
        didPersist fileName: String,
        metadata: [String: Any]?
    ) {
        receivedFileNames.append(fileName)
        XCTAssertNoThrow(try onReceive(fileName, metadata))
    }
}

private final class ControlledFileManager: FileManager, @unchecked Sendable {
    private let copyFails: Bool

    init(copyFails: Bool) {
        self.copyFails = copyFails
        super.init()
    }

    override func moveItem(at sourceURL: URL, to destinationURL: URL) throws {
        throw ControlledFileManagerError.move
    }

    override func copyItem(at sourceURL: URL, to destinationURL: URL) throws {
        if copyFails {
            throw ControlledFileManagerError.copy
        }
        try super.copyItem(at: sourceURL, to: destinationURL)
    }
}

private enum ControlledFileManagerError: LocalizedError {
    case move
    case copy

    var errorDescription: String? {
        switch self {
        case .move:
            "forced move failure"
        case .copy:
            "forced copy failure"
        }
    }
}
