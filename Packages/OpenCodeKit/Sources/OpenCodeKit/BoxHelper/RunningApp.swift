#if os(macOS)
import Darwin
import Foundation

/// Kuvo Code running as the app, as the kernel says: what the keeper and the box's helper ask before
/// opening it for the box's browser (opening one that runs brings its window up).
public enum RunningApp {
    /// Whether Kuvo Code runs from `executable` now as the app: a process of it other than the
    /// keeper and a command to it (`--box`, `--box-control`). Asked of the kernel, not Launch
    /// Services, so the keeper and the box's helper never check in as an app.
    public static func runs(_ executable: URL) -> Bool {
        let wanted = executable.resolvingSymlinksInPath().path(percentEncoded: false)
        // Yours alone: another user's Kuvo Code on this Mac isn't yours to wait for.
        let bytes = proc_listpids(UInt32(PROC_UID_ONLY), UInt32(getuid()), nil, 0)
        guard bytes > 0 else { return false }
        var pids = [pid_t](repeating: 0, count: Int(bytes) / MemoryLayout<pid_t>.size + 32)
        let found = Int(proc_listpids(UInt32(PROC_UID_ONLY), UInt32(getuid()), &pids, Int32(pids.count * MemoryLayout<pid_t>.size))) / MemoryLayout<pid_t>.size
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        for pid in pids.prefix(max(0, found)) where pid > 0 && pid != getpid() {
            guard proc_pidpath(pid, &path, UInt32(path.count)) > 0,
                  URL(filePath: String(cString: path)).resolvingSymlinksInPath().path(percentEncoded: false) == wanted else { continue }
            // One whose arguments can't be read (gone meanwhile) isn't counted.
            guard let arguments = arguments(of: pid) else { continue }
            if !arguments.contains("--box"), !arguments.contains("--box-control") { return true }
        }
        return false
    }

    /// A process's arguments, as the kernel keeps them (`KERN_PROCARGS2`: its argument count, its
    /// executable's path, then each argument, all NUL-ended).
    public static func arguments(of pid: pid_t) -> [String]? {
        var name = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&name, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&name, 3, &buffer, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        let argc = buffer.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
        var index = MemoryLayout<Int32>.size
        // Past the executable's path and the NULs after it.
        while index < size, buffer[index] != 0 { index += 1 }
        while index < size, buffer[index] == 0 { index += 1 }
        var arguments: [String] = []
        while arguments.count < Int(argc), index < size {
            let start = index
            while index < size, buffer[index] != 0 { index += 1 }
            arguments.append(String(decoding: buffer[start..<index], as: UTF8.self))
            index += 1
        }
        return arguments
    }
}
#endif
