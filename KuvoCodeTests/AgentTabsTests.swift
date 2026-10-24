import Foundation
import Testing
@testable import KuvoCode

/// Tabs agents open in the panel's browser tidy themselves away: one you never looked at closes
/// once no agent has worked in it for a while (an hour), so conversations that browse out of sight,
/// like a bot that wakes every hour, don't pile up pages. One you looked at is yours and stays, as
/// does one an agent used lately, one whose conversation is at work or waits for you, and all of
/// them when Settings › Panel says to keep them.
@MainActor
@Suite(.serialized) struct AgentTabsTests {
    let panel = Utilities()
    let later = Date.now.addingTimeInterval(Utilities.agentTabIdle + 60)

    init() {
        TestEnvironment.prepare()
        UserDefaults.standard.removeObject(forKey: PanelSettings.tidiesAgentTabs)
        panel.inView = .init(session: "ses_you")
    }

    /// A page a bot opened, out of sight, as it browses.
    private func agentsTab(_ session: String = "ses_bot") -> UUID? {
        let browser = panel.newBrowser("about:blank", byAgent: true, owner: panel.panelKey, shown: false)
        panel.agentWorks(session, in: browser)
        return panel.id(of: browser)
    }

    private func isOpen(_ id: UUID?) -> Bool {
        panel.tabs.contains { $0.id == id }
    }

    @Test func oneNoOneLookedAtClosesOnceLeftAlone() throws {
        let id = try #require(agentsTab())
        panel.tidyAgentTabs(now: .now)
        #expect(isOpen(id), "not while it's being used")
        panel.tidyAgentTabs(now: later)
        #expect(!isOpen(id), "left alone for an hour, it goes")
    }

    @Test func oneYouLookedAtIsYours() throws {
        let id = try #require(agentsTab())
        panel.choose(id)
        let elsewhere = panel.newBrowser("about:blank")
        panel.choose(try #require(panel.id(of: elsewhere)))
        panel.tidyAgentTabs(now: later)
        #expect(isOpen(id))
    }

    @Test func oneWhoseConversationIsAtWorkStays() throws {
        let id = try #require(agentsTab())
        panel.isBusy = { $0 == "ses_bot" }
        panel.tidyAgentTabs(now: later)
        #expect(isOpen(id))
    }

    @Test func keptWhenSettingsSaySo() throws {
        defer { UserDefaults.standard.removeObject(forKey: PanelSettings.tidiesAgentTabs) }
        let id = try #require(agentsTab())
        UserDefaults.standard.set(false, forKey: PanelSettings.tidiesAgentTabs)
        panel.tidyAgentTabs(now: later)
        #expect(isOpen(id))
    }
}
