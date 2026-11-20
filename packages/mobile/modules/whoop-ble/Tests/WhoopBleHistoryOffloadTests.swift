import XCTest
@testable import WhoopBLE

final class WhoopBleHistoryOffloadTests: XCTestCase {
    private struct CaptureEntry {
        let number: Int
        let handle: Substring
        let frame: WhoopFrame
    }

    private final class Commands {
        var sequence: UInt8
        var bodies: [Data] = []

        init(sequence: UInt8 = 0xF7) { self.sequence = sequence }

        func send(_ command: UInt8, _ arguments: Data) -> UInt8? {
            bodies.append(Data([sequence, command]) + arguments)
            defer { sequence &+= 1 }
            return sequence
        }
    }

    private func capture(_ range: ClosedRange<Int> = 347...607) throws -> [CaptureEntry] {
        let url = try XCTUnwrap(Bundle.module.url(
            forResource: "imu-activation-capture", withExtension: "tsv", subdirectory: "fixtures"
        ))
        let responses = WhoopBleFrameParser()
        let stream = WhoopBleFrameParser()
        return try String(contentsOf: url, encoding: .utf8).split(separator: "\n").flatMap { line -> [CaptureEntry] in
            let columns = line.split(separator: "\t")
            guard columns.count == 5, let number = Int(columns[0]), range.contains(number),
                  let bytes = Data(hexString: String(columns[4])) else { return [] }
            let frames: [WhoopFrame]
            switch columns[2] {
            case "0x099b": frames = [try XCTUnwrap(WhoopBleFrameParser.parseFrame(bytes))]
            case "0x099d": frames = responses.feed(bytes)
            case "0x09a3": frames = stream.feed(bytes)
            default: return []
            }
            return frames.map { CaptureEntry(number: number, handle: columns[2], frame: $0) }
        }
    }

    private func replay(
        _ entries: [CaptureEntry],
        into offload: inout WhoopBleHistoryOffload,
        commands: Commands,
        retainHistory: Bool = true
    ) {
        for entry in entries {
            switch entry.handle {
            case "0x099d": offload.receiveCommandResponse(entry.frame, send: commands.send)
            case "0x09a3":
                offload.receiveCommittedFrame(
                    entry.frame, historicalRecordRetained: retainHistory, send: commands.send
                )
            default: break
            }
        }
    }

    func testReplaysEveryAcknowledgmentInTheOfficialCapture() throws {
        let entries = try capture()
        var offload = WhoopBleHistoryOffload()
        let commands = Commands()

        offload.start(send: commands.send)
        replay(entries.filter { $0.number <= 349 }, into: &offload, commands: commands)
        XCTAssertEqual(commands.bodies, [Data([0xF7, 0x22, 0])])
        replay(entries.filter { $0.number > 349 }, into: &offload, commands: commands)

        let writes = entries.filter { $0.handle == "0x099b" }
        XCTAssertEqual(writes.count, 7)
        XCTAssertEqual(entries.filter { $0.frame.packetType == 0x2F }.count, 71)
        XCTAssertEqual(commands.bodies, writes.map { $0.frame.payload.dropFirst().dropLast(4) })
        for write in writes {
            let payload = write.frame.payload
            let built = WhoopBleFrameParser.buildCommandData(
                command: payload[2], arguments: payload.dropFirst(3).dropLast(4)
            )
            let parsed = try XCTUnwrap(WhoopBleFrameParser.parseFrame(built))
            XCTAssertEqual(parsed.payload.dropFirst(2).dropLast(4), payload.dropFirst(2).dropLast(4))
        }
    }

    func testPassiveHistorySendsNothingAndVetoesStartingOnThatConnection() throws {
        var offload = WhoopBleHistoryOffload()
        let commands = Commands()
        replay(try capture(), into: &offload, commands: commands)
        offload.start(send: commands.send)
        XCTAssertTrue(commands.bodies.isEmpty)

        offload.reset()
        offload.start(send: commands.send)
        XCTAssertEqual(commands.bodies, [Data([0xF7, 0x22, 0])])
    }

    func testWrongRangeSequenceDoesNotStartTransfer() throws {
        var offload = WhoopBleHistoryOffload()
        let commands = Commands(sequence: 0x31)
        offload.start(send: commands.send)
        replay(try capture(349...350), into: &offload, commands: commands)
        XCTAssertEqual(commands.bodies, [Data([0x31, 0x22, 0])])
    }

    func testFailedRangeClosesTheAttempt() throws {
        var offload = WhoopBleHistoryOffload()
        let commands = Commands()
        offload.start(send: commands.send)
        let response = try XCTUnwrap(try capture(349...349).first?.frame)
        var payload = response.payload
        payload[4] = 0
        let failure = WhoopFrame(packetType: 0x24, recordType: 0, dataTimestamp: 0, subSeconds: 0,
                                 payload: payload, rawData: response.rawData)
        offload.receiveCommandResponse(failure, send: commands.send)

        replay(try capture(350...408), into: &offload, commands: commands)
        XCTAssertEqual(commands.bodies, [Data([0xF7, 0x22, 0])])
    }

    func testMissingOrUnretainedHistoryNeverAcknowledges() throws {
        let firstChunk = try capture(347...408)
        let lostRecord = try XCTUnwrap(firstChunk.first { $0.frame.packetType == 0x2F })
        for retainHistory in [true, false] {
            var offload = WhoopBleHistoryOffload()
            let commands = Commands()
            let entries = retainHistory ? firstChunk.filter { $0.number != lostRecord.number } : firstChunk

            offload.start(send: commands.send)
            replay(entries, into: &offload, commands: commands, retainHistory: retainHistory)
            XCTAssertEqual(commands.bodies.count, 2)
        }
    }

    func testDuplicatedOrWrongFormatRecordNeverAcknowledgesEvenWithMatchingCount() throws {
        let chunk = try capture(347...408)
        let records = chunk.filter { $0.frame.packetType == 0x2F }
        XCTAssertEqual(records.count, 2)
        let first = try XCTUnwrap(records.first)
        let second = try XCTUnwrap(records.last)
        var wrongFormat = second.frame.rawData
        wrongFormat[1] = 2
        let crc = WhoopBleFrameParser.crc16modbus(wrongFormat.prefix(6))
        wrongFormat[6] = UInt8(truncatingIfNeeded: crc)
        wrongFormat[7] = UInt8(crc >> 8)
        let parsedWrongFormat = try XCTUnwrap(WhoopBleFrameParser.parseFrame(wrongFormat))
        for invalidRecord in [first.frame, parsedWrongFormat] {
            let entries = chunk.map { entry in
                entry.number == second.number
                    ? CaptureEntry(number: entry.number, handle: entry.handle, frame: invalidRecord)
                    : entry
            }
            var offload = WhoopBleHistoryOffload()
            let commands = Commands()
            offload.start(send: commands.send)
            replay(entries, into: &offload, commands: commands)
            XCTAssertEqual(commands.bodies.map { $0[1] }, [0x22, 0x16])
        }
    }

    func testCancellationPreventsLateEndAndDuplicateEndCannotRetrim() throws {
        let beforeEnd = try capture(347...407)
        let end = try capture(408...408)
        var offload = WhoopBleHistoryOffload()
        let commands = Commands()

        offload.start(send: commands.send)
        replay(beforeEnd, into: &offload, commands: commands)
        offload.stop()
        replay(end, into: &offload, commands: commands)
        XCTAssertEqual(commands.bodies.count, 2)

        offload.reset()
        let restartedCommands = Commands()
        offload.start(send: restartedCommands.send)
        replay(beforeEnd + end + end, into: &offload, commands: restartedCommands)
        XCTAssertEqual(restartedCommands.bodies.map { $0[1] }, [0x22, 0x16, 0x17])
    }

    func testEmptyHistoryNeverSendsTrimAcknowledgment() throws {
        var offload = WhoopBleHistoryOffload()
        let commands = Commands(sequence: 0xFE)
        offload.start(send: commands.send)
        replay(try capture(608...620), into: &offload, commands: commands)
        XCTAssertEqual(commands.bodies.map { $0[1] }, [0x22, 0x16])
    }
}
