import AppKit
import SwiftUI

/// A bar at the top of the panel while an agent runs in a terminal: it can't use the panel's
/// browser or show you files until it's given Kuvo Code's tools, which it does through an MCP server
/// of its own settings. Closing it keeps it away.
struct TerminalToolsNotice: View {
    let close: () -> Void
    @State private var showsSetup = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text("The agent in this terminal can't use the browser or show you files here until you give it Kuvo Code's tools.")
                .font(.callout)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("How") { showsSetup.toggle() }
                .buttonStyle(.link)
                .popover(isPresented: $showsSetup, arrowEdge: .bottom) { TerminalToolsSetup() }
            Button(action: close) {
                Label("Close", systemImage: "xmark")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(PanelIconStyle())
            .help("Close")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.orange.opacity(0.12))
    }
}

/// What to add to the agent's settings: the app's MCP server over stdio, which every terminal here
/// can reach through its environment.
private struct TerminalToolsSetup: View {
    static let entry = """
    {
      "mcpServers": {
        "kuvo": {
          "type": "stdio",
          "command": "sh",
          "args": ["${KUVO_MCP_SCRIPT}"],
          "env": {
            "KUVO_MCP_URL": "${KUVO_MCP_URL}",
            "KUVO_MCP_TOKEN": "${KUVO_MCP_TOKEN}"
          }
        }
      }
    }
    """

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Add Kuvo Code's tools to your agent")
                .font(.headline)
            Text("Terminals here have KUVO_MCP_URL, KUVO_MCP_TOKEN and KUVO_MCP_SCRIPT in their environment (they change each time Kuvo Code starts). Add this stdio MCP server to the agent's MCP settings, then start the agent again from a terminal here. For omp, that's ~/.omp/agent/mcp.json, or .omp/mcp.json in the project.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(Self.entry)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 6))
            Text("It gives the agent the browser tools and show_in_panel. If the agent doesn't expand ${…} in its settings, write the three values in by hand.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(Self.entry, forType: .string)
            }
        }
        .padding(14)
        .frame(width: 400)
    }
}
