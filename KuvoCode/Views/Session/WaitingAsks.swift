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

/// The ask in the composer's place: "1 of 3" with the way to the others over it, where more wait.
/// Which shows is KuvoClient's `AskPlace`, as on the phone.
struct AskInComposer<Content: View>: View {
    let place: AskPlace
    let go: (Int) -> Void
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let words = place.words, let index = place.index {
                HStack(spacing: 4) {
                    Text(words)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                    Spacer()
                    Button { go(index - 1) } label: { Image(systemName: "chevron.left") }
                        .disabled(index == 0)
                        .accessibilityLabel("Previous Ask")
                    Button { go(index + 1) } label: { Image(systemName: "chevron.right") }
                        .disabled(index == place.waiting.count - 1)
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
        .background(AskArea())
    }
}

/// Where an ask has the composer's place, for the composer back to tell the ask's own line
/// (which goes with it) from another field that has the keyboard.
struct AskArea: NSViewRepresentable {
    final class Marker: NSView {
        static let all = NSHashTable<Marker>.weakObjects()
    }

    func makeNSView(context: Context) -> Marker {
        let marker = Marker()
        Marker.all.add(marker)
        return marker
    }

    func updateNSView(_ view: Marker, context: Context) {}

    /// Whether `view` is in an ask's place in its window.
    static func holds(_ view: NSView) -> Bool {
        guard let window = view.window else { return false }
        let frame = view.convert(view.bounds, to: nil)
        return Marker.all.allObjects.contains { $0.window === window && $0.convert($0.bounds, to: nil).intersects(frame) }
    }
}
