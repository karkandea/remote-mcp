import SwiftUI
import UserNotifications

@main
struct IPhoneAgentApp: App {
    @UIApplicationDelegateAdaptor(AgentAppDelegate.self) private var appDelegate
    @State private var agent = AgentViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView(agent: agent)
        }
    }
}

final class AgentAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task {
            do { try await AgentAPI.shared.registerPushToken(token) }
            catch { print("Push registration sync failed") }
        }
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("iOS rejected remote notification registration")
    }
}
