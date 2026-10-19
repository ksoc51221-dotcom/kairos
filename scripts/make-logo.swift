// Turns assets/hermes-source.png (the logo on a dark tile) into: assets/icon.png (white tile + the mark, 1024 px) and assets/icon.icns.
// Run: swift scripts/make-logo.swift . [markScale=1.0] [outPath=assets/icon.png]   (macOS only: CoreGraphics)
// How: the source has two flat greens on one flat near-black. Every pixel is sorted into background, light green, dark green or an edge.
// Edge pixels next to the background take the green they touch and get an alpha from how far they are from the background, so the mark keeps
// smooth edges when it is laid on white. Pixels between the two greens are left as they are.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
let markScale = CommandLine.arguments.count > 2 ? Double(CommandLine.arguments[2]) ?? 1.0 : 1.0
let outPath = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : root.appendingPathComponent("assets/icon.png").path
let src = root.appendingPathComponent("assets/hermes-source.png")
guard let isrc = CGImageSourceCreateWithURL(src as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(isrc, 0, nil) else { fatalError("cannot read \(src.path)") }
let W = img.width, H = img.height
var px = [UInt8](repeating: 0, count: W * H * 4)
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let info = CGImageAlphaInfo.premultipliedLast.rawValue
let ctx = CGContext(data: &px, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: cs, bitmapInfo: info)!
ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
func at(_ x: Int, _ y: Int) -> (Int, Int, Int, Int) { let i = (y * W + x) * 4; return (Int(px[i]), Int(px[i+1]), Int(px[i+2]), Int(px[i+3])) }
let bg = at(W / 2, 150), light = at(900, 500), dark = at(600, 620)  // sampled from known flat spots
func dist(_ a: (Int, Int, Int, Int), _ b: (Int, Int, Int, Int)) -> Int { abs(a.0 - b.0) + abs(a.1 - b.1) + abs(a.2 - b.2) }
enum K { case bg, light, dark, edge, outside }
func kind(_ x: Int, _ y: Int) -> K {
  let p = at(x, y); if p.3 < 250 { return .outside }
  if dist(p, bg) < 10 { return .bg }; if dist(p, light) < 10 { return .light }; if dist(p, dark) < 10 { return .dark }; return .edge
}
// the mark alone: green with alpha, background transparent
var mark = [UInt8](repeating: 0, count: W * H * 4)
for y in 0..<H { for x in 0..<W {
  let k = kind(x, y), i = (y * W + x) * 4, p = at(x, y)
  func put(_ c: (Int, Int, Int, Int), _ a: Double) { mark[i] = UInt8(Double(c.0) * a); mark[i+1] = UInt8(Double(c.1) * a); mark[i+2] = UInt8(Double(c.2) * a); mark[i+3] = UInt8(a * 255) } // premultiplied
  switch k {
  case .outside, .bg: break
  case .light: put(light, 1)
  case .dark: put(dark, 1)
  case .edge:
    var nl = 0, nd = 0, nb = 0
    for dy in -3...3 { for dx in -3...3 { let xx = x + dx, yy = y + dy; if xx < 0 || yy < 0 || xx >= W || yy >= H { continue }
      switch kind(xx, yy) { case .light: nl += 1; case .dark: nd += 1; case .bg, .outside: nb += 1; default: break } } }
    if nb == 0 { put(p, 1) } else {  // touches the background: green it touches, alpha by distance from the background
      let f = nl >= nd ? light : dark, a = min(1.0, max(0.0, Double(p.1 - bg.1) / Double(f.1 - bg.1))); put(f, a) }
  }
} }

// icon: white squircle (macOS grid: 824 of 1024, radius ~185) + the mark at the same scale as in the source, with the usual soft shadow
let S = 1024, tile = 824, off = (S - tile) / 2
var out = [UInt8](repeating: 0, count: S * S * 4)
let octx = CGContext(data: &out, width: S, height: S, bitsPerComponent: 8, bytesPerRow: S * 4, space: cs, bitmapInfo: info)!
octx.interpolationQuality = .high
let rect = CGRect(x: off, y: off, width: tile, height: tile)
octx.saveGState(); octx.setShadow(offset: CGSize(width: 0, height: -10), blur: 22, color: CGColor(gray: 0, alpha: 0.28))
octx.addPath(CGPath(roundedRect: rect, cornerWidth: 185, cornerHeight: 185, transform: nil)); octx.setFillColor(CGColor(gray: 1, alpha: 1)); octx.fillPath(); octx.restoreGState()
mark.withUnsafeMutableBytes { raw in
  let mctx = CGContext(data: raw.baseAddress, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: cs, bitmapInfo: info)!
  let grow = Double(tile) * (markScale - 1) / 2
  octx.saveGState(); octx.addPath(CGPath(roundedRect: rect, cornerWidth: 185, cornerHeight: 185, transform: nil)); octx.clip()
  octx.draw(mctx.makeImage()!, in: rect.insetBy(dx: -grow, dy: -grow)); octx.restoreGState()
}
func save(_ im: CGImage, _ path: String) { let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!; CGImageDestinationAddImage(d, im, nil); CGImageDestinationFinalize(d) }
save(octx.makeImage()!, outPath)
print("wrote \(outPath)")
