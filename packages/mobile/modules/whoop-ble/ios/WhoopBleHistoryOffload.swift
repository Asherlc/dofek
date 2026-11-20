import Foundation

/// One format-1 history offload on the current BLE link. Feed data frames only
/// after the notification's capture writes have returned successfully.
struct WhoopBleHistoryOffload {
    typealias Send = (UInt8, Data) -> UInt8?

    private enum Phase {
        case idle
        case range(UInt8)
        case request(UInt8)
        case betweenChunks
        case chunk(frameCount: UInt32, lastRecordIndex: UInt32?)
        case acknowledging(UInt8, token: Data)
        case stopped
    }

    private var phase = Phase.idle
    private var lastAcknowledgedToken: Data?

    mutating func reset() {
        phase = .idle
        lastAcknowledgedToken = nil
    }
    mutating func stop() { phase = .stopped }

    mutating func start(send: Send) {
        guard case .idle = phase else { return }
        phase = send(WhoopBleConstants.commandGetDataRange, Data([0])).map(Phase.range) ?? .stopped
    }

    mutating func receiveCommandResponse(_ frame: WhoopFrame, send: Send) {
        guard frame.hasFormatOneHeader, frame.packetType == WhoopBleConstants.packetTypeCommandResponse,
              frame.payload.count >= 9 else { return }
        let command = frame.payload[2]
        let sequence = frame.payload[3]
        let result = frame.payload[4]

        switch (phase, command) {
        case (.range(let expected), WhoopBleConstants.commandGetDataRange) where sequence == expected:
            if result == 2 { return }
            // The complete range response in the iOS capture has revision 1 and a 76-byte payload including CRC.
            guard result == 1, frame.payload.count == 76, frame.payload[5] == 1 else { stop(); return }
            phase = send(WhoopBleConstants.commandSendHistoricalData, Data([0])).map(Phase.request) ?? .stopped
        case (.request(let expected), WhoopBleConstants.commandSendHistoricalData) where sequence == expected:
            if result == 2 { return }
            guard result == 1, frame.payload.count == 12 else { stop(); return }
            phase = .betweenChunks
        case (.acknowledging(let expected, let token), WhoopBleConstants.commandHistoricalDataResult) where sequence == expected:
            if result == 2 { return }
            guard result == 1, frame.payload.count == 12 else { stop(); return }
            lastAcknowledgedToken = token
            phase = .betweenChunks
        case (_, WhoopBleConstants.commandSendHistoricalData), (_, WhoopBleConstants.commandHistoricalDataResult):
            // The response belongs to an offload Dofek didn't start or acknowledge.
            stop()
        default:
            break
        }
    }

    mutating func receiveCommittedFrame(_ frame: WhoopFrame, historicalRecordRetained: Bool, send: Send) {
        switch frame.packetType {
        case WhoopBleConstants.packetTypeMetadata:
            guard frame.hasFormatOneHeader else { stop(); return }
            receiveMetadata(frame.payload, send: send)
        case WhoopBleConstants.packetTypeHistoricalData:
            guard frame.hasFormatOneHeader, historicalRecordRetained,
                  frame.payload.count >= 11, case .chunk(let count, let previousIndex) = phase else {
                stop()
                return
            }
            let index = frame.payload.readUInt32LE(at: 3)
            if let previousIndex {
                let advance = index &- previousIndex
                guard advance > 0, advance <= UInt32.max / 2 else { stop(); return }
            }
            phase = .chunk(frameCount: count + 1, lastRecordIndex: index)
        case WhoopBleConstants.packetTypeHistoricalIMU:
            stop()
        case WhoopBleConstants.packetTypeEvent, WhoopBleConstants.packetTypeConsole:
            // These are also included in the captured HISTORY_END packet count.
            if case .chunk(let count, let previousIndex) = phase {
                guard frame.hasFormatOneHeader else { stop(); return }
                phase = .chunk(frameCount: count + 1, lastRecordIndex: previousIndex)
            }
        default:
            break
        }
    }

    private mutating func receiveMetadata(_ payload: Data, send: Send) {
        guard payload.count >= 7 else { stop(); return }
        switch payload[2] {
        case 1:
            guard payload.count == 44, case .betweenChunks = phase else { stop(); return }
            phase = .chunk(frameCount: 0, lastRecordIndex: nil)
        case 2:
            acknowledgeEnd(payload, send: send)
        case 3:
            stop()
        default:
            stop()
        }
    }

    private mutating func acknowledgeEnd(_ payload: Data, send: Send) {
        // `WhoopFrame.payload` includes four CRC bytes after the actual fields.
        guard payload.count == 28 else { stop(); return }
        let token = payload.subdata(in: 13..<21)
        if token == lastAcknowledgedToken { return }
        switch phase {
        case .acknowledging(_, let previousToken) where token == previousToken:
            return
        case .chunk(let count, _) where count > 0 && count == payload.readUInt32LE(at: 9):
            let cursor = token.readUInt32LE(at: 0)
            // Empty history and special cursor controls never require a normal trim acknowledgment.
            guard ![0xFFFFFFFF, 0xFEFEFEFE, 0xFDFDFDFD].contains(cursor),
                  let sequence = send(WhoopBleConstants.commandHistoricalDataResult, Data([1]) + token) else {
                stop()
                return
            }
            phase = .acknowledging(sequence, token: token)
        default:
            stop()
        }
    }
}
