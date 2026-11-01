import Foundation
import Security

enum AgentError: LocalizedError {
    case notPaired
    case invalidServerResponse
    case rejected(String)

    var errorDescription: String? {
        switch self {
        case .notPaired: "Hubungkan iPhone Agent dulu."
        case .invalidServerResponse: "Respons gateway tidak valid."
        case .rejected(let message): message
        }
    }
}

enum AgentCredentials {
    private static let service = "com.karkandea.iphoneagent"
    private static let account = "device-secret"

    static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var data: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &data) == errSecSuccess,
              let bytes = data as? Data else { return nil }
        return String(data: bytes, encoding: .utf8)
    }

    static func save(_ token: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attrs: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let update = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if update == errSecItemNotFound {
            var add = query
            add.merge(attrs) { _, new in new }
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else {
                throw AgentError.rejected("Gagal menyimpan pairing secara aman.")
            }
        } else if update != errSecSuccess {
            throw AgentError.rejected("Gagal memperbarui pairing.")
        }
    }
}

struct AgentCommand: Decodable {
    let id: String
    let action: String
}

private struct AgentEnvelope: Decodable {
    let ok: Bool
    let deviceSecret: String?
    let command: AgentCommand?
    let pushRegistered: Bool?
    let pushConfigured: Bool?
    let error: String?
}

actor AgentAPI {
    static let shared = AgentAPI()

    private let baseURL: URL = {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "AgentAPIBaseURL") as? String,
              let url = URL(string: raw), url.scheme == "https" else {
            fatalError("AgentAPIBaseURL must be configured to an HTTPS address")
        }
        return url
    }()

    private func request(_ path: String, method: String = "POST", body: [String: String]? = nil,
                         authorized: Bool = true) async throws -> AgentEnvelope {
        var url = baseURL
        for segment in path.split(separator: "/") { url.appendPathComponent(String(segment)) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if authorized {
            guard let token = AgentCredentials.read() else { throw AgentError.notPaired }
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body { req.httpBody = try JSONEncoder().encode(body) }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw AgentError.invalidServerResponse }
        let envelope = try JSONDecoder().decode(AgentEnvelope.self, from: data)
        guard (200..<300).contains(http.statusCode) && envelope.ok else {
            throw AgentError.rejected(envelope.error ?? "Gateway menolak perintah.")
        }
        return envelope
    }

    func enroll(code: String) async throws {
        let payload = try await request("v1/enroll", body: ["code": code], authorized: false)
        guard let secret = payload.deviceSecret else { throw AgentError.invalidServerResponse }
        try AgentCredentials.save(secret)
    }

    func registerPushToken(_ token: String) async throws {
        _ = try await request("v1/device/push-token", body: ["token": token])
    }

    func takeNextCommand() async throws -> String {
        let payload = try await request("v1/device/next")
        return payload.command?.action ?? "none"
    }

    func status() async throws -> (Bool, Bool) {
        let payload = try await request("v1/device/status", method: "GET")
        return (payload.pushRegistered ?? false, payload.pushConfigured ?? false)
    }
}
