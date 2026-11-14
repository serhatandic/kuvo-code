// Drives one app process for the end-to-end tests, without taking the pointer or the keyboard:
// through Accessibility, events posted to that process only, and window captures.
//
//   drive <pid> dump [depth]              the windows' elements: role, title, description, value, id
//   drive <pid> find <query>              elements matching query
//   drive <pid> press <query> [n]         presses the nth match (default 0)
//   drive <pid> set <query> <text> [n]    sets the value of the nth matching text field or area
//   drive <pid> focus <query> [n]         focuses the nth matching element
//   drive <pid> act <query> <action> [n]  performs the nth match's action named so (a custom one too)
//   drive <pid> wait <query> <seconds>    exits 0 once something matches, 1 when time's up
//   drive <pid> gone <query> <seconds>    exits 0 once nothing matches, 1 when time's up
//   drive <pid> text                      the windows' static texts, in order
//   drive <pid> scrollbar <n> <0…1>       sets the nth scroll area's vertical position
//   drive <pid> shot <prefix>             captures each window to <prefix>-<w>x<h>.png
//   drive <pid> click <x> <y>             a click at a point in the main window (points from its top left)
//   drive <pid> type <text>               types text into what has focus
//   drive <pid> key <keycode> [cmd|shift|option|ctrl…]   a key, with modifiers joined by +
//   drive <pid> scroll <x> <y> <dy>       a scroll wheel turn over a point in the main window
//
// A query matches when any of title, description, help, identifier, placeholder or value contains
// it, ignoring case. "role:AXButton|Send" also needs that role; "=Answer" needs a title,
// description or value that is exactly it; "#composer" an identifier that is exactly it.
import AppKit
import ApplicationServices

let args = CommandLine.arguments
guard args.count >= 3, let pid = pid_t(args[1]) else {
    FileHandle.standardError.write(Data("usage: drive <pid> <command> …\n".utf8)); exit(2)
}
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 5)

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ name: String) -> String {
    guard let v = attr(e, name) else { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
}
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func windows() -> [AXUIElement] { (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] }

func walk(_ root: AXUIElement, max: Int = 80) -> [(AXUIElement, Int)] {
    var out: [(AXUIElement, Int)] = []
    func go(_ e: AXUIElement, _ d: Int) {
        out.append((e, d))
        if d < max { for c in children(e) { go(c, d + 1) } }
    }
    go(root, 0)
    return out
}
func describe(_ e: AXUIElement) -> String {
    var parts = [str(e, kAXRoleAttribute)]
    for (k, label) in [(kAXTitleAttribute, "title"), (kAXDescriptionAttribute, "desc"), (kAXHelpAttribute, "help"), (kAXIdentifierAttribute, "id"), (kAXPlaceholderValueAttribute, "placeholder")] {
        let v = str(e, k)
        if !v.isEmpty { parts.append("\(label)=\(v.debugDescription)") }
    }
    let value = str(e, kAXValueAttribute)
    if !value.isEmpty { parts.append("value=\(String(value.prefix(160)).debugDescription)") }
    if let enabled = attr(e, kAXEnabledAttribute) as? Bool, !enabled { parts.append("disabled") }
    return parts.joined(separator: " ")
}
func matches(_ e: AXUIElement, _ query: String) -> Bool {
    var q = query
    var role: String?
    if q.lowercased().hasPrefix("role:") {
        let rest = q.dropFirst(5).split(separator: "|", maxSplits: 1).map(String.init)
        role = rest.first?.lowercased(); q = rest.count > 1 ? rest[1] : ""
    }
    if let role, str(e, kAXRoleAttribute).lowercased() != role { return false }
    if q.isEmpty { return true }
    if q.hasPrefix("#") { return str(e, kAXIdentifierAttribute) == String(q.dropFirst()) }
    if q.hasPrefix("=") {
        let exact = String(q.dropFirst())
        return [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].contains { str(e, $0) == exact }
    }
    let lower = q.lowercased()
    return [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXIdentifierAttribute, kAXPlaceholderValueAttribute, kAXValueAttribute]
        .contains { str(e, $0).lowercased().contains(lower) }
}
/// The windows, and any menu open over them (a pop-up's or a context menu's).
func all() -> [AXUIElement] {
    let menus = children(app).filter { str($0, kAXRoleAttribute) == "AXMenu" }
    return (windows() + menus).flatMap { walk($0).map(\.0) }
}
func nth(_ found: [AXUIElement], _ index: Int, _ query: String) -> AXUIElement {
    guard found.count > index else { print("not found: \(query)"); exit(1) }
    return found[index]
}

// The process's main window on screen, for events and captures.
func mainWindow() -> (id: Int, bounds: CGRect)? {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    let mine = list.filter { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
    let sized = mine.compactMap { w -> (Int, CGRect)? in
        guard let id = w[kCGWindowNumber as String] as? Int, let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
        return (id, CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0))
    }
    return sized.max { $0.1.width * $0.1.height < $1.1.width * $1.1.height }
}
let source = CGEventSource(stateID: .privateState)
func post(_ event: CGEvent, window: Int) {
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
    event.postToPid(pid)
    usleep(30_000)
}
func point(_ x: String, _ y: String) -> (CGPoint, Int) {
    guard let w = mainWindow() else { print("no window"); exit(1) }
    return (CGPoint(x: w.bounds.minX + CGFloat(Double(x) ?? 0), y: w.bounds.minY + CGFloat(Double(y) ?? 0)), w.id)
}

switch args[2] {
case "dump":
    let depth = args.count > 3 ? Int(args[3]) ?? 80 : 80
    for w in windows() { for (e, d) in walk(w, max: depth) { print(String(repeating: "  ", count: d) + describe(e)) } }
case "find":
    for e in all() where matches(e, args[3]) { print(describe(e)) }
case "press":
    let e = nth(all().filter { matches($0, args[3]) }, args.count > 4 ? Int(args[4]) ?? 0 : 0, args[3])
    let result = AXUIElementPerformAction(e, kAXPressAction as CFString)
    print(result == .success ? "pressed \(describe(e))" : "press failed (\(result.rawValue)) \(describe(e))")
    exit(result == .success ? 0 : 1)
case "set":
    let fields = all().filter { ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(str($0, kAXRoleAttribute)) && matches($0, args[3]) }
    let e = nth(fields, args.count > 5 ? Int(args[5]) ?? 0 : 0, args[3])
    AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let result = AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, args[4] as CFString)
    print(result == .success ? "set \(describe(e))" : "set failed (\(result.rawValue))")
    exit(result == .success ? 0 : 1)
case "act":
    let e = nth(all().filter { matches($0, args[3]) }, args.count > 5 ? Int(args[5]) ?? 0 : 0, args[3])
    var names: CFArray?
    AXUIElementCopyActionNames(e, &names)
    let wanted = args[4].lowercased()
    guard let action = (names as? [String] ?? []).first(where: { $0.lowercased().contains(wanted) }) else {
        print("no action \(args[4]) on \(describe(e)): \(names as? [String] ?? [])"); exit(1)
    }
    let result = AXUIElementPerformAction(e, action as CFString)
    print(result == .success ? "did \(args[4]) on \(describe(e))" : "failed (\(result.rawValue))")
    exit(result == .success ? 0 : 1)
case "focus":
    let e = nth(all().filter { matches($0, args[3]) }, args.count > 4 ? Int(args[4]) ?? 0 : 0, args[3])
    let result = AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    exit(result == .success ? 0 : 1)
case "wait", "gone":
    let deadline = Date().addingTimeInterval(Double(args[4]) ?? 30)
    let wantsGone = args[2] == "gone"
    while Date() < deadline {
        let found = all().first { matches($0, args[3]) }
        if wantsGone, found == nil { print("gone: \(args[3])"); exit(0) }
        if !wantsGone, let found { print("found \(describe(found))"); exit(0) }
        Thread.sleep(forTimeInterval: 0.5)
    }
    print("timed out: \(args[3])"); exit(1)
case "text":
    for e in all() where str(e, kAXRoleAttribute) == "AXStaticText" {
        let v = str(e, kAXValueAttribute)
        if !v.isEmpty { print(v) }
    }
case "scrollbar":
    let areas = all().filter { str($0, kAXRoleAttribute) == "AXScrollArea" }
    let area = nth(areas, Int(args[3]) ?? 0, "scroll area \(args[3])")
    guard let bar = attr(area, kAXVerticalScrollBarAttribute) else { print("no scroll bar"); exit(1) }
    let result = AXUIElementSetAttributeValue(bar as! AXUIElement, kAXValueAttribute as CFString, (Double(args[4]) ?? 0) as CFNumber)
    exit(result == .success ? 0 : 1)
case "shot":
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list where (w[kCGWindowOwnerPID as String] as? pid_t) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
        guard let id = w[kCGWindowNumber as String] as? Int, let b = w[kCGWindowBounds as String] as? [String: Double] else { continue }
        let out = "\(args[3])-\(Int(b["Width"] ?? 0))x\(Int(b["Height"] ?? 0)).png"
        let p = Process()
        p.executableURL = URL(filePath: "/usr/sbin/screencapture")
        p.arguments = ["-x", "-o", "-l", String(id), out]
        try? p.run(); p.waitUntilExit()
        print(out)
    }
case "click":
    let (p, w) = point(args[3], args[4])
    for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!, window: w)
    }
case "box":
    // box <query> [n]: where the element is in the main window (x y width height, from its top
    // left) and what's selected in it, if it's text.
    let e = nth(all().filter { matches($0, args[3]) }, args.count > 4 ? Int(args[4]) ?? 0 : 0, args[3])
    var origin = CGPoint.zero, size = CGSize.zero
    if let v = attr(e, kAXPositionAttribute) { AXValueGetValue(v as! AXValue, .cgPoint, &origin) }
    if let v = attr(e, kAXSizeAttribute) { AXValueGetValue(v as! AXValue, .cgSize, &size) }
    let w = mainWindow()?.bounds ?? .zero
    print("\(Int(origin.x - w.minX)) \(Int(origin.y - w.minY)) \(Int(size.width)) \(Int(size.height)) selected=\(str(e, kAXSelectedTextAttribute).debugDescription)")
case "drag":
    // drag <x1> <y1> <x2> <y2>: pressed at the first point, moved in steps to the second, let go
    // there, as a hand selects text.
    let (from, w) = point(args[3], args[4])
    let (to, _) = point(args[5], args[6])
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left)!, window: w)
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)!, window: w)
    for step in 1...12 {
        let t = CGFloat(step) / 12
        let at = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: at, mouseButton: .left)!, window: w)
    }
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)!, window: w)
case "type":
    for unit in args[3].utf16 {
        var c = unit
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)!
            e.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
            e.postToPid(pid)
        }
        usleep(15_000)
    }
case "key":
    let code = CGKeyCode(args[3]) ?? 0
    var flags: CGEventFlags = []
    for m in (args.count > 4 ? args[4] : "").split(separator: "+") {
        switch m {
        case "cmd": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "option": flags.insert(.maskAlternate)
        case "ctrl": flags.insert(.maskControl)
        default: break
        }
    }
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)!
        e.flags = flags
        e.postToPid(pid)
        usleep(20_000)
    }
case "scroll":
    let (p, w) = point(args[3], args[4])
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)!, window: w)
    let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(args[5]) ?? 0, wheel2: 0, wheel3: 0)!
    e.location = p
    post(e, window: w)
default:
    print("unknown command \(args[2])"); exit(2)
}
