import ClientDesign
import SwiftUI
import WebKit

/// The side panel: what it starts with, and the new tab page.
struct PanelSettingsView: View {
    @Environment(AppModel.self) private var app
    @AppStorage(PanelSettings.startsWith) private var startsWith = PanelSettings.Start.changes
    @AppStorage(PanelSettings.revealsForAgent) private var revealsForAgent = true
    @AppStorage(PanelSettings.tidiesAgentTabs) private var tidiesAgentTabs = true
    @AppStorage(PanelSettings.showsTools) private var showsTools = true
    @AppStorage(PanelSettings.showsSuggestions) private var showsSuggestions = true
    @AppStorage(PanelSettings.suggestionCount) private var suggestionCount = 8

    var body: some View {
        ScrollingSettingsForm {
            Section {
                Picker(selection: $startsWith) {
                    ForEach(PanelSettings.Start.allCases, id: \.self) { Text($0.title).tag($0) }
                } label: {
                    Text("Start each panel with")
                    Text("The first time you open a session’s, bot’s or group chat’s panel.")
                }
                Toggle(isOn: $revealsForAgent) {
                    Text("Show the panel when the agent browses")
                    Text("So you can watch it, and step in.")
                }
                Toggle(isOn: $tidiesAgentTabs) {
                    Text("Close agents’ tabs you haven’t looked at")
                    Text("An hour after an agent last used one, on this Mac and your machines, so tabs don’t pile up.")
                }
                .onChange(of: tidiesAgentTabs) {
                    for machine in app.machines.list.map(\.id) where app.machines.engine(machine)?.isReady == true {
                        Task { await Utilities.shareTabTidying(on: machine) }
                    }
                }
            }
            Section("New Tab Page") {
                Toggle(isOn: $showsTools) {
                    Text("Tools")
                    Text("Changes, Terminal and Files, as tiles to open, and a way here.")
                }
                Toggle(isOn: $showsSuggestions) {
                    Text("Suggested sites")
                    Text("The sites you visit most in the panel’s browser.")
                }
                Picker("Number of sites", selection: $suggestionCount) {
                    ForEach([4, 8, 12, 16], id: \.self) { Text("\($0)").tag($0) }
                }
                .disabled(!showsSuggestions)
            }
        }
    }
}

/// The panel's browser: its search engine, history, and the sites that keep data in it.
struct BrowserSettings: View {
    @Environment(AppModel.self) private var app
    @AppStorage(SearchEngine.key) private var searchEngine = SearchEngine.google
    @State private var records: [WKWebsiteDataRecord]?
    @State private var filter = ""
    @State private var confirmingClearAll = false

    private var history: BrowserHistory { app.utilities.history }

    var body: some View {
        ScrollingSettingsForm {
            Section {
                Picker(selection: $searchEngine) {
                    ForEach(SearchEngine.allCases, id: \.self) { Text($0.title).tag($0) }
                } label: {
                    Text("Search engine")
                    Text("For anything you type in the address field that isn’t an address.")
                }
                LabeledContent {
                    Button("Clear") { history.clear() }
                        .disabled(history.sites.isEmpty)
                } label: {
                    Text("Browsing history")
                    Text(history.sites.isEmpty ? "None yet." : "\(history.sites.count.counting("site")), which the new tab page suggests.")
                }
            }

            Section {
                if let records {
                    let shown = records.filter { filter.isEmpty || $0.displayName.localizedCaseInsensitiveContains(filter) }
                    if records.isEmpty {
                        Text("None yet.").foregroundStyle(.secondary)
                    } else {
                        SettingsSearchRow(text: $filter, prompt: "Search sites")
                        ForEach(shown, id: \.displayName) { record in
                            LabeledContent {
                                Button("Remove") { remove([record]) }
                            } label: {
                                Text(record.displayName)
                                Text(Self.kinds(of: record))
                            }
                        }
                    }
                } else {
                    Placeholder(.rows(count: 3), label: "Loading website data", fadesOut: false)
                        .padding(.vertical, 6)
                }
            } header: {
                HStack {
                    Text("Website Data")
                    if let records, !records.isEmpty {
                        Text(records.count == 1 ? "1 site" : "\(records.count) sites")
                            .font(.system(size: 12, weight: .regular))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Remove All…") { confirmingClearAll = true }
                        .disabled(records?.isEmpty ?? true)
                }
            } footer: {
                Text("Sign-ins, cookies and what sites store, kept apart from your other browsers. Removing a site’s data signs you out of it.")
                    .foregroundStyle(.secondary)
            }
        }
        .task { await load() }
        .confirmationDialog("Remove every site’s data?", isPresented: $confirmingClearAll) {
            Button("Remove All", role: .destructive) { remove(records ?? []) }
        } message: {
            Text("You’ll be signed out of every site in the panel’s browser. Your other browsers aren’t affected.")
        }
    }

    private func load() async {
        let store = WKWebsiteDataStore.default()
        records = await store.dataRecords(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes())
            .sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
    }

    private func remove(_ removed: [WKWebsiteDataRecord]) {
        guard !removed.isEmpty else { return }
        Task {
            await WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), for: removed)
            await load()
        }
    }

    /// What a site keeps, in a few words: "Cookies, Local storage".
    private static func kinds(of record: WKWebsiteDataRecord) -> String {
        let types = record.dataTypes
        var kinds: [String] = []
        if types.contains(WKWebsiteDataTypeCookies) { kinds.append("Cookies") }
        if types.contains(WKWebsiteDataTypeLocalStorage) || types.contains(WKWebsiteDataTypeSessionStorage) { kinds.append("Local storage") }
        if types.contains(WKWebsiteDataTypeIndexedDBDatabases) || types.contains(WKWebsiteDataTypeWebSQLDatabases) { kinds.append("Databases") }
        if types.contains(WKWebsiteDataTypeDiskCache) || types.contains(WKWebsiteDataTypeMemoryCache) || types.contains(WKWebsiteDataTypeFetchCache) { kinds.append("Cache") }
        if types.contains(WKWebsiteDataTypeServiceWorkerRegistrations) { kinds.append("Service workers") }
        return kinds.isEmpty ? "Website data" : kinds.joined(separator: ", ")
    }
}
