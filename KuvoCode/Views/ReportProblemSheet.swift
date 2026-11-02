import OpenCodeKit
import SwiftUI

/// Help › Report a Problem…: what happened, in your words, and the versions in use, which open as
/// a new issue on Kuvo Code's GitHub page, filled in for you to read over and post there. It says
/// plainly that issues are public, and shows everything that goes with it: nothing else does.
struct ReportProblemSheet: View {
    let close: () -> Void
    @State private var description = DemoTyped.problem
    @FocusState private var isFocused: Bool

    /// What's in use here, as the issue says it.
    static var versions: [(label: String, value: String)] {
        let os = ProcessInfo.processInfo.operatingSystemVersion
        return [
            ("Kuvo Code", "\(AppInfo.version) (\(AppInfo.build))"),
            ("macOS", "\(os.majorVersion).\(os.minorVersion)" + (os.patchVersion > 0 ? ".\(os.patchVersion)" : "")),
            ("Chip", chip),
            ("Engine", OpenCodeEngine.version),
        ]
    }

    /// The Mac's chip by its name, and the model's code after it, which tells an Air from a Pro
    /// ("Apple M2 (Mac14,7)").
    private static var chip: String {
        let name = sysctl("machdep.cpu.brand_string") ?? "Apple silicon"
        return sysctl("hw.model").map { "\(name) (\($0))" } ?? name
    }

    private static func sysctl(_ key: String) -> String? {
        var size = 0
        guard sysctlbyname(key, nil, &size, nil, 0) == 0, size > 1 else { return nil }
        var value = [CChar](repeating: 0, count: size)
        guard sysctlbyname(key, &value, &size, nil, 0) == 0 else { return nil }
        let text = String(decoding: value.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return text.isEmpty ? nil : text
    }

    private var report: ProblemReport { ProblemReport(description: description, versions: Self.versions) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Report a Problem")
                    .font(.title2.weight(.bold))
                Spacer(minLength: 12)
                Button("Close", systemImage: "xmark", action: close)
                    .buttonStyle(CardActionStyle())
                    .help("Close")
            }
            .padding(.horizontal, 28)
            .padding(.top, 24)
            .padding(.bottom, 14)
            VStack(alignment: .leading, spacing: 20) {
                Label {
                    Text(ProblemReport.publicNote)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "globe")
                        .foregroundStyle(.secondary)
                }
                .font(.callout)
                section("What happened?") {
                    WellGroup(isFocused: isFocused) {
                        TextField("What happened?", text: $description, prompt: Text("What you did, what you expected, and what happened instead"), axis: .vertical)
                            .textFieldStyle(.plain)
                            .lineLimit(4...10)
                            .focused($isFocused)
                            .padding(12)
                            .accessibilityLabel("What happened?")
                    }
                }
                section("Included with the report") {
                    WellGroup {
                        ForEach(Array(Self.versions.enumerated()), id: \.offset) { index, version in
                            if index > 0 { WellDivider() }
                            HStack {
                                Text(version.label)
                                    .foregroundStyle(.secondary)
                                Spacer(minLength: 12)
                                Text(version.value)
                                    .monospacedDigit()
                                    .textSelection(.enabled)
                            }
                            .padding(.horizontal, 12)
                            .frame(minHeight: 36)
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
            .padding(.horizontal, 28)
            // The note at the top says what happens there.
            EditorFooter(primary: "Open on GitHub", canDoPrimary: report.canSend, onPrimary: open, onCancel: close, cancelsOnEscape: true)
            .padding(.horizontal, 28)
            .padding(.top, 22)
            .padding(.bottom, 24)
        }
        .frame(width: 520)
        .onAppear { isFocused = true }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            content()
        }
    }

    private func open() {
        NSWorkspace.shared.open(report.issueURL)
        close()
    }
}
