import ExpoModulesCore
import RNSentry
import StoreKit
import UIKit

public final class AppStoreBillingModule: Module {
    private let service = AppStoreBillingService(store: StoreKitAdapter())

    // swiftlint:disable:next function_body_length
    public func definition() -> ModuleDefinition {
        Name("AppStoreBilling")

        Events("onTransactionUpdate")

        OnDestroy {
            self.service.stopTransactionUpdates()
        }

        AsyncFunction("loadProduct") { (productID: String, promise: Promise) in
            guard self.isTargetProduct(productID, promise: promise) else {
                return
            }
            Task {
                do {
                    let product = try await self.service.loadProduct(productID: productID)
                    promise.resolve(product.map(Self.productPayload))
                } catch {
                    self.reject(error, operation: "loadProduct", promise: promise)
                }
            }
        }

        AsyncFunction("purchase") { (productID: String, appAccountToken: String, promise: Promise) in
            guard self.isTargetProduct(productID, promise: promise) else {
                return
            }
            guard let token = UUID(uuidString: appAccountToken) else {
                promise.reject(
                    "APP_STORE_INVALID_ACCOUNT_TOKEN",
                    "The App Store account token must be a UUID."
                )
                return
            }
            Task {
                do {
                    let result = try await self.service.purchase(
                        productID: productID,
                        appAccountToken: token
                    )
                    promise.resolve(Self.purchasePayload(result))
                } catch {
                    self.reject(error, operation: "purchase", promise: promise)
                }
            }
        }

        AsyncFunction("restoreCurrentEntitlements") { (productID: String, promise: Promise) in
            guard self.isTargetProduct(productID, promise: promise) else {
                return
            }
            Task {
                do {
                    let transactions = try await self.service.restoreCurrentEntitlements(
                        productID: productID
                    )
                    promise.resolve(transactions.map(Self.transactionPayload))
                } catch {
                    self.reject(
                        error,
                        operation: "restoreCurrentEntitlements",
                        promise: promise
                    )
                }
            }
        }

        Function("startTransactionUpdates") { (productID: String) throws in
            guard productID == dofekPremiumMonthlyProductID else {
                throw AppStoreBillingError.unexpectedProduct(productID)
            }
            self.service.startTransactionUpdates(productID: productID) { [weak self] transaction in
                self?.sendEvent("onTransactionUpdate", Self.transactionPayload(transaction))
            }
        }

        Function("stopTransactionUpdates") {
            self.service.stopTransactionUpdates()
        }

        AsyncFunction("finishTransaction") { (transactionID: String, promise: Promise) in
            guard let parsedTransactionID = UInt64(transactionID) else {
                promise.reject(
                    "APP_STORE_INVALID_TRANSACTION_ID",
                    "The App Store transaction ID is invalid."
                )
                return
            }
            Task {
                do {
                    try await self.service.finishTransaction(transactionID: parsedTransactionID)
                    promise.resolve(nil)
                } catch {
                    self.reject(error, operation: "finishTransaction", promise: promise)
                }
            }
        }

        AsyncFunction("showManageSubscriptions") { (promise: Promise) in
            Task { @MainActor in
                do {
                    guard let viewController = Self.foregroundViewController(),
                          let windowScene = viewController.view.window?.windowScene else {
                        promise.reject(
                            "APP_STORE_NO_FOREGROUND_SCENE",
                            "Subscription management requires a foreground app window."
                        )
                        return
                    }
                    try await AppStore.showManageSubscriptions(in: windowScene)
                    promise.resolve(nil)
                } catch {
                    self.reject(error, operation: "showManageSubscriptions", promise: promise)
                }
            }
        }
    }

    private func isTargetProduct(_ productID: String, promise: Promise) -> Bool {
        guard productID == dofekPremiumMonthlyProductID else {
            promise.reject(
                "APP_STORE_UNSUPPORTED_PRODUCT",
                "The App Store product \(productID) is not supported."
            )
            return false
        }
        return true
    }

    private func reject(_ error: Error, operation: String, promise: Promise) {
        SentrySDK.capture(error: error) { scope in
            scope.setTag(value: operation, key: "app_store_billing.operation")
        }
        promise.reject("APP_STORE_BILLING_ERROR", error.localizedDescription)
    }

    private static func productPayload(_ product: AppStoreProductInfo) -> [String: Any] {
        [
            "productID": product.productID,
            "displayName": product.displayName,
            "description": product.description,
            "displayPrice": product.displayPrice,
        ]
    }

    private static func transactionPayload(
        _ transaction: AppStoreTransactionInfo
    ) -> [String: Any] {
        [
            "transactionID": String(transaction.transactionID),
            "productID": transaction.productID,
            "signedTransaction": transaction.signedTransaction,
        ]
    }

    private static func purchasePayload(
        _ result: AppStoreBillingPurchaseResult
    ) -> [String: Any] {
        switch result {
        case .verified(let transaction):
            return transactionPayload(transaction).merging(["outcome": "verified"]) { _, new in new }
        case .cancelled:
            return ["outcome": "cancelled"]
        case .pending:
            return ["outcome": "pending"]
        }
    }

    @MainActor
    private static func foregroundViewController() -> UIViewController? {
        let foregroundScene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        guard let root = foregroundScene?.windows.first(where: { $0.isKeyWindow })?.rootViewController
        else {
            return nil
        }
        return visibleViewController(from: root)
    }

    @MainActor
    private static func visibleViewController(from root: UIViewController) -> UIViewController {
        if let presented = root.presentedViewController {
            return visibleViewController(from: presented)
        }
        if let navigation = root as? UINavigationController,
           let visible = navigation.visibleViewController {
            return visibleViewController(from: visible)
        }
        if let tab = root as? UITabBarController,
           let selected = tab.selectedViewController {
            return visibleViewController(from: selected)
        }
        return root
    }
}
