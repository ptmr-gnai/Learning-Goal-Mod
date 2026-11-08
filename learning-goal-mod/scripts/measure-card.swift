// Measure the live Claude Desktop invitation via macOS accessibility geometry.
// Run: swift scripts/measure-card.swift (with a demo invitation visible).
import AppKit
import ApplicationServices

struct Rect { let x: CGFloat; let y: CGFloat; let width: CGFloat; let height: CGFloat }
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func string(_ e: AXUIElement, _ name: String) -> String { attribute(e, name) as? String ?? "" }
func children(_ e: AXUIElement) -> [AXUIElement] { attribute(e, "AXChildren") as? [AXUIElement] ?? [] }
func rect(_ e: AXUIElement) -> Rect? {
    guard let p = attribute(e, "AXPosition"), let s = attribute(e, "AXSize"),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return Rect(x: point.x, y: point.y, width: size.width, height: size.height)
}
func parent(_ e: AXUIElement) -> AXUIElement? {
    guard let p = attribute(e, "AXParent"), CFGetTypeID(p) == AXUIElementGetTypeID() else { return nil }
    return (p as! AXUIElement)
}
func findInvitation(_ e: AXUIElement, _ depth: Int = 0) -> (AXUIElement, AXUIElement, AXUIElement)? {
    if depth > 60 { return nil }
    let nodes = children(e)
    let text = nodes.first { string($0, "AXRole") == "AXStaticText" &&
        (string($0, "AXValue").hasPrefix("Demo · ") || string($0, "AXValue").hasPrefix("Learning opportunity · ")) }
    let explain = nodes.first { string($0, "AXRole") == "AXButton" && string($0, "AXTitle") == "Explain" }
    let dismiss = nodes.first { string($0, "AXRole") == "AXButton" && string($0, "AXTitle") == "Dismiss" }
    if let t = text, let b = explain, let d = dismiss { return (t, b, d) }
    for child in nodes { if let result = findInvitation(child, depth + 1) { return result } }
    return nil
}
guard AXIsProcessTrusted(), let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.anthropic.claudefordesktop").first else {
    fputs("Claude is not running or accessibility permission is unavailable.\n", stderr); exit(1)
}
let root = AXUIElementCreateApplication(app.processIdentifier)
_ = AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
guard let (text, explain, dismiss) = findInvitation(root), let group = parent(explain),
      let wrapper = parent(group), let card = parent(wrapper),
      let t = rect(text), let b = rect(explain), let d = rect(dismiss), let c = rect(card) else {
    fputs("Invitation not found. Open a local session and run /learning-goal demo.\n", stderr); exit(1)
}
print("Card: \(c.width) × \(c.height) points")
print("Top edge → text box: \(t.y - c.y) points")
print("Text box → button: \(b.y - (t.y + t.height)) points")
print("Button → bottom edge: \(c.y + c.height - b.y - b.height) points")
print("Left edge → controls: \(b.x - c.x) points")
print("Between buttons: \(d.x - b.x - b.width) points")
print("Text box: \(t.width) × \(t.height); button: \(b.width) × \(b.height) points")
if t.y + t.height > b.y || b.x + b.width > d.x || b.y + b.height > c.y + c.height {
    fputs("FAIL: elements overlap or exceed the card.\n", stderr); exit(2)
}
