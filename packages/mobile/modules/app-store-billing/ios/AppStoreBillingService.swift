import Foundation
import StoreKit

let dofekPremiumMonthlyProductID = "com.dofek.premium.monthly"

struct AppStoreProductInfo: Equatable, Sendable {
    let productID: String
    let displayName: String
    let description: String
    let displayPrice: String
}

struct AppStoreTransactionInfo: Equatable, Sendable {
    let transactionID: UInt64
    let productID: String
    let signedTransaction: String
    let expirationDate: Date?
    let revocationDate: Date?
    let isUpgraded: Bool

    init(
        transactionID: UInt64,
        productID: String,
        signedTransaction: String,
        expirationDate: Date? = nil,
        revocationDate: Date? = nil,
        isUpgraded: Bool = false
    ) {
        self.transactionID = transactionID
        self.productID = productID
        self.signedTransaction = signedTransaction
        self.expirationDate = expirationDate
        self.revocationDate = revocationDate
        self.isUpgraded = isUpgraded
    }

    func isActive(at date: Date) -> Bool {
        guard revocationDate == nil, !isUpgraded else {
            return false
        }
        guard let expirationDate else {
            return true
        }
        return expirationDate > date
    }
}

enum AppStoreKitVerificationResult: Equatable, Sendable {
    case verified(AppStoreTransactionInfo)
    case unverified
}

enum AppStoreKitPurchaseResult: Equatable, Sendable {
    case verified(AppStoreTransactionInfo)
    case unverified
    case cancelled
    case pending
}

enum AppStoreBillingPurchaseResult: Equatable, Sendable {
    case verified(AppStoreTransactionInfo)
    case cancelled
    case pending
}

enum AppStoreBillingError: Error, Equatable, LocalizedError {
    case productNotFound(String)
    case transactionNotFound(UInt64)
    case unsupportedProduct(String)
    case unverifiedTransaction
    case unexpectedProduct(String)
    case inactiveTransaction
    case unknownPurchaseOutcome

    var errorDescription: String? {
        switch self {
        case .productNotFound(let productID):
            return "The App Store product \(productID) is unavailable."
        case .transactionNotFound(let transactionID):
            return "App Store transaction \(transactionID) is no longer available to finish."
        case .unsupportedProduct(let productID):
            return "The App Store product \(productID) is not supported."
        case .unverifiedTransaction:
            return "The App Store could not verify this transaction."
        case .unexpectedProduct(let productID):
            return "The App Store returned the unexpected product \(productID)."
        case .inactiveTransaction:
            return "The App Store transaction is no longer active."
        case .unknownPurchaseOutcome:
            return "The App Store returned an unsupported purchase result."
        }
    }
}

protocol AppStoreKitProviding: Sendable {
    func loadProduct(productID: String) async throws -> AppStoreProductInfo?
    func purchase(
        productID: String,
        appAccountToken: UUID
    ) async throws -> AppStoreKitPurchaseResult
    func sync() async throws
    func currentEntitlements() async throws -> [AppStoreKitVerificationResult]
    func transactionUpdates() async -> AsyncStream<AppStoreKitVerificationResult>
    func finishTransaction(transactionID: UInt64) async throws
}

final class AppStoreBillingService: @unchecked Sendable {
    private let store: any AppStoreKitProviding
    private let now: @Sendable () -> Date
    private let updatesLock = NSLock()
    private var updatesTask: Task<Void, Never>?

    init(
        store: any AppStoreKitProviding,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.store = store
        self.now = now
    }

    deinit {
        updatesTask?.cancel()
    }

    func loadProduct(productID: String) async throws -> AppStoreProductInfo? {
        try requireTargetProduct(productID)
        return try await store.loadProduct(productID: productID)
    }

    func purchase(
        productID: String,
        appAccountToken: UUID
    ) async throws -> AppStoreBillingPurchaseResult {
        try requireTargetProduct(productID)
        let result = try await store.purchase(
            productID: productID,
            appAccountToken: appAccountToken
        )
        switch result {
        case .verified(let transaction):
            return .verified(try export(transaction, for: productID))
        case .cancelled:
            return .cancelled
        case .pending:
            return .pending
        case .unverified:
            throw AppStoreBillingError.unverifiedTransaction
        }
    }

    func restoreCurrentEntitlements(
        productID: String
    ) async throws -> [AppStoreTransactionInfo] {
        try requireTargetProduct(productID)
        try await store.sync()
        let entitlements = try await store.currentEntitlements()
        return entitlements.compactMap { result in
            guard case .verified(let transaction) = result else {
                return nil
            }
            return exportedIfActive(transaction, for: productID)
        }
    }

    func startTransactionUpdates(
        productID: String,
        onTransaction: @escaping @Sendable (AppStoreTransactionInfo) -> Void
    ) {
        stopTransactionUpdates()
        guard productID == dofekPremiumMonthlyProductID else {
            return
        }
        let task = Task { [weak self] in
            guard let self else {
                return
            }
            let updates = await store.transactionUpdates()
            for await result in updates {
                guard !Task.isCancelled else {
                    return
                }
                guard case .verified(let transaction) = result,
                      let exported = exportedForUpdate(transaction, for: productID) else {
                    continue
                }
                onTransaction(exported)
            }
        }
        updatesLock.lock()
        updatesTask = task
        updatesLock.unlock()
    }

    func stopTransactionUpdates() {
        updatesLock.lock()
        let task = updatesTask
        updatesTask = nil
        updatesLock.unlock()
        task?.cancel()
    }

    func finishTransaction(transactionID: UInt64) async throws {
        try await store.finishTransaction(transactionID: transactionID)
    }

    private func export(
        _ transaction: AppStoreTransactionInfo,
        for productID: String
    ) throws -> AppStoreTransactionInfo {
        guard transaction.productID == productID else {
            throw AppStoreBillingError.unexpectedProduct(transaction.productID)
        }
        guard transaction.isActive(at: now()) else {
            throw AppStoreBillingError.inactiveTransaction
        }
        return transaction
    }

    private func requireTargetProduct(_ productID: String) throws {
        guard productID == dofekPremiumMonthlyProductID else {
            throw AppStoreBillingError.unsupportedProduct(productID)
        }
    }

    private func exportedIfActive(
        _ transaction: AppStoreTransactionInfo,
        for productID: String
    ) -> AppStoreTransactionInfo? {
        guard transaction.productID == productID,
              transaction.isActive(at: now()) else {
            return nil
        }
        return transaction
    }

    private func exportedForUpdate(
        _ transaction: AppStoreTransactionInfo,
        for productID: String
    ) -> AppStoreTransactionInfo? {
        transaction.productID == productID ? transaction : nil
    }
}

actor StoreKitAdapter: AppStoreKitProviding {
    private var products: [String: Product] = [:]
    private var unfinishedTransactions: [UInt64: Transaction] = [:]

    func loadProduct(productID: String) async throws -> AppStoreProductInfo? {
        let loadedProducts = try await Product.products(for: [productID])
        guard let product = loadedProducts.first(where: { $0.id == productID }) else {
            return nil
        }
        products[productID] = product
        return AppStoreProductInfo(
            productID: product.id,
            displayName: product.displayName,
            description: product.description,
            displayPrice: product.displayPrice
        )
    }

    func purchase(
        productID: String,
        appAccountToken: UUID
    ) async throws -> AppStoreKitPurchaseResult {
        let product: Product
        if let loaded = products[productID] {
            product = loaded
        } else {
            _ = try await loadProduct(productID: productID)
            guard let loaded = products[productID] else {
                throw AppStoreBillingError.productNotFound(productID)
            }
            product = loaded
        }

        let result = try await product.purchase(options: [.appAccountToken(appAccountToken)])
        switch result {
        case .success(let verification):
            switch verification {
            case .verified(let transaction):
                return .verified(
                    record(transaction, signedTransaction: verification.jwsRepresentation)
                )
            case .unverified:
                return .unverified
            }
        case .userCancelled:
            return .cancelled
        case .pending:
            return .pending
        @unknown default:
            throw AppStoreBillingError.unknownPurchaseOutcome
        }
    }

    func currentEntitlements() async -> [AppStoreKitVerificationResult] {
        var results: [AppStoreKitVerificationResult] = []
        for await verification in Transaction.currentEntitlements {
            results.append(record(verification))
        }
        return results
    }

    func sync() async throws {
        try await AppStore.sync()
    }

    func transactionUpdates() async -> AsyncStream<AppStoreKitVerificationResult> {
        AsyncStream { continuation in
            let task = Task {
                for await verification in Transaction.updates {
                    guard !Task.isCancelled else {
                        break
                    }
                    continuation.yield(self.record(verification))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    func finishTransaction(transactionID: UInt64) async throws {
        guard let transaction = unfinishedTransactions.removeValue(forKey: transactionID) else {
            throw AppStoreBillingError.transactionNotFound(transactionID)
        }
        await transaction.finish()
    }

    private func record(
        _ verification: VerificationResult<Transaction>
    ) -> AppStoreKitVerificationResult {
        switch verification {
        case .verified(let transaction):
            return .verified(
                record(transaction, signedTransaction: verification.jwsRepresentation)
            )
        case .unverified:
            return .unverified
        }
    }

    private func record(
        _ transaction: Transaction,
        signedTransaction: String
    ) -> AppStoreTransactionInfo {
        unfinishedTransactions[transaction.id] = transaction
        return AppStoreTransactionInfo(
            transactionID: transaction.id,
            productID: transaction.productID,
            signedTransaction: signedTransaction,
            expirationDate: transaction.expirationDate,
            revocationDate: transaction.revocationDate,
            isUpgraded: transaction.isUpgraded
        )
    }
}
