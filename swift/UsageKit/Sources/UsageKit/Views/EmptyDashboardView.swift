import AppKit
import SwiftUI

struct EmptyDashboardView: View {
    let chooseProviders: () -> Void
    @Environment(AppContainer.self) private var container

    /// Fork addition: nothing to follow until an account is connected in the host.
    private var hasNothingConnected: Bool {
        container.availability.connected?.isEmpty == true
    }

    var body: some View {
        VStack(spacing: 0) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: 56, height: 56)
                .padding(.bottom, 14)
                .accessibilityHidden(true)

            Text("Make It Yours")
                .font(.system(size: 19, weight: .semibold))
                .padding(.bottom, 7)
            Text(hasNothingConnected
                 ? "Connect an account in \(HostApp.name), like GitHub Copilot or ChatGPT, and its limits and spend show up here."
                 : "Bring your AI usage, limits, and spend together. Choose what goes on your dashboard.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 230)
                .padding(.bottom, 20)

            Button(action: hasNothingConnected ? { UsageMenuBar.openHostApp() } : chooseProviders) {
                Label(hasNothingConnected ? "Open \(HostApp.name)" : "Choose Providers", systemImage: hasNothingConnected ? "arrow.up.forward.app" : "plus")
                    .font(.system(size: 12, weight: .semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 3)
            }
            .onboardingPrimaryAction()
            .controlSize(.large)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .padding(.top, 22)
        .padding(.bottom, 26)
    }
}
