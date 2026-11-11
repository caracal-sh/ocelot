import Foundation
import os

/// Where the app is running. Unit tests run inside the app (the XCTest host): in that case it must not touch the
/// user's real environment (preferences, user folders, omp, its broker and gateway, Sparkle) or show prompts for it.
/// Every such guard reads this one flag.
enum AppEnvironment {
    static let underTest = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
}

enum AppInfo {
    static var name: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "Ocelot" }
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0" }
    static var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0" }

    private static let editorLogger = Logger(subsystem: "sh.caracal.ocelot", category: "editor")

    static func editorLog(level: String, message: String) {
        switch level {
        case "error": editorLogger.error("\(message, privacy: .public)")
        case "warn": editorLogger.warning("\(message, privacy: .public)")
        case "debug": editorLogger.debug("\(message, privacy: .public)")
        default: editorLogger.info("\(message, privacy: .public)")
        }
    }
}
