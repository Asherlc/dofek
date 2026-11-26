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
        // Snapshot before cleanup so the rejected strap is not replaced by a prior
        // successful lastKnown identity when the module publishes device state.
        let rejectedUnsupported: (id: UUID, name: String?)?
        if case .serviceNotFound = error, let peripheral = connectedPeripheral {
            rejectedUnsupported = (id: peripheral.identifier, name: peripheral.name)
        } else {
            rejectedUnsupported = nil
        }
        autoReconnect = false
        cancelPeripheral()
        cleanup()
        // Publish after cleanup so device-state listeners see idle with no selected
        // peripheral. Passive NO_SERVICE paths have no connect promise to correct a
        // stale discoveringServices summary.
        if let rejectedUnsupported {
            retainRejectedUnsupportedPeripheral(
                id: rejectedUnsupported.id,
                name: rejectedUnsupported.name
            )
        }
        finishConnect(.failure(error))
    }

    /// Metadata is optional; a missing DIS attribute must not stop required notifications.
    func handleCharacteristicDiscoveryError(
        serviceUUID: CBUUID,
        error: Error,
        cancelPeripheral: () -> Void
    ) {
        if serviceUUID == WhoopBleConstants.deviceInformationServiceUUID {
            recordConnectionEvent("device_information_discovery_failed", error: error)
            return
        }
        abortHandshake(
            with: .characteristicDiscoveryFailed(error.localizedDescription),
            underlyingError: error,
            cancelPeripheral: cancelPeripheral
        )
    }

    /// Ignore a late callback from a peripheral that no longer owns the attempt.
    func abortHandshake(
        for peripheral: any WhoopBlePeripheralConnection,
        with error: WhoopBleConnectionError,
        underlyingError: Error? = nil
    ) {
        guard connectedPeripheral?.notificationSource === peripheral.notificationSource else { return }
        abortHandshake(with: error, underlyingError: underlyingError) {
            peripheral.cancelConnection()
        }
    }
}
