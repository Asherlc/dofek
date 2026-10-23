import Foundation

final class WatchRecordingCallbackFence {
    private let lock = NSLock()
    private var identity = UUID()

    @discardableResult
    func reset(perform mutation: () -> Void = {}) -> UUID {
        lock.lock()
        defer { lock.unlock() }
        identity = UUID()
        mutation()
        return identity
    }

    func apply(ifCurrent expected: UUID, _ mutation: () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard identity == expected else { return }
        mutation()
    }

    func whenCurrentOnMain(_ expected: UUID, perform action: @escaping () -> Void) {
        let applyIfCurrent = { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let isCurrent = self.identity == expected
            self.lock.unlock()
            guard isCurrent else { return }
            action()
        }
        if Thread.isMainThread {
            applyIfCurrent()
        } else {
            DispatchQueue.main.async(execute: applyIfCurrent)
        }
    }
}
