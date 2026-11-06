// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "OpenCodeKit",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "OpenCodeKit", targets: ["OpenCodeKit"]),
    ],
    targets: [
        .target(name: "OpenCodeKit"),
        // A process for the tests to kill, as a crash would, with a server running under it.
        .executableTarget(name: "ServerProcessTestHost", dependencies: ["OpenCodeKit"], path: "Tests/ServerProcessTestHost"),
        .testTarget(name: "OpenCodeKitTests", dependencies: ["OpenCodeKit", "ServerProcessTestHost"], resources: [.copy("Fixtures")]),
    ]
)
