// Reads text from images with the macOS Vision framework (accurate mode). One JSON line per input file:
// {"file":path,"lines":[{"text":"...","words":[{"text":"...","x0":0..1,"y0":0..1,"x1":..,"y1":..}]}]}
// Boxes are normalised with the origin at the top left, like the rest of Kairos. Compiled on first use by agents/ocr.js.
import Foundation
import Vision
import ImageIO

func words(of cand: VNRecognizedText) -> [[String: Any]] {
    var out: [[String: Any]] = []
    let s = cand.string
    var idx = s.startIndex
    while idx < s.endIndex {
        while idx < s.endIndex, s[idx].isWhitespace { idx = s.index(after: idx) }
        if idx >= s.endIndex { break }
        var end = idx
        while end < s.endIndex, !s[end].isWhitespace { end = s.index(after: end) }
        if let box = try? cand.boundingBox(for: idx..<end) {
            let r = box.boundingBox
            out.append(["text": String(s[idx..<end]), "x0": r.minX, "y0": 1 - r.maxY, "x1": r.maxX, "y1": 1 - r.minY])
        }
        idx = end
    }
    return out
}

for path in CommandLine.arguments.dropFirst() {
    var lines: [[String: Any]] = []
    if let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
       let img = CGImageSourceCreateImageAtIndex(src, 0, nil) {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = false // secrets and code are not words; correction would "fix" them
        try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
        for obs in (req.results ?? []) {
            guard let cand = obs.topCandidates(1).first else { continue }
            let w = words(of: cand)
            if !w.isEmpty { lines.append(["text": cand.string, "words": w]) }
        }
    }
    let data = try! JSONSerialization.data(withJSONObject: ["file": path, "lines": lines])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
