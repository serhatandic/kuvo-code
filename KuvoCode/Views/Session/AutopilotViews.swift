import AppKit
import SwiftUI

extension EnvironmentValues {
    /// The calls Autopilot made in this conversation (or, a subagent's, the one it works for), by
    /// the tool call that asked.
    @Entry var autopilotCalls: [String: AutopilotShown.Call] = [:]
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
        if call.changed {
            return Text("You picked \(Text(call.current).fontWeight(.medium))\(Text(", not \(call.choice)").foregroundStyle(.tertiary))").foregroundStyle(.secondary)
        }
        return Text("Went with \(Text(call.choice).fontWeight(.medium).foregroundStyle(.primary))\(Text(call.why.map { " · " + $0 } ?? ""))").foregroundStyle(.secondary)
    }

    private func menu(_ options: [String]) -> NSMenu {
        let menu = NSMenu()
        menu.addItem(.sectionHeader(title: call.text))
        var checked: Set<NSMenuItem> = []
        for option in options {
            let item = ActionItem(option) { [call, choose] in choose(option, call) }
            menu.addItem(item)
            if option == call.current { checked.insert(item) }
        }
        menu.checksOnTrailingSide(checked)
        return menu
    }
}
