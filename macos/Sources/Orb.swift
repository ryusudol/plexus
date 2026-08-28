import AppKit
import QuartzCore

/// Hub-and-spoke mark for the idle orb — a repo map, not a vendor mascot.
final class PlexusGlyph: NSView {
  override func draw(_ dirtyRect: NSRect) {
    let cx = bounds.midX
    let cy = bounds.midY
    let r = min(bounds.width, bounds.height) * 0.5
    let hub = NSPoint(x: cx, y: cy)
    let orbit = r * 0.42
    let start = CGFloat.pi / 2
    let nodes = (0..<3).map { i -> NSPoint in
      let a = start + CGFloat(i) * (.pi * 2 / 3)
      return NSPoint(x: cx + cos(a) * orbit, y: cy + sin(a) * orbit)
    }
    let spoke = NSColor(calibratedWhite: 1, alpha: 0.42)
    spoke.setStroke()
    for node in nodes {
      let line = NSBezierPath()
      line.move(to: hub)
      line.line(to: node)
      line.lineWidth = 1.5
      line.lineCapStyle = .round
      line.stroke()
    }
    let ring = NSBezierPath()
    ring.move(to: nodes[0])
    ring.line(to: nodes[1])
    ring.line(to: nodes[2])
    ring.close()
    ring.lineWidth = 1.15
    ring.lineJoinStyle = .round
    ring.lineCapStyle = .round
    ring.stroke()
    let ink = NSColor(calibratedWhite: 1, alpha: 0.96)
    ink.setFill()
    for node in nodes {
      let d = r * 0.2
      NSBezierPath(ovalIn: NSRect(x: node.x - d / 2, y: node.y - d / 2, width: d, height: d)).fill()
    }
    let core = r * 0.3
    NSBezierPath(ovalIn: NSRect(x: hub.x - core / 2, y: hub.y - core / 2, width: core, height: core)).fill()
  }
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
  private let glyph = PlexusGlyph(frame: .zero)
  private let dismiss = TinyClose(frame: .zero)
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

    let inset = frame.width * 0.08
    glyph.frame = avatar.bounds.insetBy(dx: inset, dy: inset)
    glyph.autoresizingMask = [.width, .height]
    glyph.wantsLayer = true
    avatar.addSubview(glyph)

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
    addPulse()
  }

  func stopAnimating() {
    hoverTimer?.invalidate()
    hoverTimer = nil
    glyph.layer?.removeAllAnimations()
    avatar.layer?.removeAllAnimations()
    hideDismiss()
  }

  private func addPulse() {
    glyph.layer?.removeAnimation(forKey: "pulse")
    let pulse = CAKeyframeAnimation(keyPath: "transform")
    pulse.values = [
      NSValue(caTransform3D: CATransform3DIdentity),
      NSValue(caTransform3D: CATransform3DMakeScale(1.08, 1.08, 1)),
      NSValue(caTransform3D: CATransform3DMakeScale(1.02, 1.02, 1)),
      NSValue(caTransform3D: CATransform3DIdentity),
    ]
    pulse.keyTimes = [0, 0.4, 0.72, 1]
    pulse.duration = 2.1
    pulse.repeatCount = .infinity
    pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    glyph.layer?.add(pulse, forKey: "pulse")

    avatar.layer?.removeAnimation(forKey: "glow")
    let glow = CABasicAnimation(keyPath: "borderColor")
    glow.fromValue = NSColor(calibratedWhite: 1, alpha: 0.12).cgColor
    glow.toValue = NSColor(calibratedWhite: 1, alpha: 0.55).cgColor
    glow.duration = 1.5
    glow.autoreverses = true
    glow.repeatCount = .infinity
    avatar.layer?.add(glow, forKey: "glow")
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
