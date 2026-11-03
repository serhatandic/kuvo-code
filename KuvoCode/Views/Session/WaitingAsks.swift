import ClientDesign
import ClientSandbox
import ClientSessions
import ClientVault
import OpenCodeKit
import SwiftUI

/// What waits on you in a conversation: its agent's permissions and questions, a browser's
/// sign-ins and codes, what it asks of the vault and to run outside the sandbox, a bot's work
/// asks and its goal's plan. One at a time takes the composer's place, as in Claude Code and
/// Codex, so nothing covers the conversation; the draft comes back once they're answered.
enum WaitingAsk: Identifiable {
    case permission(PermissionRequest)
    case form(FormRequest)
    case browser(BrowserAsks.Ask)
    case vault(VaultAsk, box: String)
    case sandbox(SandboxAsk, box: String)
    case work(WorkAsk, box: String)
    case plan(GoalPlan, box: String)

    var id: String {
        switch self {
        case .permission(let request): request.id
        case .form(let form): form.id
        case .browser(let ask): "browser.\(ask.id)"
        case .vault(let asked, _): "vault.\(asked.id)"
        case .sandbox(let asked, _): "sandbox.\(asked.id)"
        case .work(let ask, _): "work.\(ask.id)"
        case .plan(let plan, _): "plan.\(plan.id)"
        }
    }
}

/// Which of them shows: the one you went to while it waits, else the first.
struct WaitingAskPosition: Equatable {
    let index: Int
    let count: Int

    init?(ids: [String], picked: String?) {
        guard !ids.isEmpty else { return nil }
        index = picked.flatMap(ids.firstIndex(of:)) ?? 0
        count = ids.count
    }

    /// "2 of 3", where more than one waits.
    var words: String? { count > 1 ? "\(index + 1) of \(count)" : nil }
}

/// The ask in the composer's place: "1 of 3" with the way to the others over it, where more wait.
struct AskInComposer<Content: View>: View {
    let position: WaitingAskPosition
    let go: (Int) -> Void
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let words = position.words {
                HStack(spacing: 4) {
                    Text(words)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                    Spacer()
                    Button { go(position.index - 1) } label: { Image(systemName: "chevron.left") }
                        .disabled(position.index == 0)
                        .accessibilityLabel("Previous Ask")
                    Button { go(position.index + 1) } label: { Image(systemName: "chevron.right") }
                        .disabled(position.index == position.count - 1)
                        .accessibilityLabel("Next Ask")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .padding(.horizontal, 16)
                .padding(.top, 10)
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Ask \(words)")
            }
            content
        }
    }
}
