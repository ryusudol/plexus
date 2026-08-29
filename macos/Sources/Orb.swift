import AppKit
import QuartzCore

/// Hub-and-spoke mark for the idle orb — a repo map, not a vendor mascot.
final class PlexusGlyph: NSView {
  var ink = NSColor(calibratedRed: 1, green: 79 / 255, blue: 203 / 255, alpha: 1) {
    didSet { needsDisplay = true }
  }

  override func draw(_ dirtyRect: NSRect) {
    let cx = bounds.midX
    let cy = bounds.midY
    let r = min(bounds.width, bounds.height) * 0.5
    let hub = NSPoint(x: cx, y: cy)
    let orbit = r * 0.4
    let start = CGFloat.pi / 2
    let nodes = (0..<3).map { i -> NSPoint in
      let a = start + CGFloat(i) * (.pi * 2 / 3)
      return NSPoint(x: cx + cos(a) * orbit, y: cy + sin(a) * orbit)
    }
    ink.withAlphaComponent(0.7).setStroke()
    for node in nodes {
      let line = NSBezierPath()
      line.move(to: hub)
      line.line(to: node)
      line.lineWidth = 1.35
      line.lineCapStyle = .round
      line.stroke()
    }
    ink.setFill()
    for node in nodes {
      let d = r * 0.168
      NSBezierPath(ovalIn: NSRect(x: node.x - d / 2, y: node.y - d / 2, width: d, height: d)).fill()
    }
    let core = r * 0.26
    NSBezierPath(ovalIn: NSRect(x: hub.x - core / 2, y: hub.y - core / 2, width: core, height: core)).fill()
  }
}

final class OrbDisc: NSView {
  var fill = NSColor.black {
    didSet { needsDisplay = true }
  }

  override var isOpaque: Bool { false }

  override func draw(_ dirtyRect: NSRect) {
    fill.setFill()
    NSBezierPath(ovalIn: bounds).fill()
  }
}

final class OrbClose: NSView {
  var onClick: (() -> Void)?
  var light = false {
    didSet { needsDisplay = true }
  }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.masksToBounds = false
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
      ? NSColor(calibratedWhite: 0.18, alpha: 0.82)
      : NSColor(calibratedWhite: 0.08, alpha: 0.88)
    fill.setFill()
    NSBezierPath(ovalIn: box).fill()
    let ink = light
      ? NSColor(calibratedWhite: 1, alpha: 0.96)
      : NSColor(calibratedWhite: 1, alpha: 0.92)
    ink.setStroke()
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
  private let disc = OrbDisc(frame: .zero)
  private let glyph = PlexusGlyph(frame: .zero)
  private let closeBtn = OrbClose(frame: .zero)
  private var hoverTimer: Timer?
  private var tracking: NSTrackingArea?
  private var downMouse: NSPoint?
  private var startOrigin: NSPoint = .zero
  private var dragging = false

  var onClick: (() -> Void)?
  var onMoved: (() -> Void)?
  var onDismiss: (() -> Void)?

  var accent: NSColor = NSColor(calibratedRed: 1, green: 79 / 255, blue: 203 / 255, alpha: 1) {
    didSet { glyph.ink = accent }
  }

  var light = false {
    didSet { applyAppearance() }
  }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.masksToBounds = false
    layer?.backgroundColor = NSColor.clear.cgColor
    layer?.shadowColor = NSColor.black.cgColor
    layer?.shadowOffset = CGSize(width: 0, height: -1)
    layer?.shadowRadius = 3.5
    layer?.shadowOpacity = 0.18

    disc.wantsLayer = false
    addSubview(disc)

    glyph.wantsLayer = true
    disc.addSubview(glyph)

    let d: CGFloat = 16
    closeBtn.frame = NSRect(x: bounds.width - d - 1, y: bounds.height - d - 1, width: d, height: d)
    closeBtn.alphaValue = 0
    closeBtn.isHidden = true
    closeBtn.onClick = { [weak self] in self?.onDismiss?() }
    addSubview(closeBtn)
    applyAppearance()
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    window?.isOpaque = false
    window?.backgroundColor = .clear
    window?.hasShadow = false
    needsLayout = true
    layoutSubtreeIfNeeded()
    updateTrackingAreas()
  }

  override func layout() {
    super.layout()
    let discSize = min(bounds.width, bounds.height) * 0.82
    disc.frame = NSRect(
      x: (bounds.width - discSize) / 2,
      y: (bounds.height - discSize) / 2,
      width: discSize,
      height: discSize
    )
    let inset = discSize * 0.16
    glyph.frame = disc.bounds.insetBy(dx: inset, dy: inset)
    let close: CGFloat = 16
    closeBtn.frame = NSRect(
      x: min(max(0, disc.frame.maxX - close * 0.72), bounds.width - close),
      y: min(max(0, disc.frame.maxY - close * 0.72), bounds.height - close),
      width: close,
      height: close
    )
    layer?.shadowPath = CGPath(ellipseIn: disc.frame, transform: nil)
  }

  private func applyAppearance() {
    disc.fill = light ? .white : .black
    layer?.shadowOpacity = Float(light ? 0.12 : 0.22)
    closeBtn.light = light
    glyph.ink = accent
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    if !closeBtn.isHidden, closeBtn.alphaValue > 0.2, closeBtn.frame.contains(point) {
      return closeBtn
    }
    let center = NSPoint(x: disc.frame.midX, y: disc.frame.midY)
    let radius = disc.bounds.width / 2
    if radius > 0, hypot(point.x - center.x, point.y - center.y) <= radius {
      return self
    }
    return nil
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
    hideClose()
  }

  private func addPulse() {
    glyph.layer?.removeAnimation(forKey: "pulse")
    let pulse = CAKeyframeAnimation(keyPath: "transform")
    pulse.values = [
      NSValue(caTransform3D: CATransform3DIdentity),
      NSValue(caTransform3D: CATransform3DMakeScale(1.05, 1.05, 1)),
      NSValue(caTransform3D: CATransform3DIdentity),
    ]
    pulse.keyTimes = [0, 0.5, 1]
    pulse.duration = 2.4
    pulse.repeatCount = .infinity
    pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    glyph.layer?.add(pulse, forKey: "pulse")
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    let area = NSTrackingArea(
      rect: bounds,
      options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(area)
    tracking = area
  }

  private func pointerInside() -> Bool {
    guard let window else { return false }
    let loc = convert(window.mouseLocationOutsideOfEventStream, from: nil)
    if closeBtn.frame.insetBy(dx: -8, dy: -8).contains(loc) { return true }
    let center = NSPoint(x: disc.frame.midX, y: disc.frame.midY)
    let radius = disc.bounds.width / 2 + 10
    return radius > 0 && hypot(loc.x - center.x, loc.y - center.y) <= radius
  }

  override func mouseEntered(with event: NSEvent) {
    hoverTimer?.invalidate()
    hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.28, repeats: false) { [weak self] _ in
      self?.showClose()
    }
    RunLoop.main.add(hoverTimer!, forMode: .common)
  }

  override func mouseExited(with event: NSEvent) {
    hoverTimer?.invalidate()
    if pointerInside() {
      showClose()
      return
    }
    hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: false) { [weak self] _ in
      guard let self else { return }
      if self.pointerInside() {
        self.showClose()
        return
      }
      self.hideClose()
    }
    RunLoop.main.add(hoverTimer!, forMode: .common)
  }

  private func showClose() {
    closeBtn.isHidden = false
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.16
      closeBtn.animator().alphaValue = 1
    }
  }

  private func hideClose() {
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.12
      closeBtn.animator().alphaValue = 0
    } completionHandler: { [weak self] in
      if self?.closeBtn.alphaValue == 0 { self?.closeBtn.isHidden = true }
    }
  }

  override func mouseDown(with event: NSEvent) {
    let loc = convert(event.locationInWindow, from: nil)
    if !closeBtn.isHidden, closeBtn.alphaValue > 0.2, closeBtn.frame.contains(loc) {
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
    if !closeBtn.isHidden, closeBtn.alphaValue > 0.2, closeBtn.frame.contains(loc) {
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
