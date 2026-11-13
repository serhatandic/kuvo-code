import SwiftUI

/// A local estimation preference, separate from the model used by the coding client. While the
/// host prices Codex's history itself (`HostHistory`, fork addition), it's the host's setting: the
/// picker shows and changes the host's choice, from the models the host offers.
struct CodexPricingSection: View {
    let providerIDs: [String]

    @Environment(WidgetDataStore.self) private var dataStore
    @AppStorage(DensitySetting.key) private var density = DensitySetting.regular
    @AppStorage(CodexFallbackModelSetting.key) private var selectedModel = CodexFallbackModelSetting.none
    @State private var options: [PricingFallbackOption] = []
    @State private var isLoading = true
    @State private var isApplying = false
    @State private var refreshState = CodexFallbackPricingRefreshState()
    @State private var needsRecalculation = false
    /// Why the host didn't take the last choice.
    @State private var applyFailed: HostHistory.CodexFallbackOutcome?

    var body: some View {
        VStack(alignment: .leading, spacing: density.headerToCardSpacing) {
            Text("Cost Estimates")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Text("Fallback Model")
                    Spacer(minLength: 8)
                    Picker("Fallback Model", selection: selection) {
                        Text("None").tag(CodexFallbackModelSetting.none)
                        if selectionUnavailable {
                            Text("Unavailable Model").tag(shownModel)
                        }
                        ForEach(shownOptions) { option in
                            Text(option.title).tag(option.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .disabled(activityLabel != nil)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, density.controlRowPadding)
                if let activityLabel {
                    HStack(spacing: 6) {
                        MotionAwareProgressView(controlSize: .mini)
                            .accessibilityHidden(true)
                        Text(activityLabel)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityElement(children: .combine)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                }
                // (The host's own logs only: each of your machines prices its own, with none for now.)
                Text(host == nil ? "Estimate costs for models that don't have known pricing." : "Estimate costs for models that don't have known pricing, in this Mac's Codex use. Your machines don't use it yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 10)
                if let applyFailed, host != nil {
                    Text(Self.notice(applyFailed))
                        .font(.caption)
                        .foregroundStyle(Theme.notice)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 10)
                }
                if selectionUnavailable && (host != nil || !isLoading) {
                    Text("This model's pricing is unavailable. Choose another model or None.")
                        .font(.caption)
                        .foregroundStyle(Theme.notice)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 10)
                }
            }
            .cardSurface()
        }
        .task {
            options = await ModelPricingStore.shared.current().fallbackOptions(for: "codex")
            guard !Task.isCancelled else { return }
            isLoading = false
            recalculateIfNeeded()
            await ModelPricingStore.shared.refreshNow()
            guard !Task.isCancelled else { return }
            options = await ModelPricingStore.shared.current().fallbackOptions(for: "codex")
            recalculateIfNeeded()
        }
        .onChange(of: selectedModel) {
            guard !isLoading, host == nil else { return }
            recalculateIfNeeded()
        }
    }

    /// The host's setting, while it prices Codex's history.
    private var host: HostHistory.CodexFallback? { HostHistory.shared.codexFallback }

    private var shownModel: String { host.map { $0.model ?? CodexFallbackModelSetting.none } ?? selectedModel }

    private var shownOptions: [PricingFallbackOption] {
        guard let host else { return options }
        return host.choices.map { PricingFallbackOption(id: $0, title: PricingFallbackOption.title(for: $0)) }
    }

    private var selection: Binding<String> {
        Binding(get: { shownModel }, set: { model in
            guard host != nil else {
                selectedModel = model
                return
            }
            applyOnHost(model)
        })
    }

    /// The host prices with it, then the cards take what it worked out.
    private func applyOnHost(_ model: String) {
        guard model != shownModel, !isApplying, let set = HostHistory.shared.setCodexFallback else { return }
        isApplying = true
        applyFailed = nil
        Task {
            defer { isApplying = false }
            let outcome = await set(model.isEmpty ? nil : model)
            guard outcome == .applied else {
                applyFailed = outcome
                return
            }
            for providerID in providerIDs {
                dataStore.clearFailureBackoff(for: providerID)
                await dataStore.refresh(providerID: providerID, force: true)
            }
        }
    }

    private func recalculateIfNeeded() {
        // (The host's choice: it works its estimates out itself.)
        guard host == nil else { return }
        guard refreshState.update(model: selectedModel, options: options) else { return }
        needsRecalculation = true
        guard !isApplying else { return }
        isApplying = true
        Task {
            defer { isApplying = false }
            while needsRecalculation {
                needsRecalculation = false
                // A refresh already in flight may have captured the previous preference.
                // Wait for it before requesting a new pass instead of having that pass skipped.
                while providerIDs.contains(where: dataStore.refreshingProviderIDs.contains) {
                    try? await Task.sleep(for: .milliseconds(100))
                    guard !Task.isCancelled else { return }
                }
                for providerID in providerIDs {
                    dataStore.clearFailureBackoff(for: providerID)
                    await dataStore.refresh(providerID: providerID, force: true)
                }
            }
        }
    }

    /// Why the host didn't take it: its own words when it refused.
    private static func notice(_ outcome: HostHistory.CodexFallbackOutcome) -> String {
        if case .refused(let message) = outcome { return message }
        return "Couldn't change it: Kuvo Code's background service didn't answer. Try again."
    }

    private var selectionUnavailable: Bool {
        !shownModel.isEmpty && !shownOptions.contains { $0.id == shownModel }
    }

    private var activityLabel: String? {
        if isLoading && host == nil { return "Loading Models…" }
        if isApplying { return "Recalculating Estimates…" }
        return nil
    }
}
