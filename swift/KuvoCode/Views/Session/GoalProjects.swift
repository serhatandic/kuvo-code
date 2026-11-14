import AppKit
import ClientDesign
import ClientSessions
import SwiftUI

/// The projects a proposed goal makes, in its card's Execution settings: a chip each, by name. Its menu says
/// where Start makes it (and that something with files is there already, which never holds Start
/// back), renames it in place or moves it to another folder on its computer, as Mail's address
/// tokens and Finder's names do. Each change goes to the goal's box, which says again where it goes.
struct GoalProjectsRow: View {
    let plan: GoalPlan
    let box: String
    /// Whether a chip's name is being typed, for the card to leave Return and Escape to it.
    @Binding var renames: Bool
    /// The projects as you renamed or moved them, in the plan's order.
    let change: ([String]) -> Void
    @Environment(AppModel.self) private var app
    /// The chip being renamed, by its place, and its name as you type it.
    @State private var renaming: Int?
    @State private var name = ""
    @FocusState private var typing: Bool
    /// The chip whose new folder is being chosen on a machine, in its folder browser.
    @State private var browsing: Int?

    private var onThisMac: Bool { BoxClient.isThisMac(box) }
    private var computer: String { onThisMac ? "This Mac" : app.machines.engine(box)?.machine.name ?? box }

    var body: some View {
        // Its chips at the end, as the other settings' controls; in a narrow card, under its
        // words, wrapping.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                words
                    .frame(minWidth: 180, maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 6) { chips }
                    .fixedSize()
            }
            VStack(alignment: .leading, spacing: 8) {
                words
                Flow(spacing: 6) { chips }
                    .padding(.leading, GoalCardMetrics.markWidth + 12)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 9)
        .frame(minHeight: 44)
        .onChange(of: renaming) { _, now in renames = now != nil }
        .onDisappear { renames = false }
        .sheet(isPresented: Binding(get: { browsing != nil }, set: { if !$0 { browsing = nil } })) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Move \(browsing.map { GoalPlanWords.projectName(plan.projects[$0]) } ?? "") on \(computer)")
                    .font(.title2.weight(.bold))
                    .padding(.horizontal, 28)
                    .padding(.top, 24)
                BoxFolderBrowser(box: box, start: browsing.flatMap(parent), primary: "Move Here") { path, _ in
                    if let index = browsing { move(index, into: path) }
                    browsing = nil
                } cancel: {
                    browsing = nil
                }
            }
            .frame(width: 520, height: 560)
        }
    }

    private var words: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: "folder")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(width: GoalCardMetrics.markWidth)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(plan.projects.count == 1 ? "Project" : "Projects")
                Text("Made on \(computer.lowercasedThisMac)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var chips: some View {
        ForEach(plan.projects.indices, id: \.self) { index in chip(index) }
    }

    private func folder(_ index: Int) -> GoalPlan.Folder? {
        plan.folders.indices.contains(index) ? plan.folders[index] : nil
    }

    @ViewBuilder private func chip(_ index: Int) -> some View {
        let entry = plan.projects[index]
        if renaming == index {
            TextField("Name", text: $name)
                .textFieldStyle(.plain)
                .font(.callout)
                .frame(minWidth: 60)
                .fixedSize()
                .padding(.horizontal, 10)
                .frame(minHeight: 24)
                .background(Capsule().fill(Color.accentColor.opacity(0.14)))
                .focused($typing)
                .onSubmit { rename(index) }
                .onExitCommand { renaming = nil }
                .onChange(of: typing) { _, now in if !now, renaming == index { rename(index) } }
                .onAppear { typing = true }
                .accessibilityLabel("Name of \(GoalPlanWords.projectName(entry))")
        } else {
            NativeMenuButton(opensBelow: true) {
                menu(index)
            } label: {
                ProjectChip(name: GoalPlanWords.projectName(entry), there: folder(index)?.there == true)
            }
            .help(folder(index)?.shown ?? "")
            .accessibilityLabel("Project \(GoalPlanWords.projectName(entry))")
            .accessibilityValue([folder(index)?.shown, folder(index)?.there == true ? "There already, with files" : nil].compactMap { $0 }.joined(separator: ", "))
        }
    }

    private func menu(_ index: Int) -> NSMenu {
        let menu = NSMenu()
        let where_ = folder(index)?.shown ?? "In the projects folder, once you pick it"
        let path = NSMenuItem(title: where_, action: nil, keyEquivalent: "")
        path.isEnabled = false
        menu.addItem(path)
        if folder(index)?.there == true {
            let there = NSMenuItem(title: "", action: nil, keyEquivalent: "")
            there.attributedTitle = NSAttributedString(string: "There already, with files", attributes: [.foregroundColor: NSColor.systemOrange, .font: NSFont.menuFont(ofSize: NSFont.smallSystemFontSize)])
            there.isEnabled = false
            menu.addItem(there)
        }
        menu.addItem(.separator())
        menu.addItem(ActionItem("Rename") {
            name = GoalPlanWords.projectName(plan.projects[index])
            renaming = index
        })
        menu.addItem(ActionItem("Move to…") { choose(index) })
        return menu
    }

    /// The folder its project's folder is in, where the browser opens.
    private func parent(_ index: Int) -> String? {
        folder(index)?.folder.map { ($0 as NSString).deletingLastPathComponent }
    }

    private func choose(_ index: Int) {
        guard onThisMac else {
            browsing = index
            return
        }
        // Once the menu has closed.
        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.prompt = "Move Here"
            panel.message = "Choose the folder \(GoalPlanWords.projectName(plan.projects[index])) goes in."
            if let start = parent(index) { panel.directoryURL = URL(filePath: start) }
            guard panel.runModal() == .OK, let path = panel.url?.path else { return }
            move(index, into: path)
        }
    }

    private func rename(_ index: Int) {
        renaming = nil
        guard plan.projects.indices.contains(index), let renamed = GoalPlanWords.renamed(plan.projects[index], to: name) else { return }
        var projects = plan.projects
        projects[index] = renamed
        change(projects)
    }

    private func move(_ index: Int, into parent: String) {
        guard plan.projects.indices.contains(index), let moved = GoalPlanWords.moved(plan.projects[index], into: parent) else { return }
        var projects = plan.projects
        projects[index] = moved
        change(projects)
    }
}

/// A project's chip: its folder and name, and an orange dot where something with files is there
/// already.
private struct ProjectChip: View {
    let name: String
    let there: Bool
    @State private var isHovering = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let rest = scheme == .dark ? 0.1 : 0.06
        HStack(spacing: 5) {
            Image(systemName: "folder")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            Text(name)
                .lineLimit(1)
            if there {
                Circle()
                    .fill(.orange)
                    .frame(width: 6, height: 6)
            }
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .frame(minHeight: 24)
        .background(Capsule().fill(Color.primary.opacity(isHovering ? rest + 0.04 : rest)))
        .contentShape(Capsule())
        .onHover { isHovering = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovering)
    }
}
