import SwiftUI

#if os(macOS)
import AppKit

/// The platform's own color: NSColor on the Mac, UIColor on the phone.
public typealias PlatformColor = NSColor
/// The platform's own view: NSView on the Mac, UIView on the phone.
public typealias PlatformView = NSView

extension NSColor {
    static func srgb(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> NSColor {
        NSColor(srgbRed: red, green: green, blue: blue, alpha: 1)
    }
}
#else
import UIKit

/// The platform's own color: NSColor on the Mac, UIColor on the phone.
public typealias PlatformColor = UIColor
/// The platform's own view: NSView on the Mac, UIView on the phone.
public typealias PlatformView = UIView

extension UIColor {
    static func srgb(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> UIColor {
        UIColor(red: red, green: green, blue: blue, alpha: 1)
    }
}
#endif

extension Color {
    /// A color written as web colors are: 0xRRGGBB.
    public init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}
