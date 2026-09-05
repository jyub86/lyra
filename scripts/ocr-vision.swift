// macOS Vision OCR — 이미지에서 텍스트를 읽어 위치·크기와 함께 JSON Lines로 출력한다.
// 찬양 PPT의 가사를 데이터화할 때 쓴다(scripts/extract-song-lyrics.js). 오프라인·무료·한국어 정확.
//
// 왜 좌표까지 내보내는가: 가사 슬라이드에는 "크게 표시되는 가사"와 "작게 박힌 목차·출처"가
// 같이 있어서, 글자 높이와 반복 여부로 걸러내야 실제 가사만 남는다.
//
// 빌드: swiftc -O -o data/bin/ocr scripts/ocr-vision.swift   (스크립트가 자동으로 함)
// 사용: ocr <이미지경로>...
// 출력: 한 줄에 한 페이지 → {"file":"…","lines":[{"t":"텍스트","x":0..1,"y":0..1,"w":..,"h":..,"c":신뢰도}]}
//       y는 위가 0(화면 좌표와 같게 뒤집어 둔다. Vision 원본은 아래가 0)
import Foundation
import Vision
import AppKit

struct Line: Codable { let t: String; let x: Double; let y: Double; let w: Double; let h: Double; let c: Double }
struct Page: Codable { let file: String; let lines: [Line] }

func ocr(_ path: String) -> [Line] {
    guard let img = NSImage(contentsOfFile: path),
          let data = img.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: data),
          let cg = bitmap.cgImage else { return [] }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["ko-KR", "en-US"]
    req.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([req]) } catch { return [] }
    guard let obs = req.results else { return [] }
    // 화면에 보이는 순서(위 → 아래, 같은 줄이면 왼 → 오른쪽)
    let sorted = obs.sorted { a, b in
        let ay = a.boundingBox.midY, by = b.boundingBox.midY
        if abs(ay - by) > 0.02 { return ay > by }
        return a.boundingBox.minX < b.boundingBox.minX
    }
    return sorted.compactMap { o in
        guard let cand = o.topCandidates(1).first else { return nil }
        let b = o.boundingBox
        return Line(t: cand.string, x: b.minX, y: 1 - b.maxY, w: b.width, h: b.height, c: Double(cand.confidence))
    }
}

let enc = JSONEncoder()
for path in CommandLine.arguments.dropFirst() {
    let page = Page(file: path, lines: ocr(path))
    if let d = try? enc.encode(page), let s = String(data: d, encoding: .utf8) { print(s) }
}
