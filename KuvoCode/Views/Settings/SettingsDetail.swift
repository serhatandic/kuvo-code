import ClientDesign
import SwiftUI

/// Where a Settings tab is: on its page, or on something of the page opened in its place (an
/// agent, a server, a sign-in), with the way back. Each tab has one; the page's header shows the
/// way back, and Escape takes it.
@Observable
final class SettingsNavigator {
    struct Detail {
        /// What opened it: one of the page's `settingsDetail`s.
        let owner: UUID
        /// Nil for one that names itself (a sign-in, with the service's mark): just the way back.
        var title: String?
        let back: () -> Void
    }

    /// What's open, the one in view last: one that closes gives way to the one under it, never
    /// to the page while that one's still open.
    private var opened: [Detail] = []

    /// What's in view.
    var detail: Detail? { opened.last }

    func open(_ owner: UUID, title: String?, back: @escaping () -> Void) {
        let detail = Detail(owner: owner, title: title, back: back)
        if let index = opened.firstIndex(where: { $0.owner == owner }) { opened[index] = detail } else { opened.append(detail) }
    }

    /// What's open is called something else now (a new agent, once it's named).
    func retitle(_ owner: UUID, _ title: String) {
        if let index = opened.firstIndex(where: { $0.owner == owner }) { opened[index].title = title }
    }

    func closed(_ owner: UUID) {
        opened.removeAll { $0.owner == owner }
    }

    /// Back to the page; false when it's there already.
    @discardableResult func back() -> Bool {
        guard let detail else { return false }
        detail.back()
        return true
    }
}

extension EnvironmentValues {
    @Entry var settingsNavigator: SettingsNavigator?
    /// The `settingsDetail` something's open in, for it to name itself.
    @Entry var settingsDetailOwner: UUID?
}

extension View {
    /// Opens `item` in the page's place, under the page's name with the way back, rather than in
    /// a sheet over it. The page stays as it was underneath, for coming back; `onDismiss` runs once
    /// the item's closed.
    func settingsDetail<Item: Identifiable, Detail: View>(
        item: Binding<Item?>,
        title: @escaping (Item) -> String?,
        onDismiss: (() -> Void)? = nil,
        @ViewBuilder content: @escaping (Item) -> Detail
    ) -> some View {
        modifier(SettingsDetailModifier(item: item, title: title, onDismiss: onDismiss, detail: content))
    }

    /// The same, for something with no item of its own: open while `isPresented`.
    func settingsDetail<Detail: View>(
        isPresented: Binding<Bool>,
        title: String?,
        onDismiss: (() -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Detail
    ) -> some View {
        settingsDetail(
            item: Binding(get: { isPresented.wrappedValue ? PresentedDetail() : nil }, set: { isPresented.wrappedValue = $0 != nil }),
            title: { _ in title },
            onDismiss: onDismiss
        ) { _ in content() }
    }

    /// Names what's open, as it changes.
    func settingsDetailTitle(_ title: String) -> some View {
        modifier(SettingsDetailTitle(title: title))
    }
}

private struct PresentedDetail: Identifiable {
    var id: Int { 0 }
}

private struct SettingsDetailModifier<Item: Identifiable, Detail: View>: ViewModifier {
    @Binding var item: Item?
    let title: (Item) -> String?
    let onDismiss: (() -> Void)?
    @ViewBuilder let detail: (Item) -> Detail
    @Environment(\.settingsNavigator) private var navigator
    @State private var owner = UUID()

    func body(content: Content) -> some View {
        ZStack(alignment: .top) {
            // Underneath, it takes no keys either (another editor's Return, under this one).
            content
                .opacity(item == nil ? 1 : 0)
                .allowsHitTesting(item == nil)
                .disabled(item != nil)
                .accessibilityHidden(item != nil)
            if let item {
                detail(item)
                    .environment(\.settingsDetailOwner, owner)
                    .transition(.opacity)
            }
        }
        .onChange(of: item?.id, initial: true) { old, _ in
            if let item {
                let binding = $item
                navigator?.open(owner, title: title(item)) { withAnimation(.ui) { binding.wrappedValue = nil } }
            } else if old != nil {
                navigator?.closed(owner)
                onDismiss?()
            }
        }
    }
}

private struct SettingsDetailTitle: ViewModifier {
    let title: String
    @Environment(\.settingsNavigator) private var navigator
    @Environment(\.settingsDetailOwner) private var owner

    func body(content: Content) -> some View {
        content.onChange(of: title, initial: true) { if let owner { navigator?.retitle(owner, title) } }
    }
}

/// What's open in a page's place: its groups, scrolling like the page's, and its buttons along
/// the bottom, lined up with the groups.
struct SettingsDetailPage<Content: View, Footer: View>: View {
    @ViewBuilder var content: Content
    @ViewBuilder var footer: Footer
    @Environment(\.settingsInset) private var inset

    var body: some View {
        VStack(spacing: 0) {
            ScrollingSettingsForm { content }
                .scrollEdgeEffectStyle(.soft, for: .bottom)
            footer
                .padding(.horizontal, inset)
                .padding(.top, 10)
                .padding(.bottom, 20)
        }
    }
}

/// The buttons along the bottom of an editor in the window (a bot, a project, an agent): its
/// Delete and the like at the leading edge; Cancel and what it does at the trailing one. Escape is
/// the way back, wherever it's open, so Cancel takes no key of its own.
struct EditorFooter<Leading: View>: View {
    /// What it does ("Create Agent", "Save", "Done").
    let primary: String
    var canDoPrimary = true
    let onPrimary: () -> Void
    /// What it does can't be undone (deleting): red rather than the accent.
    var isDestructive = false
    /// Nil for no Cancel: editing something that's saved as you go, Done is the way back.
    var onCancel: (() -> Void)?
    /// Escape presses Cancel: in an editor in the window. (In Settings, Escape is the page's way
    /// back, which is Cancel too.)
    var cancelsOnEscape = false
    /// Something under way, in its words, beside the spinner.
    var working: String?
    @ViewBuilder var leading: Leading

    var body: some View {
        HStack(spacing: 10) {
            leading
            if let working {
                Spinner(size: 16)
                Text(working)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if let onCancel {
                if cancelsOnEscape {
                    Button("Cancel", role: .cancel, action: onCancel)
                        .keyboardShortcut(.cancelAction)
                        .buttonStyle(.glass)
                } else {
                    Button("Cancel", role: .cancel, action: onCancel)
                        .buttonStyle(.glass)
                }
            }
            Button(primary, role: isDestructive ? .destructive : nil, action: onPrimary)
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.glassProminent)
                .tint(isDestructive ? .red : nil)
                .disabled(!canDoPrimary || working != nil)
        }
        .controlSize(.large)
    }
}

extension EditorFooter where Leading == EmptyView {
    init(primary: String, canDoPrimary: Bool = true, onPrimary: @escaping () -> Void, isDestructive: Bool = false, onCancel: (() -> Void)? = nil, cancelsOnEscape: Bool = false, working: String? = nil) {
        self.init(primary: primary, canDoPrimary: canDoPrimary, onPrimary: onPrimary, isDestructive: isDestructive, onCancel: onCancel, cancelsOnEscape: cancelsOnEscape, working: working) { EmptyView() }
    }
}

/// A Delete or Remove at an editor footer's leading edge.
struct EditorFooterRemove: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(title, role: .destructive, action: action)
            .buttonStyle(.glass)
    }
}

/// Something an editor in the window opened in its place (Add a Machine, from a new bot): its name
/// under the way back to the editor, in the editor's column.
struct EditorDetail<Content: View>: View {
    /// What the way back goes to ("New Bot").
    let back: String
    let title: String
    let onBack: () -> Void
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Button(action: onBack) {
                    Label(back, systemImage: "chevron.backward")
                        .font(.system(size: 14, weight: .medium))
                }
                .buttonStyle(TextButtonStyle(outset: true))
                .help("Back to \(back) (Esc)")
                Text(title)
                    .font(.system(size: 26, weight: .bold))
                content
                    .padding(.top, 6)
            }
            .frame(maxWidth: 600, alignment: .leading)
            .padding(.horizontal, Metrics.gutter + 8)
            .padding(.top, 24)
            .padding(.bottom, 20)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .fadingScrollEdges()
    }
}
