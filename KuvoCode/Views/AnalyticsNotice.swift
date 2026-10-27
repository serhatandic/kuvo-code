import ClientDesign
import SwiftUI

/// A one-time note at the bottom of the sidebar: Kuvo Code shares anonymous usage, what that
/// means, and a way to turn it off (also in Settings › General).
struct AnalyticsNotice: View {
    @State private var analytics = Analytics.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Help improve Kuvo Code")
                .font(.system(size: 13, weight: .semibold))
            Text("Kuvo Code shares anonymous usage: which features you use, how often, what kind of trouble you run into, and the app and macOS versions. Never your code, prompts, files or accounts.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Link("What's Sent", destination: URL(string: "https://www.kuvo.run/code/docs/privacy/")!)
                    .font(.system(size: 12))
                Spacer()
                Button("Turn Off") {
                    withAnimation(.ui) {
                        analytics.isEnabled = false
                        analytics.noticeShown = true
                    }
                }
                Button("OK") {
                    withAnimation(.ui) { analytics.noticeShown = true }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
            }
            .controlSize(.small)
            .padding(.top, 4)
        }
        .padding(12)
        .background(.quaternary.opacity(0.6), in: .rect(cornerRadius: 12))
    }
}
