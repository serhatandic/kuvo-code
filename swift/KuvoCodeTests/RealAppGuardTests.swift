import Foundation
import Testing
@testable import KuvoCode

/// A debug copy launched for a demo, a test or a measurement never runs as the real Kuvo Code, or
/// with its engine: it would use your settings, sessions and sign-ins, and send what it does to
/// your models on your accounts. A copy with a bundle ID of its own, on its own engine, starts; so
/// does a launch with none of those variables (you running a debug build yourself).
@Suite struct RealAppGuardTests {
    let realSupport = AppInfo.testRoot.appending(path: "RealAppGuard/Application Support/run.kuvo.code")

    @Test func aDemoOrMeasurementLaunchAsTheRealAppIsRefused() {
        for variables in [["KUVO_DEMO_BACKGROUND": "1"], ["KUVO_PERF_SWITCH": "4"], ["KUVO_E2E": "1"], ["KUVO_DEMO_GROUP_REPLAY": "run", "KUVO_PERF_LOG": "/tmp/x"]] {
            let refusal = AppInfo.realAppRefusal(bundleID: "run.kuvo.code", environment: variables, realSupport: realSupport)
            #expect(refusal?.contains("real Kuvo Code") == true, "\(variables)")
            for name in variables.keys { #expect(refusal?.contains(name) == true, "names what asked for it: \(name)") }
        }
        #expect(AppInfo.realAppRefusal(bundleID: "Run.Kuvo.Code", environment: ["KUVO_DEMO_NAME": "x"], realSupport: realSupport) != nil,
                "bundle IDs ignore case")
    }

    @Test func aCopyWithTheRealEngineIsRefused() {
        let engine = realSupport.appending(path: "engine/2.0.32/opencode").path(percentEncoded: false)
        let refusal = AppInfo.realAppRefusal(bundleID: "run.kuvo.code.perf",
                                             environment: ["KUVO_DEMO_GROUP_REPLAY": "run", "KUVO_OPENCODE_BINARY": engine], realSupport: realSupport)
        #expect(refusal?.contains("engine") == true)
        let roundabout = realSupport.path(percentEncoded: false) + "/../run.kuvo.code/engine/2.0.32/opencode"
        #expect(AppInfo.realAppRefusal(bundleID: "run.kuvo.code.perf", environment: ["KUVO_PERF_LOG": "x", "KUVO_OPENCODE_BINARY": roundabout],
                                       realSupport: realSupport) != nil)
    }

    @Test func aCopyInTheRealFolderOnMachinesIsRefused() {
        for root in [".kuvo-code", ".kuvo-code/", "~/.kuvo-code", "/home/someone/.kuvo-code"] {
            let refusal = AppInfo.realAppRefusal(bundleID: "run.kuvo.code.demo", environment: ["KUVO_DEMO_MACHINE_ROOT": root], realSupport: realSupport)
            #expect(refusal?.contains("machines") == true, "\(root)")
        }
        for root in [".kuvo-code-demo", ".kuvo-code-perf", ".kuvo-code-e2e"] {
            #expect(AppInfo.realAppRefusal(bundleID: "run.kuvo.code.demo", environment: ["KUVO_DEMO_MACHINE_ROOT": root], realSupport: realSupport) == nil, "\(root)")
        }
    }

    @Test func copiesOfTheirOwnStart() {
        let ownEngine = realSupport.deletingLastPathComponent().appending(path: "run.kuvo.code.perf/engine/2.0.32/opencode").path(percentEncoded: false)
        for bundleID in ["run.kuvo.code.demo", "run.kuvo.code.perf", "run.kuvo.code.e2e", "run.kuvo.code.shots", "run.kuvo.code.tests"] {
            #expect(AppInfo.realAppRefusal(bundleID: bundleID, environment: ["KUVO_DEMO_BACKGROUND": "1", "KUVO_OPENCODE_BINARY": ownEngine],
                                           realSupport: realSupport) == nil, "\(bundleID)")
        }
        // A debug build you run yourself, as the app, with none of the demo or measurement variables.
        #expect(AppInfo.realAppRefusal(bundleID: "run.kuvo.code", environment: ["HOME": "/Users/someone", "KUVO_OPENCODE_BINARY": "/opt/opencode"],
                                       realSupport: realSupport) == nil)
    }
}
