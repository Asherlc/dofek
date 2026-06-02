import Foundation

enum MainThreadEventEmitter {
    static func emit(
        _ payload: [String: Any?],
        completion: @escaping () -> Void = {},
        send: @escaping ([String: Any]) -> Void
    ) {
        let bridgePayload = payload.compactMapValues { $0 }

        if Thread.isMainThread {
            send(bridgePayload)
            completion()
            return
        }

        DispatchQueue.main.async {
            send(bridgePayload)
            completion()
        }
    }
}
