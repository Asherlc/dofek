import Foundation

/// Issues a fresh ownership generation for each Apple Health expiration-listener
/// activation.
///
/// The native module instance is not the lifetime of a listener: signing out and
/// signing back in on the same bridge removes the `onHealthKitSyncExpired`
/// subscription and adds it again without recreating the module. Work queued by
/// the earlier listener must not be admitted by the later one, so ownership is
/// per listener activation rather than per module. Every activation mints a new
/// generation; retiring one generation never retires a replacement.
final class HealthKitSyncListenerLifecycle: @unchecked Sendable {
    private let lock = NSLock()
    private var liveGeneration: UUID?

    /// Starts a new listener generation. Its identifier is unique for the process,
    /// so it can never match an earlier generation queued on the same module.
    func begin() -> UUID {
        lock.lock()
        let generation = UUID()
        liveGeneration = generation
        lock.unlock()
        return generation
    }

    /// Returns the live generation captured by a bridge call. `nil` means no
    /// expiration listener is currently installed.
    func current() -> UUID? {
        lock.lock()
        defer { lock.unlock() }
        return liveGeneration
    }

    /// Retires the live generation, if any. Returns the retired identifier so the
    /// caller can hand exactly that generation to owner-correlated cleanup.
    /// Repeated calls return `nil` and retire nothing.
    func end() -> UUID? {
        lock.lock()
        let retired = liveGeneration
        liveGeneration = nil
        lock.unlock()
        return retired
    }
}
