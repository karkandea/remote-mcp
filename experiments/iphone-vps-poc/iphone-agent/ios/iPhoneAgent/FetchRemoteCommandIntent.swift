import AppIntents

/// Use in a user-created notification automation. This only fetches an allowlisted
/// command; the Shortcut itself decides what system action to run.
struct FetchRemoteCommandIntent: AppIntent {
    static var title: LocalizedStringResource = "Fetch Remote Command"
    static var description = IntentDescription("Retrieve one pending safe command from your private iPhone gateway.")
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let action = try await AgentAPI.shared.takeNextCommand()
        return .result(value: action)
    }
}

struct AgentShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: FetchRemoteCommandIntent(),
            phrases: ["Fetch command from \(.applicationName)"],
            shortTitle: "Fetch Command",
            systemImageName: "arrow.down.circle"
        )
    }
}
