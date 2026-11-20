import Foundation
import Security

struct OuraPairing: Codable {
    let id: UUID
    let serialNumber: String
    var peripheralID: UUID
    let key: Data
    var confirmed = false
    var archived = false

    private enum CodingKeys: String, CodingKey {
        case id
        case serialNumber
        case peripheralID
        case key
        case confirmed
        case archived
    }

    init(serialNumber: String, peripheralID: UUID) throws {
        var bytes = [UInt8](repeating: 0, count: 16)
        try OuraPairings.check(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes))
        self.id = UUID()
        self.serialNumber = serialNumber
        self.peripheralID = peripheralID
        self.key = Data(bytes)
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        serialNumber = try container.decode(String.self, forKey: .serialNumber)
        peripheralID = try container.decode(UUID.self, forKey: .peripheralID)
        key = try container.decode(Data.self, forKey: .key)
        confirmed = try container.decodeIfPresent(Bool.self, forKey: .confirmed) ?? false
        archived = try container.decodeIfPresent(Bool.self, forKey: .archived) ?? false
    }

}

enum OuraPairings {
    private static let service = "org.dofek.oura-ble"

    static func matching(serialNumber: String) throws -> OuraPairing? {
        var attributes = query()
        attributes[kSecAttrLabel as String] = serialNumber
        return try read(attributes)
    }

    static func lookup(_ id: UUID) throws -> OuraPairing? {
        try read(query(id))
    }

    static func save(_ pairing: OuraPairing) throws {
        let attributes = query(pairing.id)
        let data = try JSONEncoder().encode(pairing)
        let label = label(for: pairing)
        let status = SecItemUpdate(
            attributes as CFDictionary,
            [
                kSecValueData as String: data,
                kSecAttrLabel as String: label,
            ] as CFDictionary
        )
        if status == errSecItemNotFound {
            var item = attributes
            item[kSecAttrLabel as String] = label
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            try check(SecItemAdd(item as CFDictionary, nil))
        } else {
            try check(status)
        }
    }

    private static func label(for pairing: OuraPairing) -> String {
        pairing.archived ? "archived.\(pairing.id.uuidString)" : pairing.serialNumber
    }

    static func remove(_ id: UUID) throws {
        let status = SecItemDelete(query(id) as CFDictionary)
        if status != errSecItemNotFound {
            try check(status)
        }
    }

    private static func read(_ query: [String: Any]) throws -> OuraPairing? {
        var attributes = query
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &value)
        if status == errSecItemNotFound {
            return nil
        }
        try check(status)
        guard let data = value as? Data else {
            throw OuraAdapterError("The ring pairing in the Keychain could not be read.")
        }
        return try JSONDecoder().decode(OuraPairing.self, from: data)
    }

    private static func query(_ id: UUID? = nil) -> [String: Any] {
        var attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        if let id {
            attributes[kSecAttrAccount as String] = id.uuidString
        }
        return attributes
    }

    static func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else {
            let detail = SecCopyErrorMessageString(status, nil) as String? ?? String(status)
            throw OuraAdapterError("The ring Keychain operation failed (\(detail)).")
        }
    }
}

struct OuraAdapterError: LocalizedError {
    let message: String
    var errorDescription: String? { message }

    init(_ message: String) {
        self.message = message
    }
}
