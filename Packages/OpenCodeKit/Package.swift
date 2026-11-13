// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "OpenCodeKit",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "OpenCodeKit", targets: ["OpenCodeKit"]),
        // Kuvo Code Box, the helper a Mac's box runs under in a home of its own (BoxHelper.swift).
        .executable(name: "KuvoCodeBox", targets: ["KuvoCodeBox"]),
    ],
    targets: [
        .target(name: "OpenCodeKit"),
        .executableTarget(name: "KuvoCodeBox", dependencies: ["OpenCodeKit"]),
        // A process for the tests to kill, as a crash would, with a server running under it.
        .executableTarget(name: "ServerProcessTestHost", dependencies: ["OpenCodeKit"], path: "Tests/ServerProcessTestHost"),
        .testTarget(name: "OpenCodeKitTests", dependencies: ["OpenCodeKit", "ServerProcessTestHost", "KuvoCodeBox"], resources: [.copy("Fixtures")]),
    ]
)
