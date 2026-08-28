import AppKit
import QuartzCore

final class HoverRoot: NSView {
  var onHover: ((Bool) -> Void)?
  private var tracking: NSTrackingArea?

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

  override func mouseEntered(with event: NSEvent) { onHover?(true) }
  override func mouseExited(with event: NSEvent) { onHover?(false) }
}

final class GrabBar: NSView {
  override var isFlipped: Bool { true }
  override var mouseDownCanMoveWindow: Bool { true }

  var light = false {
    didSet { needsDisplay = true }
  }

  var titleText = "Plexus" {
    didSet { needsDisplay = true }
  }

  override func mouseDown(with event: NSEvent) {
    window?.performDrag(with: event)
  }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.clear.setFill()
    dirtyRect.fill()
    let titleColor = light
      ? NSColor(calibratedWhite: 0.12, alpha: 0.92)
      : NSColor(calibratedWhite: 0.92, alpha: 0.92)
    let para = NSMutableParagraphStyle()
    para.lineBreakMode = .byTruncatingTail
    para.alignment = .center
    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 12, weight: .regular),
      .foregroundColor: titleColor,
      .paragraphStyle: para,
    ]
    let text = titleText as NSString
    let lineH = ceil(text.size(withAttributes: attrs).height)
    let inset: CGFloat = 10
    let clip = NSRect(
      x: inset,
      y: (bounds.height - lineH) / 2,
      width: max(8, bounds.width - inset * 2),
      height: lineH
    )
    text.draw(with: clip, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs)
  }
}

final class TipBubble: NSView {
  override var isFlipped: Bool { true }

  var label = ""
  var keys: [String] = []
  var light = false

  func measuredSize() -> NSSize {
    let labelAttrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 11, weight: .medium),
    ]
    var width: CGFloat = 20
    width += (label as NSString).size(withAttributes: labelAttrs).width
    let keyAttrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
    ]
    if !keys.isEmpty { width += 6 }
    for key in keys {
      let w = (key as NSString).size(withAttributes: keyAttrs).width
      width += max(18, w + 10) + 3
    }
    return NSSize(width: ceil(width), height: 28)
  }

  override func draw(_ dirtyRect: NSRect) {
    let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
    if light {
      NSColor.white.setFill()
      NSColor(calibratedWhite: 0, alpha: 0.08).setStroke()
    } else {
      NSColor(calibratedWhite: 0.14, alpha: 0.96).setFill()
      NSColor(calibratedWhite: 1, alpha: 0.12).setStroke()
    }
    path.fill()
    path.lineWidth = 1
    path.stroke()
    var x: CGFloat = 10
    let labelAttrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 11, weight: .medium),
      .foregroundColor: light
        ? NSColor(calibratedWhite: 0.12, alpha: 1)
        : NSColor(calibratedWhite: 0.96, alpha: 1),
    ]
    let labelSize = (label as NSString).size(withAttributes: labelAttrs)
    (label as NSString).draw(at: NSPoint(x: x, y: (bounds.height - labelSize.height) / 2), withAttributes: labelAttrs)
    x += labelSize.width + 8
    let keyAttrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
      .foregroundColor: light
        ? NSColor(calibratedWhite: 0.28, alpha: 1)
        : NSColor(calibratedWhite: 0.88, alpha: 1),
    ]
    for key in keys {
      let sz = (key as NSString).size(withAttributes: keyAttrs)
      let box = NSRect(x: x, y: (bounds.height - 18) / 2, width: max(18, sz.width + 10), height: 18)
      if light {
        NSColor(calibratedWhite: 0.94, alpha: 1).setFill()
      } else {
        NSColor(calibratedWhite: 1, alpha: 0.12).setFill()
      }
      NSBezierPath(roundedRect: box, xRadius: 5, yRadius: 5).fill()
      (key as NSString).draw(
        at: NSPoint(x: box.midX - sz.width / 2, y: box.midY - sz.height / 2),
        withAttributes: keyAttrs
      )
      x = box.maxX + 3
    }
  }
}

final class ChromeIcon: NSView {
  var symbolName: String
  var tipLabel: String
  var tipKeys: [String]
  var onClick: (() -> Void)?
  var light = false {
    didSet {
      needsDisplay = true
      hoverFill.backgroundColor = hoverColor
    }
  }

  var lockHover = false {
    didSet {
      if lockHover { clearHover() }
    }
  }

  private var tracking: NSTrackingArea?
  private var hoverTimer: Timer?
  private var tipPanel: NSPanel?
  private var hovering = false
  private let hoverFill = CALayer()

  init(symbol: String, tip: String, keys: [String] = []) {
    symbolName = symbol
    tipLabel = tip
    tipKeys = keys
    super.init(frame: NSRect(x: 0, y: 0, width: 28, height: 28))
    wantsLayer = true
    layer?.cornerRadius = 6
    layer?.masksToBounds = true
    layer?.backgroundColor = NSColor.clear.cgColor
    hoverFill.cornerRadius = 6
    hoverFill.opacity = 0
    hoverFill.backgroundColor = hoverColor
    layer?.insertSublayer(hoverFill, at: 0)
  }

  // Same mix as `.stage-tools button:hover`: color-mix(in srgb, var(--text) 16%, transparent).
  private var hoverColor: CGColor {
    light
      ? NSColor(srgbRed: 22 / 255, green: 22 / 255, blue: 26 / 255, alpha: 0.16).cgColor
      : NSColor(srgbRed: 242 / 255, green: 242 / 255, blue: 244 / 255, alpha: 0.16).cgColor
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:)") }

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

  override func layout() {
    super.layout()
    hoverFill.frame = bounds
    hoverFill.backgroundColor = hoverColor
  }

  private func setHovering(_ on: Bool) {
    hovering = on
    hoverFill.backgroundColor = hoverColor
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.2)
    CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeInEaseOut))
    hoverFill.opacity = on ? 1 : 0
    CATransaction.commit()
  }

  override func draw(_ dirtyRect: NSRect) {
    let config = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
    guard let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: tipLabel)?
      .withSymbolConfiguration(config)
    else { return }
    image.isTemplate = true
    let size = NSSize(width: 15, height: 15)
    let rect = NSRect(
      x: (bounds.width - size.width) / 2,
      y: (bounds.height - size.height) / 2,
      width: size.width,
      height: size.height
    )
    let color = light
      ? NSColor(calibratedWhite: 0.16, alpha: 0.92)
      : NSColor(calibratedWhite: 0.96, alpha: 0.95)
    NSGraphicsContext.saveGraphicsState()
    image.draw(in: rect)
    color.set()
    rect.fill(using: .sourceAtop)
    NSGraphicsContext.restoreGraphicsState()
  }

  func clearHover() {
    hoverTimer?.invalidate()
    hoverTimer = nil
    setHovering(false)
    hideTip()
  }

  override func mouseEntered(with event: NSEvent) {
    if lockHover { return }
    setHovering(true)
    hoverTimer?.invalidate()
    hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.28, repeats: false) { [weak self] _ in
      self?.showTip()
    }
    RunLoop.main.add(hoverTimer!, forMode: .common)
  }

  override func mouseExited(with event: NSEvent) {
    setHovering(false)
    hoverTimer?.invalidate()
    hoverTimer = nil
    hideTip()
  }

  override func mouseUp(with event: NSEvent) {
    let loc = convert(event.locationInWindow, from: nil)
    if bounds.contains(loc) {
      hideTip()
      onClick?()
    }
  }

  func hideTip() {
    tipPanel?.orderOut(nil)
    tipPanel = nil
  }

  private func showTip() {
    guard window != nil else { return }
    hideTip()
    let bubble = TipBubble(frame: .zero)
    bubble.label = tipLabel
    bubble.keys = tipKeys
    bubble.light = light
    let size = bubble.measuredSize()
    bubble.frame = NSRect(origin: .zero, size: size)
    bubble.wantsLayer = true
    bubble.layer?.cornerRadius = 10
    bubble.layer?.masksToBounds = false
    bubble.layer?.shadowOpacity = light ? 0.22 : 0.45
    bubble.layer?.shadowRadius = 18
    bubble.layer?.shadowOffset = NSSize(width: 0, height: -4)
    let panel = NSPanel(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isFloatingPanel = true
    panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.floatingWindow)) + 2)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.hidesOnDeactivate = false
    panel.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
    panel.contentView = bubble
    let buttonRect = convert(bounds, to: nil)
    guard let win = window else { return }
    var origin = win.convertToScreen(buttonRect).origin
    origin.x = origin.x + buttonRect.width - size.width
    origin.y = origin.y - size.height - 8
    panel.setFrameOrigin(origin)
    panel.orderFrontRegardless()
    tipPanel = panel
  }
}

final class PickerShield: NSView {
  var hole = NSRect.zero
  var onDismiss: (() -> Void)?

  override var isOpaque: Bool { false }

  override func hitTest(_ point: NSPoint) -> NSView? {
    if isHidden { return nil }
    // Never steal web-content clicks (settings/session pickers, scrim). Only
    // title-bar chrome is captured so a press there can dismiss.
    guard let parent = superview else { return nil }
    let inParent = convert(point, to: parent)
    for view in parent.subviews {
      if view === self || view.isHidden { continue }
      if view is GrabBar || view is ChromeIcon || view is ResizeGrip {
        let local = parent.convert(inParent, to: view)
        if view.bounds.contains(local) { return self }
      }
    }
    return nil
  }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func mouseDown(with event: NSEvent) {
    onDismiss?()
  }

  override func rightMouseDown(with event: NSEvent) {
    onDismiss?()
  }
}
