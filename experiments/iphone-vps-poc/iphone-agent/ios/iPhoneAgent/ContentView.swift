import SwiftUI

struct ContentView: View {
    @Bindable var agent: AgentViewModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Image(systemName: "iphone.radiowaves.left.and.right")
                        .font(.system(size: 36, weight: .regular))
                        .foregroundStyle(.blue)
                        .frame(width: 64, height: 64)
                        .background(.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 20))
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("iPhone Agent")
                            .font(.largeTitle.bold())
                        Text("Jalankan perintah yang didukung iOS lewat notifikasi dan Shortcuts.")
                            .font(.body)
                            .foregroundStyle(.secondary)
                    }

                    HStack(spacing: 10) {
                        Image(systemName: agent.paired ? "checkmark.circle.fill" : "circle.dotted")
                            .foregroundStyle(agent.paired ? .green : .orange)
                        Text(agent.paired ? "Terhubung ke gateway" : "Belum terhubung")
                            .font(.subheadline.weight(.medium))
                        Spacer()
                    }
                    .padding(16)
                    .background(.white, in: RoundedRectangle(cornerRadius: 16))

                    if !agent.paired {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("Hubungkan iPhone")
                                .font(.headline)
                            TextField("Kode pairing 8 digit", text: $agent.code)
                                .keyboardType(.numberPad)
                                .textContentType(.oneTimeCode)
                                .textFieldStyle(.roundedBorder)
                                .accessibilityLabel("Kode pairing delapan digit")
                            Button {
                                Task { await agent.pair() }
                            } label: {
                                HStack { Spacer(); Text("Hubungkan"); Spacer() }
                                    .padding(.vertical, 10)
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(agent.busy || agent.code.count != 8)
                        }
                        .padding(20)
                        .background(.white, in: RoundedRectangle(cornerRadius: 20))
                    } else {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("Aktifkan perintah")
                                .font(.headline)
                            Button {
                                Task { await agent.enableNotifications() }
                            } label: {
                                Label("Izinkan Notifikasi", systemImage: "bell.badge")
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 9)
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(agent.busy)

                            Button {
                                Task { await agent.sendTestNotification() }
                            } label: {
                                Label("Kirim Notifikasi Tes", systemImage: "paperplane")
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 9)
                            }
                            .buttonStyle(.bordered)
                            .disabled(agent.busy || !agent.notificationAllowed)
                        }
                        .padding(20)
                        .background(.white, in: RoundedRectangle(cornerRadius: 20))

                        VStack(alignment: .leading, spacing: 12) {
                            Text("Sekali saja di Shortcuts")
                                .font(.headline)
                            Text("1. Buat Automation saat notifikasi dari iPhone Agent diterima.")
                            Text("2. Jalankan aksi ‘Fetch Remote Command’ dari iPhone Agent.")
                            Text("3. Gunakan ‘If’ untuk memetakan hasil ke aksi ‘Open App’ atau ‘Play/Pause’.")
                            Text("iOS belum mengizinkan aplikasi ini mengetuk atau menggesek aplikasi lain secara bebas.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        .font(.subheadline)
                        .padding(20)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.white, in: RoundedRectangle(cornerRadius: 20))
                    }

                    if !agent.feedback.isEmpty {
                        Text(agent.feedback)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                }
                .padding(20)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Agent")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
