import AppKit
import QuartzCore

func bundledPNG(_ name: String) -> NSImage? {
  let urls: [URL?] = [
    Bundle.main.url(forResource: name, withExtension: "png"),
    Bundle.main.resourceURL?.appendingPathComponent("\(name).png"),
    Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/\(name).png"),
  ]
  for url in urls {
    guard let url, FileManager.default.fileExists(atPath: url.path) else { continue }
    if let image = NSImage(contentsOf: url) { return image }
  }
  return nil
}

/// Crop the squircle app icon so the face fills a circle (no black ring).
func circularFilledIcon(_ source: NSImage, size: CGFloat, zoom: CGFloat = 1.24) -> NSImage {
  let out = NSImage(size: NSSize(width: size, height: size))
  out.lockFocus()
  NSGraphicsContext.current?.imageInterpolation = .high
  let rect = NSRect(origin: .zero, size: NSSize(width: size, height: size))
  NSBezierPath(ovalIn: rect).addClip()
  let draw = NSRect(
    x: (size - size * zoom) / 2,
    y: (size - size * zoom) / 2,
    width: size * zoom,
    height: size * zoom
  )
  source.draw(
    in: draw,
    from: NSRect(origin: .zero, size: source.size),
    operation: .copy,
    fraction: 1,
    respectFlipped: true,
    hints: [.interpolation: NSImageInterpolation.high]
  )
  out.unlockFocus()
  out.isTemplate = false
  return out
}

final class TinyClose: NSView {
  var onClick: (() -> Void)?
  var light = false {
    didSet { needsDisplay = true }
  }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    toolTip = "Close"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:)") }

  override func resetCursorRects() {
    addCursorRect(bounds, cursor: .pointingHand)
  }

  override func draw(_ dirtyRect: NSRect) {
    let d = min(bounds.width, bounds.height)
    let box = NSRect(
      x: (bounds.width - d) / 2,
      y: (bounds.height - d) / 2,
      width: d,
      height: d
    )
    let fill = light
      ? NSColor(calibratedWhite: 0.18, alpha: 0.78)
      : NSColor(calibratedWhite: 0.07, alpha: 0.82)
    fill.setFill()
    NSBezierPath(ovalIn: box).fill()
    NSColor(calibratedWhite: 1, alpha: 0.92).setStroke()
    let inset = d * 0.31
    let p = NSBezierPath()
    p.move(to: NSPoint(x: box.minX + inset, y: box.minY + inset))
    p.line(to: NSPoint(x: box.maxX - inset, y: box.maxY - inset))
    p.move(to: NSPoint(x: box.minX + inset, y: box.maxY - inset))
    p.line(to: NSPoint(x: box.maxX - inset, y: box.minY + inset))
    p.lineWidth = 1.35
    p.lineCapStyle = .round
    p.stroke()
  }

  override func mouseUp(with event: NSEvent) {
    let loc = convert(event.locationInWindow, from: nil)
    if bounds.contains(loc) { onClick?() }
  }
}

final class OrbPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class OrbView: NSView {
  private let avatar = NSView()
  private let face = NSImageView()
  private let dismiss = TinyClose(frame: .zero)
  private var faces: [String: NSImage] = [:]
  private var play: [(String, TimeInterval)] = []
  private var step = 0
  private var frameTimer: Timer?
  private var hoverTimer: Timer?
  private var tracking: NSTrackingArea?
  private var downMouse: NSPoint?
  private var startOrigin: NSPoint = .zero
  private var dragging = false

  var onClick: (() -> Void)?
  var onMoved: (() -> Void)?
  var onDismiss: (() -> Void)?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.masksToBounds = false
    layer?.backgroundColor = NSColor.clear.cgColor

    avatar.wantsLayer = true
    avatar.layer?.cornerRadius = frame.width / 2
    avatar.layer?.masksToBounds = true
    avatar.layer?.backgroundColor = NSColor.black.cgColor
    avatar.layer?.borderWidth = 1.2
    avatar.layer?.borderColor = NSColor(calibratedWhite: 1, alpha: 0.22).cgColor
    avatar.frame = bounds
    avatar.autoresizingMask = [.width, .height]
    addSubview(avatar)

    face.imageScaling = .scaleAxesIndependently
    face.animates = false
    face.wantsLayer = true
    face.frame = avatar.bounds
    face.autoresizingMask = [.width, .height]
    avatar.addSubview(face)

    let source = bundledPNG("agent")
    let filled = source.map { circularFilledIcon($0, size: max(frame.width, 58)) }
    faces["idle"] = filled
    faces["blink"] = filled
    faces["left"] = filled
    faces["right"] = filled
    face.image = filled
    play = [
      ("idle", 1.7),
      ("left", 0.65),
      ("idle", 0.9),
      ("blink", 0.12),
      ("idle", 0.16),
      ("blink", 0.1),
      ("idle", 1.35),
      ("right", 0.65),
      ("idle", 1.5),
      ("blink", 0.14),
    ]

    let d: CGFloat = 16
    dismiss.frame = NSRect(x: bounds.width - d + 2, y: bounds.height - d + 2, width: d, height: d)
    dismiss.autoresizingMask = [.minXMargin, .minYMargin]
    dismiss.alphaValue = 0
    dismiss.isHidden = true
    dismiss.onClick = { [weak self] in self?.onDismiss?() }
    addSubview(dismiss)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:)") }

  func startAnimating() {
    stopAnimating()
    step = 0
    showStep()
    addBob()
    scheduleNext()
  }

  func stopAnimating() {
    frameTimer?.invalidate()
    frameTimer = nil
    hoverTimer?.invalidate()
    hoverTimer = nil
    face.layer?.removeAllAnimations()
    avatar.layer?.removeAllAnimations()
    hideDismiss()
  }

  private func addBob() {
    face.layer?.removeAnimation(forKey: "bob")
    let bob = CAKeyframeAnimation(keyPath: "transform")
    // Scale up only so the circular clip never shows a black ring.
    bob.values = [
      NSValue(caTransform3D: CATransform3DIdentity),
      NSValue(caTransform3D: CATransform3DMakeScale(1.06, 1.06, 1)),
      NSValue(caTransform3D: CATransform3DMakeScale(1.02, 1.02, 1)),
      NSValue(caTransform3D: CATransform3DIdentity),
    ]
    bob.keyTimes = [0, 0.4, 0.72, 1]
    bob.duration = 2.1
    bob.repeatCount = .infinity
    bob.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    face.layer?.add(bob, forKey: "bob")

    avatar.layer?.removeAnimation(forKey: "glow")
    let glow = CABasicAnimation(keyPath: "borderColor")
    glow.fromValue = NSColor(calibratedWhite: 1, alpha: 0.12).cgColor
    glow.toValue = NSColor(calibratedWhite: 1, alpha: 0.55).cgColor
    glow.duration = 1.5
    glow.autoreverses = true
    glow.repeatCount = .infinity
    avatar.layer?.add(glow, forKey: "glow")
  }

  private func showStep() {
    let name = play[step % play.count].0
    face.image = faces[name] ?? faces["idle"]
  }

  private func scheduleNext() {
    frameTimer?.invalidate()
    let wait = play[step % play.count].1
    frameTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
      guard let self else { return }
      self.step += 1
      self.showStep()
      self.scheduleNext()
    }
    RunLoop.main.add(frameTimer!, forMode: .common)
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    let area = NSTrackingArea(
      rect: bounds.insetBy(dx: -8, dy: -8),
      options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
    tracking = area
  }

  override func mouseEntered(with event: NSEvent) {
    hoverTimer?.invalidate()
    hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: false) { [weak self] _ in
      self?.showDismiss()
    }
    RunLoop.main.add(hoverTimer!, forMode: .common)
  }

  override func mouseExited(with event: NSEvent) {
    hoverTimer?.invalidate()
    hoverTimer = nil
    hideDismiss()
  }

  private func showDismiss() {
    dismiss.isHidden = false
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.16
      dismiss.animator().alphaValue = 1
    }
  }

  private func hideDismiss() {
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.12
      dismiss.animator().alphaValue = 0
    } completionHandler: { [weak self] in
      if self?.dismiss.alphaValue == 0 { self?.dismiss.isHidden = true }
    }
  }

  override func mouseDown(with event: NSEvent) {
    let loc = convert(event.locationInWindow, from: nil)
    if !dismiss.isHidden, dismiss.alphaValue > 0.2, dismiss.frame.contains(loc) {
      return
    }
    downMouse = NSEvent.mouseLocation
    startOrigin = window?.frame.origin ?? .zero
    dragging = false
  }

  override func mouseDragged(with event: NSEvent) {
    guard let down = downMouse, let window else { return }
    let now = NSEvent.mouseLocation
    if hypot(now.x - down.x, now.y - down.y) > 3 { dragging = true }
    guard dragging else { return }
    var frame = window.frame
    frame.origin = NSPoint(x: startOrigin.x + (now.x - down.x), y: startOrigin.y + (now.y - down.y))
    if let screen = NSScreen.screens.first(where: { $0.frame.contains(now) })?.visibleFrame
      ?? NSScreen.main?.visibleFrame
    {
      frame.origin.x = min(max(screen.minX, frame.origin.x), screen.maxX - frame.width)
      frame.origin.y = min(max(screen.minY, frame.origin.y), screen.maxY - frame.height)
    }
    window.setFrame(frame, display: true)
  }

  override func mouseUp(with event: NSEvent) {
    let loc = convert(event.locationInWindow, from: nil)
    if !dismiss.isHidden, dismiss.alphaValue > 0.2, dismiss.frame.contains(loc) {
      onDismiss?()
      downMouse = nil
      dragging = false
      return
    }
    if dragging {
      onMoved?()
    } else {
      onClick?()
    }
    downMouse = nil
    dragging = false
  }
}
