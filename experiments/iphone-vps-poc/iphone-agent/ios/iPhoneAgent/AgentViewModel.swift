import Foundation
import Observation
import UIKit
import UserNotifications

@Observable
@MainActor
final class AgentViewModel {
    var code = ""
    var paired = AgentCredentials.read() != nil
    var busy = false
    var notificationAllowed = false
    var feedback = ""

    func pair() async {
        guard code.count == 8, code.allSatisfy(\.isNumber) else {
            feedback = "Masukkan 8 digit kode pairing."
            return
        }
        busy = true
        defer { busy = false }
        do {
            try await AgentAPI.shared.enroll(code: code)
            paired = true
            code = ""
            feedback = "iPhone terhubung. Aktifkan notifikasi untuk melanjutkan."
        } catch { feedback = error.localizedDescription }
    }

    func enableNotifications() async {
        busy = true
        defer { busy = false }
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .badge, .sound])
            notificationAllowed = granted
            if granted {
                UIApplication.shared.registerForRemoteNotifications()
                feedback = "Notifikasi diizinkan. Lanjutkan pengaturan Shortcuts."
            } else {
                feedback = "Izinkan notifikasi untuk iPhone Agent di Pengaturan."
            }
        } catch { feedback = error.localizedDescription }
    }

    func sendTestNotification() async {
        do {
            let content = UNMutableNotificationContent()
            content.title = "iPhone Agent"
            content.body = "Tes pemicu Shortcuts — tanpa mengubah aplikasi lain"
            content.sound = .default
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 3, repeats: false)
            try await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: trigger))
            feedback = "Notifikasi tes dijadwalkan."
        } catch { feedback = error.localizedDescription }
    }
}
