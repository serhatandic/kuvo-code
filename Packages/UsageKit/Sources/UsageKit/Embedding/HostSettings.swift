import Foundation

/// The panel's settings the host keeps for every computer of yours (fork addition, #631 piece F):
/// which cards and meters show and in what order, what's pinned to the menu bar, the total spend
/// card's settings and which notifications are on. The host's boxes keep them and share them, the
/// newest change winning (PROTOCOL.md, "Usage settings"); the panel keeps its own copy where it always
/// did, so it starts at once and works while the host can't answer. This only turns that copy into
/// the box's parts and back: what's newest, and what's shared with whom, is the box's.
///
/// How the panel looks (density, theme, transparency, animation, the menu bar's style) and how each
/// card is opened stay this Mac's own, never here.
///
/// Parts are JSON objects as the box words them (`{layout?, providers?, totalSpend?, notifications?,
/// codexFallback?}`): Codex's fallback model goes only with the import, as the host changes it
/// through its own route (`HostHistory.setCodexFallback`).
@MainActor
public final class HostSettings {
    public static let shared = HostSettings()

    /// Told the parts the panel changed here (each whole, as JSON), once the host has said its own
    /// (`apply`): never for what the host put here.
    public var onChange: ((Data) -> Void)?

    private let defaults: UserDefaults
    private let layout: LayoutPersistence
    /// Each part as the panel had it when the host last said its own, or when a change went: what a
    /// change is a change from.
    private var said: [String: Data]?
    /// Whether `said`'s layout is the running panel's (it may start after the host first said).
    private var saidLive = false
    /// Each part as the host last said it (or as a change here went to it): a part said again as it
    /// was isn't put in the panel again (which would end a drag and Undo).
    private var heard: [String: Data] = [:]
    /// The layout as the host last said it: what this Mac's panel doesn't know of it (a newer app's
    /// cards and meters) goes back with a change made here, so it isn't lost to the others.
    private var heardLayout: [String: Any]?
    private var observer: NSObjectProtocol?
    private var checking = false
    /// Takes what was put in the stored copy into the panel's stores (the parts put there, by name).
    var reload: (Set<String>) -> Void
    /// The panel's layout as it shows it, while it runs (it keeps a fresh one's meters only once they change).
    var liveLayout: () -> LayoutStore?

    static let layoutStorageKey = "openusage.layout.v1"
    private static let names = ["layout", "providers", "totalSpend", "notifications"]

    init(defaults: UserDefaults = .standard, liveLayout: (() -> LayoutStore?)? = nil, reload: ((Set<String>) -> Void)? = nil) {
        self.defaults = defaults
        layout = LayoutPersistence(defaults: defaults, storageKey: Self.layoutStorageKey)
        self.liveLayout = liveLayout ?? { UsageMenuBar.shared.container?.layout }
        self.reload = reload ?? { parts in UsageMenuBar.shared.container?.reloadShared(parts) }
        observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.changedSoon() }
        }
    }

    /// What was set on this Mac before its host kept these, as the box's parts, to bring in once:
    /// only the parts changed here (a Mac still on its first-run settings brings none, so it never
    /// puts them over the ones you made on another), and Codex's fallback model when one was
    /// chosen. Which cards are on isn't brought: each Mac turned on those for the tools it found,
    /// so they're shared from the first time you turn one on or off.
    public func toImport() -> Data {
        var parts = self.parts()
        parts["providers"] = nil
        if !layout.hasArrangement { parts["layout"] = nil }
        let set = { [defaults] (keys: [String]) in keys.contains { defaults.object(forKey: $0) != nil } }
        if !set([TotalSpendSetting.key, TotalSpendSetting.periodKey, TotalSpendSetting.metricKey]) { parts["totalSpend"] = nil }
        let keys = NotificationSettingsStore.storageKeys
        if !set([keys.underTen, keys.healthyToClose, keys.closeToRunningOut]) { parts["notifications"] = nil }
        if let model = CodexFallbackModelSetting.current(defaults: defaults) { parts["codexFallback"] = model }
        return Self.json(parts)
    }

    /// The host's parts (JSON, as the box words them): each one given goes in the panel's place and
    /// shows, unless it's as the host said it before; one not given stays as the panel has it, and
    /// so does one in `except` (a change made here, on its way to the host). From now on, the panel's
    /// own changes go to `onChange`.
    public func apply(_ settings: Data, except: Set<String> = []) {
        let given = (try? JSONSerialization.jsonObject(with: settings)) as? [String: Any] ?? [:]
        let mine = self.parts()
        var put = Set<String>()
        for name in Self.names where !except.contains(name) {
            guard let value = given[name] as? [String: Any] else { continue }
            let theirs = Self.json(Self.sorted(name, value))
            let before = heard[name]
            heard[name] = theirs
            if name == "layout" { heardLayout = value }
            // (As it said before: the panel has it, or what it made of it.)
            if before == theirs || mine[name].map({ Self.json(withHeard(name, $0)) }) == theirs { continue }
            write(name, value)
            put.insert(name)
        }
        if !put.isEmpty { reload(put) }
        // (What the stores made of it, checked against this Mac's providers, is what a change is from.)
        said = partsJSON()
        saidLive = liveLayout() != nil
    }

    /// The host turned these parts down: the next it says of them goes in, as it was.
    public func forget(_ parts: Set<String>) {
        for name in parts { heard[name] = nil }
    }

    /// The panel's own change: told once the stores have all written theirs.
    private func changedSoon() {
        guard said != nil, !checking else { return }
        checking = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.checking = false
                self.check()
            }
        }
    }

    /// The parts that aren't as last said, to the host.
    func check() {
        guard let said else { return }
        let now = partsJSON()
        // The panel started after the host last said: what it shows is where changes start from.
        if !saidLive, liveLayout() != nil {
            self.said = now
            saidLive = true
            return
        }
        let changed = now.filter { said[$0.key] != $0.value }
        guard !changed.isEmpty else { return }
        self.said = now
        var parts: [String: Any] = [:]
        for (name, value) in self.parts() where changed[name] != nil {
            let part = withHeard(name, value)
            parts[name] = part
            heard[name] = Self.json(part)
        }
        onChange?(Self.json(parts))
    }

    /// A part as it goes to the host: the layout with what the host said of it that this Mac's
    /// panel doesn't know (a newer app's cards and meters) put back.
    private func withHeard(_ name: String, _ value: Any) -> [String: Any] {
        let mine = value as? [String: Any] ?? [:]
        guard name == "layout", let box = heardLayout, let registry = liveLayout()?.registry else { return Self.sorted(name, mine) }
        let unknownMeter = { (id: String) in registry.descriptor(id: id) == nil }
        let unknownCard = { (id: String) in registry.provider(id: id) == nil }
        var out = mine
        for key in ["placed", "pinned", "expanded", "expandOnEnable", "seeded"] {
            let have = mine[key] as? [String] ?? []
            out[key] = have + (box[key] as? [String] ?? []).filter { unknownMeter($0) && !have.contains($0) }
        }
        let order = mine["providerOrder"] as? [String] ?? []
        out["providerOrder"] = order + (box["providerOrder"] as? [String] ?? []).filter { unknownCard($0) && !order.contains($0) }
        var metricOrder = mine["metricOrder"] as? [String: [String]] ?? [:]
        for (card, ids) in box["metricOrder"] as? [String: [String]] ?? [:] {
            if unknownCard(card) {
                metricOrder[card] = ids
            } else {
                let have = metricOrder[card] ?? []
                metricOrder[card] = have + ids.filter { unknownMeter($0) && !have.contains($0) }
            }
        }
        out["metricOrder"] = metricOrder
        return Self.sorted(name, out)
    }

    // MARK: - The stored copy, as parts

    private func parts() -> [String: Any] {
        var parts: [String: Any] = [:]
        if let live = liveLayout() {
            parts["layout"] = Self.sorted("layout", live.sharedLayout())
        } else if let placed = layout.loadPlaced() {
            parts["layout"] = Self.sorted("layout", [
                "placed": placed.map(\.descriptorID),
                "providerOrder": layout.loadProviderOrder() ?? [],
                "metricOrder": layout.loadMetricOrder() ?? [:],
                "pinned": layout.loadPins() ?? [],
                "expanded": layout.loadExpandedMetrics() ?? [],
                "expandOnEnable": layout.loadExpandOnEnable() ?? [],
                "seeded": layout.loadSeededDefaults() ?? [],
            ])
        }
        // (Only once it keeps the cards turned on, not those turned off as before its settings v2.)
        if let enabled = defaults.stringArray(forKey: ProviderEnablementStore.enabledStorageKey) {
            parts["providers"] = Self.sorted("providers", ["enabled": enabled, "known": defaults.stringArray(forKey: ProviderEnablementStore.knownStorageKey) ?? []])
        }
        var spend: [String: Any] = ["show": defaults.object(forKey: TotalSpendSetting.key) as? Bool ?? true]
        if let period = defaults.string(forKey: TotalSpendSetting.periodKey) { spend["period"] = period }
        if let metric = defaults.string(forKey: TotalSpendSetting.metricKey) { spend["metric"] = metric }
        parts["totalSpend"] = spend
        let keys = NotificationSettingsStore.storageKeys
        parts["notifications"] = [
            "underTenPercent": defaults.bool(forKey: keys.underTen, default: false),
            "healthyToClose": defaults.bool(forKey: keys.healthyToClose, default: false),
            "closeToRunningOut": defaults.bool(forKey: keys.closeToRunningOut, default: false),
        ]
        return parts
    }

    private func partsJSON() -> [String: Data] {
        parts().mapValues { Self.json($0) }
    }

    private func write(_ name: String, _ value: [String: Any]) {
        let strings = { (key: String) in (value[key] as? [String]) ?? [] }
        switch name {
        case "layout":
            // The meters already shown keep who they are: only those new here are new.
            let had = Dictionary((liveLayout()?.placed ?? layout.loadPlaced() ?? []).map { ($0.descriptorID, $0.id) }, uniquingKeysWith: { first, _ in first })
            layout.savePlaced(strings("placed").map { PlacedWidget(id: had[$0] ?? UUID(), descriptorID: $0) })
            layout.saveProviderOrder(strings("providerOrder"))
            layout.saveMetricOrder((value["metricOrder"] as? [String: [String]]) ?? [:])
            layout.savePins(Set(strings("pinned")))
            layout.saveExpandedMetrics(Set(strings("expanded")))
            layout.saveExpandOnEnable(Set(strings("expandOnEnable")))
            layout.saveSeededDefaults(Set(strings("seeded")))
        case "providers":
            defaults.set(strings("enabled"), forKey: ProviderEnablementStore.enabledStorageKey)
            defaults.set(strings("known"), forKey: ProviderEnablementStore.knownStorageKey)
        case "totalSpend":
            defaults.set(value["show"] as? Bool ?? true, forKey: TotalSpendSetting.key)
            for (field, key) in [("period", TotalSpendSetting.periodKey), ("metric", TotalSpendSetting.metricKey)] {
                if let word = value[field] as? String { defaults.set(word, forKey: key) } else { defaults.removeObject(forKey: key) }
            }
        case "notifications":
            let keys = NotificationSettingsStore.storageKeys
            defaults.set(value["underTenPercent"] as? Bool ?? false, forKey: keys.underTen)
            defaults.set(value["healthyToClose"] as? Bool ?? false, forKey: keys.healthyToClose)
            defaults.set(value["closeToRunningOut"] as? Bool ?? false, forKey: keys.closeToRunningOut)
        default:
            break
        }
    }

    /// A part with its sets in one order (the panel keeps them in any), so the same part reads the same.
    private static func sorted(_ name: String, _ value: [String: Any]) -> [String: Any] {
        let sets: [String] = switch name {
        case "layout": ["pinned", "expanded", "expandOnEnable", "seeded"]
        case "providers": ["enabled", "known"]
        default: []
        }
        var value = value
        for key in sets { if let list = value[key] as? [String] { value[key] = Array(Set(list)).sorted() } }
        return value
    }

    private static func json(_ value: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data()
    }
}
