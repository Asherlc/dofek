import Foundation

enum MainThreadEventEmitter {
    static func emit(_ payload: [String: Any?], send: @escaping ([String: Any]) -> Void) {
        let bridgePayload = payload.compactMapValues { $0 }

        if Thread.isMainThread {
            send(bridgePayload)
            return
        }

        DispatchQueue.main.async {
            send(bridgePayload)
        }
    }
}
