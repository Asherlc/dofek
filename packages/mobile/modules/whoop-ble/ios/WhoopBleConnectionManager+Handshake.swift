import CoreBluetooth
import Foundation

extension WhoopBleConnectionManager {
    /// Bound explicit callers and connected setup; passive Bluetooth requests stay pending.
    func startHandshakeTimeout(cancelPeripheral: @escaping () -> Void) {
        handshakeTimeoutWorkItem?.cancel()
        handshakeTimeoutWorkItem = nil
        guard state != .connecting || connectCompletion != nil else { return }
        let timeoutWorkItem = DispatchWorkItem { [weak self] in
            guard
                let self,
                self.state == .connecting
                    || self.state == .discoveringServices
                    || self.state == .subscribing
            else { return }
            self.abortHandshake(with: .timeout, cancelPeripheral: cancelPeripheral)
        }
        handshakeTimeoutWorkItem = timeoutWorkItem
        bleQueue.asyncAfter(
            deadline: .now() + connectTimeoutSeconds,
            execute: timeoutWorkItem
        )
    }

    func startHandshakeTimeout(for peripheral: any WhoopBlePeripheralConnection) {
        startHandshakeTimeout {
            peripheral.cancelConnection()
        }
    }

    /// Settle the JavaScript connect completion at most once.
    func finishConnect(_ result: Result<Bool, WhoopBleConnectionError>) {
        handshakeTimeoutWorkItem?.cancel()
        handshakeTimeoutWorkItem = nil
        let completion = connectCompletion
        connectCompletion = nil
        completion?(result)
    }

    /// Cancel and clean up a connection that failed before becoming ready.
    func abortHandshake(
        with error: WhoopBleConnectionError,
        underlyingError: Error? = nil,
        cancelPeripheral: () -> Void
    ) {
        guard
            state == .connecting
                || state == .discoveringServices
                || state == .subscribing
        else { return }
        recordConnectionEvent("handshake_aborted", error: underlyingError, reason: error.rejection.code)
        if autoReconnect && connectCompletion == nil && error.isTransientSetupFailure {
            // Keep the peripheral until CoreBluetooth confirms cancellation. Its
            // disconnect callback owns cleanup and the next pending connection.
            finishConnect(.failure(error))
            setState(.disconnecting)
            cancelPeripheral()
            return
        }
        autoReconnect = false
        cancelPeripheral()
        cleanup()
        finishConnect(.failure(error))
    }

    /// Ignore a late callback from a peripheral that no longer owns the attempt.
    func abortHandshake(
        for peripheral: any WhoopBlePeripheralConnection,
        with error: WhoopBleConnectionError,
        underlyingError: Error? = nil
    ) {
        guard connectedPeripheral?.identifier == peripheral.identifier else { return }
        abortHandshake(with: error, underlyingError: underlyingError) {
            peripheral.cancelConnection()
        }
    }
}
