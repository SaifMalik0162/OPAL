import CoreGraphics
import Foundation
import ImageIO

guard CommandLine.arguments.count >= 3 else {
    fputs("usage: build-opal-icons.swift <source-png> <output-icns> [output-iconset]\n", stderr)
    exit(2)
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
let iconsetURL = CommandLine.arguments.count >= 4 ? URL(fileURLWithPath: CommandLine.arguments[3]) : nil
let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary

guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, sourceOptions),
      let sourceImage = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, "com.apple.icns" as CFString, 7, nil) else {
    fputs("could not create the OPAL icon source or destination\n", stderr)
    exit(1)
}

if let iconsetURL {
    do {
        try FileManager.default.createDirectory(at: iconsetURL, withIntermediateDirectories: true)
    } catch {
        fputs("could not create iconset directory: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

let iconSizes: [(Int, String)] = [
    (16, "icon_16x16.png"),
    (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png"),
]
let icnsSizes = [16, 32, 64, 128, 256, 512, 1024]

for (index, entry) in iconSizes.enumerated() {
    let (size, filename) = entry
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceThumbnailMaxPixelSize: size,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
    ]
    let properties = options as CFDictionary
    if let image = CGImageSourceCreateThumbnailAtIndex(source, 0, properties) {
        if icnsSizes.contains(size) && (index == 0 || iconSizes[index - 1].0 != size) {
            CGImageDestinationAddImage(destination, image, nil)
        }
        if let iconsetURL {
            let pngURL = iconsetURL.appendingPathComponent(filename)
            if let pngDestination = CGImageDestinationCreateWithURL(pngURL as CFURL, "public.png" as CFString, 1, nil) {
                CGImageDestinationAddImage(pngDestination, image, nil)
                _ = CGImageDestinationFinalize(pngDestination)
            }
        }
    } else {
        CGImageDestinationAddImage(destination, sourceImage, nil)
    }
}

guard CGImageDestinationFinalize(destination) else {
    fputs("could not finalize the OPAL icns file\n", stderr)
    exit(1)
}
