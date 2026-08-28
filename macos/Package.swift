// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "PlexusHUD",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "PlexusHUD",
      path: "Sources",
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("WebKit"),
        .linkedFramework("QuartzCore"),
      ]
    )
  ]
)
