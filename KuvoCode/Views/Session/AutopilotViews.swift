import AppKit
import ClientDesign
import ClientSessions
import SwiftUI

extension EnvironmentValues {
    /// The calls Autopilot made in this conversation (or, a subagent's, the one it works for), by
    /// the tool call that asked.
    @Entry var autopilotCalls: [String: [AutopilotShown.Call]] = [:]
    /// Those its subagents made, by the subagent's session: shown at its row.
    @Entry var autopilotCallsOfSubagents: [String: [AutopilotShown.Call]] = [:]
    /// Your choice on one of them.
    @Entry var chooseOnAutopilot: (String, AutopilotShown.Call) -> Void = { _, _ in }
    /// Its steps' line shows their decided calls already: the steps themselves show as asked.
    @Entry var autopilotCallsShownAbove = false
}

/// Where a question would have waited, on Autopilot: the call it made and why, in the place it was
/// asked ("Went with Warm and roasty · best reviewed"), with Change to pick another. Once you have,
/// yours.
struct DecidedLine: View {
    let call: AutopilotShown.Call
    /// Away from the step that asked (a goal's list): the question comes first.
    var saysQuestion = false
    @Environment(\.chooseOnAutopilot) private var choose

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: call.changed ? "person.fill" : AutopilotShown.symbol)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            line
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Spacer(minLength: 8)
            if let options = call.options, options.count > 1 {
                NativeMenuButton(name: "decided", opensBelow: true, menu: { menu(options) }) {
                    HStack(spacing: 4) {
                        Text("Change")
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .accessibilityHidden(true)
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .hoverHighlight(in: Capsule(), mutesInk: true)
                }
                .help("Pick another: the agent goes that way from here")
                .accessibilityLabel("Change")
                .accessibilityHint("Picks another choice for this call")
            }
        }
        .font(.callout)
        .help(call.text)
        .accessibilityElement(children: .contain)
    }

    private var line: Text {
        let asked = saysQuestion ? Text(call.text + "  ").foregroundStyle(.tertiary) : Text("")
        if call.changed {
            return Text("\(asked)You picked \(Text(call.current).fontWeight(.medium))\(Text(", not \(call.choice)").foregroundStyle(.tertiary))").foregroundStyle(.secondary)
        }
        return Text("\(asked)Went with \(Text(call.choice).fontWeight(.medium).foregroundStyle(.primary))\(Text(call.why.map { " · " + $0 } ?? ""))").foregroundStyle(.secondary)
    }

    private func menu(_ options: [String]) -> NSMenu {
        let menu = NSMenu()
        menu.addItem(.sectionHeader(title: call.text))
        var checked: Set<NSMenuItem> = []
        for option in options {
            let item = ActionItem(option) { [call, choose] in
                if let choice = call.picking(option) { choose(choice, call) }
            }
            menu.addItem(item)
            if call.isChosen(option) { checked.insert(item) }
        }
        menu.checksOnTrailingSide(checked)
        return menu
    }
}

/// A goal's calls, the latest first, in the goal bar under what waits for you: a few, and the rest
/// on Show More. While it runs, each can be changed.
struct GoalDecidedRows: View {
    let plan: GoalPlan
    /// How many show until Show More.
    static let few = 3
    @State private var showsAll = false

    /// The calls it shows, as `DecidedLine`s.
    static func calls(_ plan: GoalPlan, all: Bool = false) -> [AutopilotShown.Call] {
        let latest = plan.decided.reversed().map { AutopilotShown.Call(goal: $0, changeable: plan.state == .running) }
        return all ? latest : Array(latest.prefix(few))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Self.calls(plan, all: showsAll)) { DecidedLine(call: $0, saysQuestion: true) }
            if plan.decided.count > Self.few {
                Button(showsAll ? "Show Less" : "Show More") {
                    withAnimation(.ui) { showsAll.toggle() }
                }
                .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
                .foregroundStyle(.tint)
                .font(.system(size: 12, weight: .medium))
            }
        }
    }
}
