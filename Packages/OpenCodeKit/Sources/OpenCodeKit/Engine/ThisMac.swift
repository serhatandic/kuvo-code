import Foundation

// Only on the Mac.
#if os(macOS)
import IOKit

/// The Mac this runs on.
public enum ThisMac {
    /// Its hardware's own ID (`IOPlatformUUID`), as `ioreg` prints it, which a script asks another
    /// Mac for, to tell whether that's this one. Empty when it can't be read.
    public static let identifier: String = {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
        defer { IOObjectRelease(service) }
        return IORegistryEntryCreateCFProperty(service, kIOPlatformUUIDKey as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String ?? ""
    }()
}

#endif
