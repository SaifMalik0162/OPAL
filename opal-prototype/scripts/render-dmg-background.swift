import AppKit
import Foundation
import WebKit

guard CommandLine.arguments.count >= 3 else {
    fputs("usage: render-dmg-background.swift <input-svg> <output-png> [read-access-root]\n", stderr)
    exit(2)
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL
let readAccessURL = URL(fileURLWithPath: CommandLine.arguments.count >= 4 ? CommandLine.arguments[3] : inputURL.deletingLastPathComponent().path).standardizedFileURL

final class Renderer: NSObject, WKNavigationDelegate {
    private let webView: WKWebView
    private let outputURL: URL
    private let window: NSWindow

    init(webView: WKWebView, outputURL: URL, window: NSWindow) {
        self.webView = webView
        self.outputURL = outputURL
        self.window = window
        super.init()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            let configuration = WKSnapshotConfiguration()
            configuration.rect = CGRect(x: 0, y: 0, width: 720, height: 480)
            // WKWebView snapshots on this host are rendered at 2x backing scale.
            // A 720-point snapshot therefore produces the required 1440x960 PNG.
            configuration.snapshotWidth = NSNumber(value: 720)
            webView.takeSnapshot(with: configuration) { image, error in
                guard let image else {
                    fputs("could not snapshot DMG background: \(error?.localizedDescription ?? "unknown error")\n", stderr)
                    NSApp.terminate(nil)
                    return
                }

                guard let tiff = image.tiffRepresentation,
                      let bitmap = NSBitmapImageRep(data: tiff),
                      let png = bitmap.representation(using: .png, properties: [:]) else {
                    fputs("could not encode DMG background as PNG\n", stderr)
                    NSApp.terminate(nil)
                    return
                }

                do {
                    try FileManager.default.createDirectory(at: self.outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try png.write(to: self.outputURL, options: .atomic)
                    NSApp.terminate(nil)
                } catch {
                    fputs("could not write DMG background: \(error.localizedDescription)\n", stderr)
                    NSApp.terminate(nil)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fputs("could not load DMG background: \(error.localizedDescription)\n", stderr)
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)

let configuration = WKWebViewConfiguration()
let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 720, height: 480), configuration: configuration)
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 480), styleMask: .borderless, backing: .buffered, defer: false)
window.contentView = webView
window.isOpaque = true
window.backgroundColor = .black
window.orderOut(nil)

let renderer = Renderer(webView: webView, outputURL: outputURL, window: window)
webView.navigationDelegate = renderer
webView.loadFileURL(inputURL, allowingReadAccessTo: readAccessURL)
application.run()
