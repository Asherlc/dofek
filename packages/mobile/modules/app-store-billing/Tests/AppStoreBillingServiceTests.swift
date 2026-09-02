import XCTest
@testable import AppStoreBillingLib

final class AppStoreBillingServiceTests: XCTestCase {
    private let productID = "com.dofek.premium.monthly"
    private let appAccountToken = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!

    func testLoadProductReturnsStoreProductDetails() async throws {
        let product = AppStoreProductInfo(
            productID: productID,
            displayName: "Dofek Premium",
            description: "Full access",
            displayPrice: "$4.99"
        )
        let store = FakeStoreKit(product: product)
        let service = AppStoreBillingService(store: store)

        let loaded = try await service.loadProduct(productID: productID)

        XCTAssertEqual(loaded, product)
    }

    func testPurchaseReturnsVerifiedSignedTransactionWithoutFinishingIt() async throws {
        let transaction = makeTransaction(transactionID: 41)
        let store = FakeStoreKit(purchaseResult: .verified(transaction))
        let service = AppStoreBillingService(store: store)

        let result = try await service.purchase(
            productID: productID,
            appAccountToken: appAccountToken
        )

        XCTAssertEqual(result, .verified(transaction))
        XCTAssertEqual(store.purchaseRequests, [
            PurchaseRequest(productID: productID, appAccountToken: appAccountToken),
        ])
        XCTAssertEqual(store.finishedTransactionIDs, [])
    }

    func testPurchaseMapsUserCancellationToCancelledOutcome() async throws {
        let store = FakeStoreKit(purchaseResult: .cancelled)
        let service = AppStoreBillingService(store: store)

        let result = try await service.purchase(
            productID: productID,
            appAccountToken: appAccountToken
        )

        XCTAssertEqual(result, .cancelled)
    }

    func testPurchaseRejectsUnverifiedTransaction() async throws {
        let store = FakeStoreKit(purchaseResult: .unverified)
        let service = AppStoreBillingService(store: store)

        do {
            _ = try await service.purchase(
                productID: productID,
                appAccountToken: appAccountToken
            )
            XCTFail("Expected an unverified-transaction error")
        } catch {
            XCTAssertEqual(error as? AppStoreBillingError, .unverifiedTransaction)
        }
    }

    func testPurchaseRejectsUnsupportedProductBeforeCallingStoreKit() async throws {
        let store = FakeStoreKit(purchaseResult: .cancelled)
        let service = AppStoreBillingService(store: store)

        do {
            _ = try await service.purchase(
                productID: "other.product",
                appAccountToken: appAccountToken
            )
            XCTFail("Expected an unsupported-product error")
        } catch {
            XCTAssertEqual(error as? AppStoreBillingError, .unsupportedProduct("other.product"))
        }
        XCTAssertEqual(store.purchaseRequests, [])
    }

    func testRestoreReturnsOnlyVerifiedActiveTransactionsForTargetProduct() async throws {
        let expected = makeTransaction(transactionID: 51)
        let otherProduct = makeTransaction(transactionID: 52, productID: "other.product")
        let revoked = makeTransaction(transactionID: 53, revocationDate: Date(timeIntervalSince1970: 1))
        let expired = makeTransaction(transactionID: 54, expirationDate: Date(timeIntervalSince1970: 1))
        let store = FakeStoreKit(currentEntitlements: [
            .verified(expected),
            .unverified,
            .verified(otherProduct),
            .verified(revoked),
            .verified(expired),
        ])
        let service = AppStoreBillingService(store: store, now: { Date(timeIntervalSince1970: 10) })

        let restored = try await service.restoreCurrentEntitlements(productID: productID)

        XCTAssertEqual(restored, [expected])
        XCTAssertEqual(store.syncRequests, 1)
        XCTAssertEqual(store.finishedTransactionIDs, [])
    }

    func testTransactionUpdatesDeliverVerifiedTargetTransactionsIncludingRevocationsWithoutFinishing() async {
        let expected = makeTransaction(transactionID: 61)
        let revoked = makeTransaction(
            transactionID: 63,
            revocationDate: Date(timeIntervalSince1970: 1)
        )
        let wrongProduct = makeTransaction(transactionID: 62, productID: "other.product")
        let store = FakeStoreKit()
        let service = AppStoreBillingService(store: store)
        let received = TransactionRecorder()
        let allUpdates = expectation(description: "target updates delivered")
        allUpdates.expectedFulfillmentCount = 2
        received.onAppend = { allUpdates.fulfill() }

        service.startTransactionUpdates(productID: productID) { transaction in
            received.append(transaction)
        }
        store.sendUpdate(.unverified)
        store.sendUpdate(.verified(wrongProduct))
        store.sendUpdate(.verified(revoked))
        store.sendUpdate(.verified(expected))

        await fulfillment(of: [allUpdates], timeout: 1)
        service.stopTransactionUpdates()

        XCTAssertEqual(received.values, [revoked, expected])
        XCTAssertEqual(store.finishedTransactionIDs, [])
    }

    func testFinishTransactionDelegatesOnlyWhenExplicitlyRequested() async throws {
        let store = FakeStoreKit()
        let service = AppStoreBillingService(store: store)

        try await service.finishTransaction(transactionID: 71)

        XCTAssertEqual(store.finishedTransactionIDs, [71])
    }

    private func makeTransaction(
        transactionID: UInt64,
        productID: String? = nil,
        expirationDate: Date? = nil,
        revocationDate: Date? = nil
    ) -> AppStoreTransactionInfo {
        AppStoreTransactionInfo(
            transactionID: transactionID,
            productID: productID ?? self.productID,
            signedTransaction: "signed-transaction-\(transactionID)",
            expirationDate: expirationDate,
            revocationDate: revocationDate
        )
    }
}

private final class TransactionRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var transactions: [AppStoreTransactionInfo] = []
    var onAppend: (() -> Void)?

    var values: [AppStoreTransactionInfo] {
        lock.lock()
        defer { lock.unlock() }
        return transactions
    }

    func append(_ transaction: AppStoreTransactionInfo) {
        lock.lock()
        transactions.append(transaction)
        lock.unlock()
        onAppend?()
    }
}

private struct PurchaseRequest: Equatable {
    let productID: String
    let appAccountToken: UUID
}

private final class FakeStoreKit: AppStoreKitProviding, @unchecked Sendable {
    private let product: AppStoreProductInfo?
    private let purchaseResult: AppStoreKitPurchaseResult
    private let currentEntitlementResults: [AppStoreKitVerificationResult]
    private let updateStream: AsyncStream<AppStoreKitVerificationResult>
    private let updateContinuation: AsyncStream<AppStoreKitVerificationResult>.Continuation

    private(set) var purchaseRequests: [PurchaseRequest] = []
    private(set) var finishedTransactionIDs: [UInt64] = []
    private(set) var syncRequests = 0

    init(
        product: AppStoreProductInfo? = nil,
        purchaseResult: AppStoreKitPurchaseResult = .cancelled,
        currentEntitlements: [AppStoreKitVerificationResult] = []
    ) {
        self.product = product
        self.purchaseResult = purchaseResult
        self.currentEntitlementResults = currentEntitlements
        var continuation: AsyncStream<AppStoreKitVerificationResult>.Continuation!
        self.updateStream = AsyncStream { continuation = $0 }
        self.updateContinuation = continuation
    }

    func loadProduct(productID: String) async throws -> AppStoreProductInfo? {
        product
    }

    func purchase(
        productID: String,
        appAccountToken: UUID
    ) async throws -> AppStoreKitPurchaseResult {
        purchaseRequests.append(
            PurchaseRequest(productID: productID, appAccountToken: appAccountToken)
        )
        return purchaseResult
    }

    func sync() async throws {
        syncRequests += 1
    }

    func currentEntitlements() async -> [AppStoreKitVerificationResult] {
        currentEntitlementResults
    }

    func transactionUpdates() async -> AsyncStream<AppStoreKitVerificationResult> {
        updateStream
    }

    func finishTransaction(transactionID: UInt64) async throws {
        finishedTransactionIDs.append(transactionID)
    }

    func sendUpdate(_ update: AppStoreKitVerificationResult) {
        updateContinuation.yield(update)
    }
}
