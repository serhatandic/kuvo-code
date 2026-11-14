import Foundation

@MainActor
final class GrokProvider: ProviderRuntime {
    let provider = Provider(
        id: "grok",
        displayName: "Grok",
        icon: .providerMark("grok"),
        links: [
            .init(label: "Usage", url: "https://grok.com/?_s=usage")
        ]
    )

    let authStore: GrokAuthStore
    let usageClient: GrokUsageClient
    let logUsageScanner: GrokLogUsageScanner
    let now: @Sendable () -> Date
    let pricing: @Sendable () async -> ModelPricing

    init(
        authStore: GrokAuthStore = GrokAuthStore(),
        usageClient: GrokUsageClient = GrokUsageClient(),
        logUsageScanner: GrokLogUsageScanner = GrokLogUsageScanner(),
        now: @escaping @Sendable () -> Date = Date.init,
        pricing: @escaping @Sendable () async -> ModelPricing = { await ModelPricingStore.shared.current() }
    ) {
        self.authStore = authStore
        self.usageClient = usageClient
        self.logUsageScanner = logUsageScanner
        self.now = now
        self.pricing = pricing
    }

    var widgetDescriptors: [WidgetDescriptor] {
        [
            .percent(id: "grok.weekly", provider: provider, title: "Weekly", metricLabel: "Weekly limit")
                .exportingLimit("weekly", unit: "percent"),
            .badge(id: "grok.payAsYouGo", provider: provider, title: "Extra Usage", metricLabel: "Pay as you go"),
            .usageTrend(provider: provider)
                .exportingHistory(
                    scope: .machineLocal,
                    estimatedCost: true,
                    sourceNote: "From your Grok logs (estimated)"
                )
            // Local spend tiles from completed turns in the Grok CLI's session transcripts.
        ] + WidgetDescriptor.spendTiles(provider: provider)
    }

    func hasLocalCredentials() async -> Bool {
        // Same source as `refresh()`: ~/.grok/auth.json with at least one keyed entry, or the host's
        // sign-in.
        await loadOffMainActor { [authStore] in
            ((try? authStore.loadAuthCandidates()) ?? []).isEmpty == false
        }
    }

    func refresh() async -> ProviderSnapshot {
        do {
            return try await loadAndProbe()
        } catch {
            return ProviderSnapshot.error(provider: provider, error: error)
        }
    }

    private func loadAndProbe() async throws -> ProviderSnapshot {
        let candidates = try authStore.loadAuthCandidates()
        var sawExpiredCandidate = false
        var sawExpiredHost = false
        // A login the server turns away doesn't hide the next one (fork change): an old Grok CLI
        // login, say, after the host's sign-in.
        var rejected: GrokAuthError?
        // With the host's sign-in, the Grok CLI's login is only read, never renewed or saved: that
        // belongs to the CLI (fork change).
        let renews = !candidates.contains { $0.entryKey == GrokAuthStore.hostEntryKey }

        for var state in candidates {
            do {
                // The host's: used as it is while it lasts, never refreshed here.
                if state.entryKey == GrokAuthStore.hostEntryKey {
                    if authStore.isExpired(entry: state.entry, token: state.token) {
                        // The engine may have renewed it since the host last said.
                        await authStore.rereadHost()
                        guard let current = authStore.hostCandidate(),
                              !authStore.isExpired(entry: current.entry, token: current.token) else {
                            sawExpiredHost = true
                            continue
                        }
                        state = current
                    }
                    return try await probe(state: &state, accessToken: state.token, renews: false)
                }
                if authStore.needsRefresh(entry: state.entry, token: state.token) {
                    if renews, let refreshed = await refreshAccessToken(state: &state) {
                        return try await probe(state: &state, accessToken: refreshed, renews: renews)
                    }
                    if authStore.isExpired(entry: state.entry, token: state.token) {
                        sawExpiredCandidate = true
                        continue
                    }
                }
                return try await probe(state: &state, accessToken: state.token, renews: renews)
            } catch let error as GrokAuthError where error == .expired || error == .hostExpired {
                rejected = rejected ?? error
            }
        }

        if let rejected {
            throw rejected
        }
        if sawExpiredHost {
            throw GrokAuthError.hostExpired
        }
        if sawExpiredCandidate {
            throw GrokAuthError.expired
        }
        throw GrokAuthError.invalidAuth
    }

    /// `renews`: whether a token the server turns away may be refreshed and saved.
    private func probe(state: inout GrokAuthState, accessToken: String, renews: Bool) async throws -> ProviderSnapshot {
        // The weekly shared-pool meter and pay-as-you-go badge come from the billing endpoint with
        // `?format=credits` — the call the Grok CLI itself makes. This is the provider's primary
        // remote fetch; a failure here fails the provider like any other usage call, except the
        // documented team-principal 412 which has no weekly pool to show.
        let creditsResponse = try await fetchCreditsConfigWithRetry(accessToken: accessToken, state: &state, renews: renews)
        var mapped: GrokMappedUsage
        var warning: String?
        if GrokUsageMapper.isTeamBillingUnavailable(creditsResponse) {
            // Same shape as Claude's missing-profile-scope path: log it, keep the snapshot
            // successful, and let local spend tiles load under an amber header warning.
            AppLog.warn(
                LogTag.plugin("grok"),
                "credits config unavailable: team principal has no personal team; weekly/pay-as-you-go omitted, local spend still loads"
            )
            mapped = GrokMappedUsage(lines: [])
            warning = GrokUsageMapper.teamBillingUnavailableWarning
        } else {
            mapped = try GrokUsageMapper.mapCreditsConfig(creditsResponse)
        }

        let plan = await fetchPlanName(accessToken: state.token)

        // Local spend tiles from completed session turns. Recorded Grok costs win when available;
        // older turns without a carried cost use the shared pricing store. The host's boxes state
        // Grok's history themselves (`HostHistory`, fork addition): every Grok account Kuvo Code runs,
        // on every computer of yours, priced there; nothing is read here then (not answered yet: none).
        var usageHistory: ProviderUsageHistory?
        let scanned: LogUsageScan?
        var note = "From your Grok logs (estimated)"
        if let hosted = HostHistory.shared.scan(for: provider.id) {
            scanned = hosted
            note = "From your Grok usage history (estimated)"
            if let asOf = HostHistory.shared.asOfNote(for: provider.id) { note += ", \(asOf)" }
        } else {
            scanned = await logUsageScanner.scan(daysBack: 30, now: now(), pricing: await pricing())
        }
        if let scan = scanned {
            usageHistory = ProviderUsageHistory(
                series: scan.series,
                modelUsage: scan.modelUsage,
                unknownModelsByDay: scan.unknownModelsByDay
            )
            SpendTileMapper.appendTokenUsage(
                scan.series,
                to: &mapped.lines,
                now: now(),
                unknownModelsByDay: scan.unknownModelsByDay,
                modelUsage: scan.modelUsage,
                modelSourceNote: note
            )
            SpendTileMapper.appendUsageTrend(scan.series, to: &mapped.lines, now: now(), note: note)
        }

        return ProviderSnapshot.make(
            provider: provider,
            plan: plan,
            lines: mapped.lines,
            refreshedAt: now(),
            usageHistory: usageHistory,
            warning: warning
        )
    }

    private func fetchCreditsConfigWithRetry(
        accessToken: String, state: inout GrokAuthState, renews: Bool
    ) async throws -> HTTPResponse {
        var working = state
        defer { state = working }
        return try await ProviderAuthRetry.fetch(
            token: accessToken,
            attempt: { try await self.usageClient.fetchCreditsConfig(accessToken: $0) },
            refreshAccessToken: {
                if working.entryKey == GrokAuthStore.hostEntryKey {
                    // Turned away: the engine may have renewed it since the host last said.
                    await self.authStore.rereadHost()
                    guard let current = self.authStore.hostCandidate(), current.token != working.token else {
                        throw GrokAuthError.hostExpired
                    }
                    working = current
                    return current.token
                }
                guard renews, let refreshed = await self.refreshAccessToken(state: &working) else {
                    throw GrokAuthError.expired
                }
                return refreshed
            },
            connectionFailed: GrokUsageError.connectionFailed,
            authExpired: working.entryKey == GrokAuthStore.hostEntryKey ? GrokAuthError.hostExpired : GrokAuthError.expired
        )
    }

    private func refreshAccessToken(state: inout GrokAuthState) async -> String? {
        guard let refreshToken = authStore.refreshToken(for: state.entry) else {
            return nil
        }

        let response: HTTPResponse
        do {
            response = try await usageClient.refreshToken(
                refreshToken,
                clientID: authStore.clientID(entryKey: state.entryKey, entry: state.entry)
            )
        } catch {
            // Log the real cause: a transport failure here is currently surfaced to the user as
            // "auth expired" (loadAndProbe / the retry closure both map a nil refresh to .expired), so
            // without this line the actual reason (network/DNS/timeout) is lost. (Refining the
            // user-facing message to a request-failure is deferred — it needs a careful rework of the
            // candidate-loop + retry-closure semantics.)
            AppLog.warn(LogTag.auth("grok"), "token refresh request failed (transport): \(error.localizedDescription)")
            return nil
        }

        guard (200..<300).contains(response.statusCode) else {
            AppLog.warn(LogTag.auth("grok"), "token refresh failed (HTTP \(response.statusCode))")
            return nil
        }
        guard let decoded = usageClient.decodeRefreshResponse(response),
              !decoded.accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            AppLog.warn(LogTag.auth("grok"), "token refresh returned an undecodable or empty access token")
            return nil
        }

        let accessToken = decoded.accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        state.token = accessToken
        state.entry.key = accessToken
        if let refreshToken = decoded.refreshToken?.trimmingCharacters(in: .whitespacesAndNewlines), !refreshToken.isEmpty {
            state.entry.refreshToken = refreshToken
        }
        if let idToken = decoded.idToken?.trimmingCharacters(in: .whitespacesAndNewlines), !idToken.isEmpty {
            state.entry.idToken = idToken
        }

        let expiresAt = refreshExpiryDate(response: decoded, accessToken: accessToken)
        state.entry.expiresAt = OpenUsageISO8601.string(from: expiresAt)
        // Fail loudly: a swallowed save strands the rotated token on disk (next launch re-refreshes /
        // can surface a false "auth expired"). The refreshed token works for this session, so log and
        // continue rather than fail the live fetch.
        do {
            try authStore.save(state)
        } catch {
            AppLog.error(LogTag.auth("grok"), "failed to persist rotated credentials; using the refreshed token for this session only: \(error.localizedDescription)")
        }
        return accessToken
    }

    private func refreshExpiryDate(response: GrokRefreshResponse, accessToken: String) -> Date {
        if let expiresIn = response.expiresIn, expiresIn.isFinite, expiresIn > 0 {
            return now().addingTimeInterval(expiresIn)
        }
        if let tokenExpiry = authStore.tokenExpiresAt(accessToken) {
            return tokenExpiry
        }
        return now().addingTimeInterval(60 * 60)
    }

    private func fetchPlanName(accessToken: String) async -> String? {
        do {
            return GrokUsageMapper.planName(from: try await usageClient.fetchSettings(accessToken: accessToken))
        } catch {
            return nil
        }
    }
}
