import Foundation
import UserNotifications

/// App-owned notification lifecycle. State stays on the main queue; Apple
/// pending/delivered lookup and removal run on a private serial cleanup queue.
/// Generation file I/O uses a separate store queue so Apple stalls cannot block
/// durable retirement commits.
final class CollectionNotificationService {
    private let center: CollectionNotificationCenter
    private let notifications: NotificationCenter
    private let isAppActive: () -> Bool
    private let isCollectionActive: () -> Bool
    private let reportError: (Error, String) -> Void
    private let cleanupQueue: DispatchQueue
    private let generationStore: CollectionNotificationGenerationStore
    private var connectionObserver: NSObjectProtocol?
    private var permissionGeneration: UInt64 = 0
    private var enabled = false
    private var whoopIsConnected = false
    private var requestIdentifiers: [String: String] = [:]
    private var generationState: GenerationState = .loading
    private var generationOperation: UInt64 = 0
    private var generationWaiters: [(Result<Void, Error>) -> Void] = []
    private lazy var coordinator = CollectionNotificationCoordinator(
        schedule: { [weak self] in self?.schedule($0) },
        cancel: { [weak self] in self?.cancel($0) }
    )

    private enum GenerationState {
        case loading
        case retiring
        case legacy
        case ready(UUID)
        case failed(Error, requiresRetirement: Bool)

        var currentUUID: UUID? {
            switch self {
            case .ready(let generation):
                return generation
            case .loading, .retiring, .legacy, .failed:
                return nil
            }
        }

        var isReadable: Bool {
            switch self {
            case .legacy, .ready:
                return true
            case .loading, .retiring, .failed:
                return false
            }
        }
    }

    init(
        center: CollectionNotificationCenter,
        notifications: NotificationCenter,
        isAppActive: @escaping () -> Bool,
        isCollectionActive: @escaping () -> Bool,
        reportError: @escaping (Error, String) -> Void,
        cleanupQueue: DispatchQueue = DispatchQueue(label: "com.dofek.collection-notification-cleanup"),
        generationStore: CollectionNotificationGenerationStore
    ) {
        self.center = center
        self.notifications = notifications
        self.isAppActive = isAppActive
        self.isCollectionActive = isCollectionActive
        self.reportError = reportError
        self.cleanupQueue = cleanupQueue
        self.generationStore = generationStore
    }

    deinit {
        if let connectionObserver { notifications.removeObserver(connectionObserver) }
    }

    func start() {
        connectionObserver = notifications.addObserver(
            forName: Notification.Name("WhoopBle.connectionStateChanged"),
            object: nil,
            queue: nil
        ) { [weak self] notification in
            guard let state = notification.userInfo?["state"] as? String else { return }
            if Thread.isMainThread {
                self?.handleConnectionState(state)
            } else {
                // Main-thread lifecycle snapshots can synchronously query the BLE queue.
                // Its connection publication must never wait for main-thread delivery.
                DispatchQueue.main.async { [weak self] in self?.handleConnectionState(state) }
            }
        }
        coordinator.appBecameActive()
        loadGeneration()
    }

    private func handleConnectionState(_ state: String) {
        switch state {
        case "connected":
            whoopIsConnected = true
            coordinator.whoopConnected()
        case "disconnected":
            whoopIsConnected = false
            coordinator.whoopDisconnected()
        case "intentionallyDisconnected":
            whoopIsConnected = false
            coordinator.whoopIntentionallyDisconnected()
        default:
            break
        }
    }

    func enable(requestPermission: Bool, completion: @escaping (Result<Bool, Error>) -> Void) {
        permissionGeneration &+= 1
        let generation = permissionGeneration
        whenGenerationReadable { [weak self] readiness in
            guard let self else { return }
            if case .failure(let error) = readiness {
                completion(.failure(error))
                return
            }
            guard generation == self.permissionGeneration else {
                completion(.success(false))
                return
            }
            self.center.getAuthorizationStatus { [weak self] status in
                guard let self else { return }
                DispatchQueue.main.async {
                    guard generation == self.permissionGeneration else {
                        completion(.success(false))
                        return
                    }
                    if status == .notDetermined {
                        guard requestPermission, self.isAppActive() else {
                            completion(.success(false))
                            return
                        }
                        self.center.requestAuthorization { granted, error in
                            self.finishAuthorization(
                                granted, error: error, generation: generation, completion: completion
                            )
                        }
                    } else {
                        let granted = status == .authorized
                        self.finishAuthorization(
                            granted, error: nil, generation: generation, completion: completion
                        )
                    }
                }
            }
        }
    }

    private func finishAuthorization(
        _ granted: Bool,
        error: Error?,
        generation: UInt64,
        completion: @escaping (Result<Bool, Error>) -> Void
    ) {
        DispatchQueue.main.async {
            if let error { self.reportError(error, "authorization") }
            guard generation == self.permissionGeneration else {
                completion(.success(false))
                return
            }
            if let error {
                completion(.failure(error))
                return
            }
            guard self.generationState.isReadable else {
                if case .failed(let storageError, _) = self.generationState {
                    completion(.failure(storageError))
                } else {
                    completion(.success(false))
                }
                return
            }
            self.enabled = granted
            self.coordinator.setEnabled(granted)
            if granted && self.whoopIsConnected {
                self.coordinator.whoopConnected()
            }
            completion(.success(granted))
        }
    }

    func disable() {
        permissionGeneration &+= 1
        enabled = false
        coordinator.setEnabled(false)
    }

    /// Disarms scheduling immediately and completes after the durable generation
    /// UUID is replaced. Does not wait for Apple notification enumeration or removal.
    func retire(completion: @escaping (Result<Void, Error>) -> Void) {
        permissionGeneration &+= 1
        enabled = false
        coordinator.setEnabled(false)
        generationState = .retiring
        // Enqueue the durable write before failing waiters. A synchronous reentrant
        // retire from those callbacks must not invert disk commit order.
        writeRetirement(completion: completion)
        finishGenerationWaiters(.failure(CollectionNotificationGenerationError.retirementInProgress))
    }

    private func writeRetirement(completion: ((Result<Void, Error>) -> Void)? = nil) {
        generationOperation &+= 1
        let operation = generationOperation
        let next = UUID()
        generationStore.write(next) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if operation == self.generationOperation {
                    switch result {
                    case .success:
                        self.generationState = .ready(next)
                        self.reconcileRetiredGenerations()
                    case .failure(let error):
                        self.generationState = .failed(error, requiresRetirement: true)
                    }
                    self.finishGenerationWaiters(result)
                    if case .failure(let error) = result { self.reportError(error, "generation") }
                }
                // A caller can immediately enable or retire again once its write settles.
                completion?(result)
            }
        }
    }

    func appBecameActive() {
        coordinator.appBecameActive()
        switch generationState {
        case .legacy, .ready:
            // Keep the loaded generation; do not re-enter .loading and drop lifecycle events.
            reconcileRetiredGenerations()
        case .failed(_, requiresRetirement: false):
            // Recoverable initial/read failure — retry once from disk.
            loadGeneration()
        case .loading, .retiring, .failed:
            break
        }
    }

    /// iOS may omit this callback for a suspended app; never infer termination from inactivity.
    func appWillTerminate() {
        coordinator.appWillTerminate(collectionIsActive: isCollectionActive())
    }

    private func whenGenerationReadable(_ completion: @escaping (Result<Void, Error>) -> Void) {
        switch generationState {
        case .legacy, .ready:
            completion(.success(()))
        case .failed(let error, requiresRetirement: false):
            completion(.failure(error))
        case .failed(_, requiresRetirement: true):
            // Disk still holds the retired generation. Replace it before checking permission.
            generationWaiters.append(completion)
            generationState = .loading
            writeRetirement()
        case .retiring:
            completion(.failure(CollectionNotificationGenerationError.retirementInProgress))
        case .loading:
            generationWaiters.append(completion)
        }
    }

    private func finishGenerationWaiters(_ result: Result<Void, Error>) {
        let waiters = generationWaiters
        generationWaiters.removeAll()
        for waiter in waiters {
            waiter(result)
        }
    }

    private func loadGeneration() {
        generationOperation &+= 1
        let operation = generationOperation
        generationState = .loading
        generationStore.read { [weak self] result in
            DispatchQueue.main.async {
                guard let self, operation == self.generationOperation else { return }
                switch result {
                case .success(let generation):
                    self.generationState = generation.map { .ready($0) } ?? .legacy
                    self.reconcileRetiredGenerations()
                    self.finishGenerationWaiters(.success(()))
                case .failure(let error):
                    self.generationState = .failed(error, requiresRetirement: false)
                    self.finishGenerationWaiters(.failure(error))
                    self.reportError(error, "generation")
                }
            }
        }
    }

    private func reconcileRetiredGenerations() {
        // Truly legacy (missing file) has no retired generation to clear.
        guard case .ready = generationState else { return }
        let removeRetired: ([String]) -> Void = { [weak self] savedIdentifiers in
            DispatchQueue.main.async {
                guard let self, case .ready(let latest) = self.generationState else { return }
                let retired = savedIdentifiers.filter { identifier in
                    CollectionNotificationIdentity.isCollectionAlert(identifier)
                        && !CollectionNotificationIdentity.belongsToCurrentGeneration(
                            identifier,
                            current: latest
                        )
                }
                self.remove(retired)
            }
        }
        cleanupQueue.async { [weak self] in
            guard let self else { return }
            self.center.getPendingIdentifiers(completion: removeRetired)
            self.center.getDeliveredIdentifiers(completion: removeRetired)
        }
    }

    private func schedule(_ notification: CollectionNotification) {
        guard generationState.isReadable else { return }
        // Each save owns its identifier, so a late save cannot overwrite a newer grace period.
        let identifier = CollectionNotificationIdentity.makeRequestIdentifier(
            logicalPrefix: notification.identifier,
            generation: generationState.currentUUID
        )
        if let previous = requestIdentifiers.updateValue(identifier, forKey: notification.identifier) {
            remove([previous])
        }
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: notification.delay, repeats: false)
        )
        center.add(request) { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    self.reportError(error, notification.identifier)
                    if self.requestIdentifiers[notification.identifier] == identifier {
                        self.requestIdentifiers.removeValue(forKey: notification.identifier)
                    }
                } else if !self.enabled || self.requestIdentifiers[notification.identifier] != identifier {
                    self.remove([identifier])
                }
            }
        }
    }

    private func cancel(_ identifiers: [String]) {
        let current = identifiers.compactMap { requestIdentifiers.removeValue(forKey: $0) }
        let known = identifiers + current
        // Find warnings persisted by previous processes. A delayed lookup must preserve any
        // new request scheduled since cancellation, while stale add callbacks remove only themselves.
        let removeCancelled: ([String]) -> Void = { [weak self] savedIdentifiers in
            DispatchQueue.main.async {
                guard let self else { return }
                let active = Set(self.requestIdentifiers.values)
                self.remove(savedIdentifiers.filter { saved in
                    !active.contains(saved) && identifiers.contains {
                        saved == $0 || saved.hasPrefix("\($0).")
                    }
                })
            }
        }
        cleanupQueue.async { [weak self] in
            guard let self else { return }
            self.performRemovals(known)
            self.center.getPendingIdentifiers(completion: removeCancelled)
            self.center.getDeliveredIdentifiers(completion: removeCancelled)
        }
    }

    private func remove(_ identifiers: [String]) {
        guard !identifiers.isEmpty else { return }
        cleanupQueue.async { [weak self] in
            self?.performRemovals(identifiers)
        }
    }

    private func performRemovals(_ identifiers: [String]) {
        guard !identifiers.isEmpty else { return }
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }
}
