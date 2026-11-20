import Foundation
import RNSentry

extension WhoopBleModule {
    func setManagedHistoryEnabled(peripheralId: String, enabled: Bool) throws {
        try self.connectionManager.syncOnBleQueue {
            guard !self.captureSuspended, self.lastKnownHistorySupported,
                  self.lastKnownDeviceId == peripheralId,
                  (self.connectionManager.connectedPeripheral?.identifier.uuidString ?? peripheralId) == peripheralId,
                  let identifier = UUID(uuidString: peripheralId) else {
                throw WhoopUploadError(message: "History sync settings require the current supported WHOOP strap")
            }
            if !enabled { self.stopManagedHistory() }
            do {
                try self.uploader.setManagedHistoryEnabled(enabled, for: identifier)
            } catch {
                SentrySDK.capture(error: error)
                throw error
            }
            self.emitDeviceState()
        }
    }

    internal func startManagedHistoryIfEnabled() {
        guard managedHistoryPeripheralId != nil, connectionManager.state == .streaming,
              !frameParser.hasIncompleteFrame, !cmdFrameParser.hasIncompleteFrame else { return }
        historyOffload.start(send: sendHistoryCommand)
    }

    internal func stopManagedHistory() {
        managedHistoryPeripheralId = nil
        historyOffload.stop()
    }

    internal func sendHistoryCommand(_ command: UInt8, _ arguments: Data) -> UInt8? {
        guard !captureSuspended, captureFailure == nil,
              let managedHistoryPeripheralId,
              connectionManager.connectedPeripheral?.identifier == managedHistoryPeripheralId,
              connectionManager.state == .ready || connectionManager.state == .streaming,
              connectionManager.hasCmdCharacteristic else { return nil }
        let data = WhoopBleFrameParser.buildCommandData(command: command, arguments: arguments)
        connectionManager.writeToStrap(data)
        return data[WhoopBleConstants.maverickHeaderSize + 1]
    }
}
