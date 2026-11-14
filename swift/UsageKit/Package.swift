// swift-tools-version: 6.2
import PackageDescription

// A fork of OpenUsage (https://github.com/robinebers/openusage), adapted to run inside Kuvo Code.
// See README.md for what changed.
let package = Package(
    name: "UsageKit",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .library(name: "UsageKit", targets: ["UsageKit"])
    ],
    dependencies: [
        // The global shortcut recorder.
        .package(url: "https://github.com/sindresorhus/KeyboardShortcuts", from: "3.1.0")
    ],
    targets: [
        .target(
            name: "UsageKit",
            dependencies: [
                .product(name: "KeyboardShortcuts", package: "KeyboardShortcuts")
            ],
            path: "Sources/UsageKit",
            resources: [
                .copy("Resources/ProviderIcons"),
                .copy("Resources/pricing_supplement.json"),
                .copy("Resources/pricing_litellm_snapshot.json"),
                .copy("Resources/pricing_models_dev_snapshot.json")
            ],
            swiftSettings: [
                .swiftLanguageMode(.v6)
            ]
        ),
        .testTarget(
            name: "UsageKitTests",
            dependencies: ["UsageKit"],
            path: "Tests/UsageKitTests",
            swiftSettings: [
                .swiftLanguageMode(.v6)
            ]
        )
    ]
)
