import AppKit
import Darwin
import QuartzCore
import WebKit

final class ExploreWebView: WKWebView {}

final class ResizeGrip: NSView {
  override func resetCursorRects() {
    addCursorRect(bounds, cursor: .crosshair)
  }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.clear.setFill()
    dirtyRect.fill()
    let color = NSColor(calibratedWhite: 1, alpha: 0.28)
    color.setStroke()
    for i in 0..<3 {
      let p = NSBezierPath()
      let inset = CGFloat(4 + i * 3)
      p.move(to: NSPoint(x: bounds.maxX - 3, y: bounds.minY + inset))
      p.line(to: NSPoint(x: bounds.maxX - inset, y: bounds.minY + 3))
      p.lineWidth = 1.1
      p.stroke()
    }
  }

  override func mouseDown(with event: NSEvent) {
    guard let window else { return }
    let startMouse = NSEvent.mouseLocation
    let startFrame = window.frame
    let minSize = window.minSize
    window.trackEvents(
      matching: [.leftMouseDragged, .leftMouseUp],
      timeout: TimeInterval.infinity,
      mode: .eventTracking,
      handler: { ev, stop in
        guard let ev else { return }
        if ev.type == .leftMouseUp {
          stop.pointee = true
          return
        }
        let now = NSEvent.mouseLocation
        var frame = startFrame
        frame.size.width = max(minSize.width, startFrame.width + (now.x - startMouse.x))
        frame.size.height = max(minSize.height, startFrame.height + (startMouse.y - now.y))
        frame.origin.y = startFrame.maxY - frame.size.height
        window.setFrame(frame, display: true)
      }
    )
  }
}

func parentPid(_ pid: pid_t) -> pid_t {
  var kinfo = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  let result = mib.withUnsafeMutableBufferPointer { buf in
    sysctl(buf.baseAddress, 4, &kinfo, &size, nil, 0)
  }
  guard result == 0 else { return 0 }
  return kinfo.kp_eproc.e_ppid
}

func ancestorPids(_ pid: pid_t) -> Set<pid_t> {
  var out: Set<pid_t> = []
  var cursor = pid
  var hops = 0
  while cursor > 1 && hops < 24 {
    if out.contains(cursor) { break }
    out.insert(cursor)
    cursor = parentPid(cursor)
    hops += 1
  }
  return out
}

func appIdentity(_ app: NSRunningApplication) -> (name: String, bundle: String, path: String) {
  let name = (app.localizedName ?? "").lowercased()
  let bundle = (app.bundleIdentifier ?? "").lowercased()
  let path = (app.bundleURL ?? app.executableURL)?.path.lowercased() ?? ""
  return (name, bundle, path)
}

/// Grok Bot is a separate chat app. The trail HUD only follows Grok Build TUI.
func isGrokBotApp(_ app: NSRunningApplication) -> Bool {
  let id = appIdentity(app)
  if id.bundle == "com.anysphere.sand" { return true }
  if id.bundle.contains("grokbot") || id.bundle.contains("grok-bot") || id.bundle.contains("grok_bot") {
    return true
  }
  if id.name.contains("grok bot") { return true }
  if id.path.contains("grok bot.app") { return true }
  return false
}

func ownsSession(frontPid: pid_t, sessionPids: [pid_t]) -> Bool {
  for session in sessionPids where session > 1 {
    if session == frontPid { return true }
    if ancestorPids(session).contains(frontPid) { return true }
    if ancestorPids(frontPid).contains(session) { return true }
  }
  return false
}

func pidPath(_ pid: pid_t) -> String {
  var buffer = [CChar](repeating: 0, count: 4096)
  let n = proc_pidpath(pid, &buffer, UInt32(buffer.count))
  if n <= 0 { return "" }
  return String(cString: buffer)
}

func appBundleRoot(_ path: String) -> String? {
  let lower = path.lowercased()
  guard let range = lower.range(of: ".app") else { return nil }
  return String(lower[..<range.upperBound])
}

func isGrokBuildHost(_ app: NSRunningApplication) -> Bool {
  if isGrokBotApp(app) { return false }
  let id = appIdentity(app)
  if id.bundle == "com.stablyai.orca" || id.bundle.hasPrefix("com.stablyai.orca.") { return true }
  if id.name == "orca" { return true }
  if id.path.contains("/orca.app") { return true }
  if id.name.contains("grok build") || id.bundle.contains("grok.build") || id.bundle.contains("grok-build") {
    return true
  }
  return false
}

func isClaudeCodeApp(_ app: NSRunningApplication) -> Bool {
  let id = appIdentity(app)
  if id.bundle.contains("anthropic.claude") { return true }
  if id.name == "claude" || id.name.contains("claude code") { return true }
  if id.path.contains("claude.app") || id.path.contains("claude code.app") { return true }
  return false
}

func isCodexApp(_ app: NSRunningApplication) -> Bool {
  let id = appIdentity(app)
  if id.bundle.contains("openai.codex") { return true }
  if id.name == "codex" { return true }
  if id.path.contains("codex.app") { return true }
  return false
}

func sessionsRunInside(_ app: NSRunningApplication, sessionPids: [pid_t]) -> Bool {
  let frontPid = app.processIdentifier
  if ownsSession(frontPid: frontPid, sessionPids: sessionPids) { return true }
  let frontRoot = appBundleRoot(appIdentity(app).path)
  for session in sessionPids where session > 1 {
    for anc in ancestorPids(session) {
      let path = pidPath(anc)
      if path.isEmpty { continue }
      if let frontRoot, let ancRoot = appBundleRoot(path), frontRoot == ancRoot { return true }
    }
  }
  return false
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
  static var shared: AppDelegate?

  private var panel: NSPanel!
  private var webView: ExploreWebView!
  private var rootView: HoverRoot!
  private var grabBar: GrabBar!
  private var sessionBtn: ChromeIcon!
  private var settingsBtn: ChromeIcon!
  private var pickerShield: PickerShield!
  private var orbPanel: OrbPanel!
  private var orbView: OrbView!
  private var statusItem: NSStatusItem!
  private var url: URL
  private var startHidden: Bool
  private var reloadTries = 0
  private var commandTimer: Timer?
  private var focusTimer: Timer?
  private var startedAt = Date()
  private var userHidden = false
  private var orbDismissed = false
  private var loggedOut = false
  private var lastRelated = false
  private var demoHold = false
  private var sessionPids: [pid_t] = []
  private var statusMenu: NSMenu!
  private var panelOpacity: Double = 0.96
  private var theme = "system"
  private var appearanceObs: NSKeyValueObservation?
  private var restoringFrame = false
  private var chromeHover = false
  private var saveFrameTimer: Timer?

  init(url: URL, startHidden: Bool) {
    self.url = url
    self.startHidden = startHidden
    super.init()
    AppDelegate.shared = self
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    demoHold = url.absoluteString.contains("demo=1")
    loadSavedChrome()
    buildPanel()
    buildOrb()
    buildStatusItem()
    applyChrome()
    appearanceObs = NSApp.observe(\.effectiveAppearance) { [weak self] _, _ in
      DispatchQueue.main.async { self?.applyChrome() }
    }
    writePid()
    watchCommands()
    watchFocus()
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.applyFocus()
    }
    loadPage()
    if !startHidden {
      showPanel()
    }
  }

  private func buildPanel() {
    restoringFrame = true
    let saved = loadSavedPanelRect()
    let panel = NSPanel(
      contentRect: saved,
      styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isFloatingPanel = true
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.hidesOnDeactivate = false
    panel.becomesKeyOnlyIfNeeded = true
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.isMovableByWindowBackground = false
    panel.title = "Plexus"
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    panel.minSize = NSSize(width: 280, height: 220)
    panel.maxSize = NSSize(width: 1800, height: 1400)
    panel.standardWindowButton(.closeButton)?.isHidden = false
    panel.standardWindowButton(.miniaturizeButton)?.isEnabled = false
    panel.standardWindowButton(.zoomButton)?.isHidden = false

    let root = HoverRoot(frame: NSRect(origin: .zero, size: saved.size))
    root.wantsLayer = true
    root.layer?.cornerRadius = 14
    root.layer?.masksToBounds = true
    root.layer?.backgroundColor = NSColor(calibratedRed: 0.04, green: 0.04, blue: 0.047, alpha: 0.96).cgColor
    root.translatesAutoresizingMaskIntoConstraints = true
    root.autoresizingMask = [.width, .height]

    let grab = GrabBar(frame: .zero)
    grab.translatesAutoresizingMaskIntoConstraints = false
    grab.wantsLayer = true
    grab.layer?.backgroundColor = NSColor.clear.cgColor

    let config = WKWebViewConfiguration()
    config.preferences.setValue(true, forKey: "developerExtrasEnabled")
    config.userContentController.add(self, name: "plexus")
    let web = ExploreWebView(frame: .zero, configuration: config)
    web.translatesAutoresizingMaskIntoConstraints = false
    web.navigationDelegate = self
    web.setValue(true, forKey: "drawsBackground")
    web.allowsMagnification = false
    web.allowsBackForwardNavigationGestures = false
    if #available(macOS 12.0, *) {
      web.underPageBackgroundColor = NSColor(calibratedRed: 0.04, green: 0.04, blue: 0.047, alpha: 1)
    }
    web.wantsLayer = true
    web.layer?.backgroundColor = NSColor(calibratedRed: 0.04, green: 0.04, blue: 0.047, alpha: 1).cgColor

    let grip = ResizeGrip(frame: .zero)
    grip.translatesAutoresizingMaskIntoConstraints = false

    let sessions = ChromeIcon(symbol: "square.stack", tip: "Browse sessions", keys: ["⌘", "P"])
    sessions.translatesAutoresizingMaskIntoConstraints = false
    sessions.onClick = { [weak self] in
      self?.runJS("window.__toggleSessions && window.__toggleSessions()")
    }
    let settings = ChromeIcon(symbol: "gearshape", tip: "Settings", keys: [])
    settings.translatesAutoresizingMaskIntoConstraints = false
    settings.onClick = { [weak self] in
      self?.runJS("window.__toggleSettings && window.__toggleSettings()")
    }

    let shield = PickerShield(frame: .zero)
    shield.translatesAutoresizingMaskIntoConstraints = false
    shield.isHidden = true
    shield.wantsLayer = true
    shield.layer?.backgroundColor = NSColor.clear.cgColor
    shield.onDismiss = { [weak self] in
      self?.runJS("window.__closePickers && window.__closePickers()")
    }

    root.addSubview(web)
    root.addSubview(grab)
    root.addSubview(sessions)
    root.addSubview(settings)
    root.addSubview(grip)
    root.addSubview(shield)
    panel.contentView = root
    NSLayoutConstraint.activate([
      grab.topAnchor.constraint(equalTo: root.topAnchor),
      grab.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 92),
      grab.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -88),
      grab.heightAnchor.constraint(equalToConstant: 36),
      settings.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -10),
      settings.topAnchor.constraint(equalTo: root.topAnchor, constant: 6),
      settings.widthAnchor.constraint(equalToConstant: 28),
      settings.heightAnchor.constraint(equalToConstant: 24),
      sessions.trailingAnchor.constraint(equalTo: settings.leadingAnchor, constant: -2),
      sessions.topAnchor.constraint(equalTo: settings.topAnchor),
      sessions.widthAnchor.constraint(equalToConstant: 28),
      sessions.heightAnchor.constraint(equalToConstant: 24),
      web.topAnchor.constraint(equalTo: root.topAnchor),
      web.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      web.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      web.bottomAnchor.constraint(equalTo: root.bottomAnchor),
      grip.widthAnchor.constraint(equalToConstant: 16),
      grip.heightAnchor.constraint(equalToConstant: 16),
      grip.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -4),
      grip.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -4),
      shield.topAnchor.constraint(equalTo: root.topAnchor),
      shield.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      shield.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      shield.bottomAnchor.constraint(equalTo: root.bottomAnchor),
    ])

    self.panel = panel
    self.webView = web
    self.rootView = root
    self.grabBar = grab
    self.sessionBtn = sessions
    self.settingsBtn = settings
    self.pickerShield = shield
    panel.delegate = self
    panel.isRestorable = false
    panel.setFrame(saved, display: false)
    restoringFrame = false
    root.onHover = { [weak self] hovering in
      self?.setChromeHover(hovering)
    }
    setChromeHover(false)

    NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard let self else { return event }
      if event.keyCode == 53 {
        self.hidePanel()
        return nil
      }
      let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
      if flags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "p" {
        self.runJS("window.__toggleSessions && window.__toggleSessions()")
        return nil
      }
      return event
    }
  }

  private func runJS(_ source: String) {
    webView?.evaluateJavaScript(source, completionHandler: nil)
  }

  private func setChromeHover(_ on: Bool) {
    chromeHover = on
    let alpha: CGFloat = on ? 1 : 0
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.22
      ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      for kind: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] {
        panel?.standardWindowButton(kind)?.animator().alphaValue = alpha
      }
      sessionBtn?.animator().alphaValue = alpha
      settingsBtn?.animator().alphaValue = alpha
      grabBar?.animator().alphaValue = on ? 1 : 0.22
    }
    if !on {
      sessionBtn?.hideTip()
      settingsBtn?.hideTip()
    }
    if on { panel?.makeKey() }
    runJS("document.documentElement.dataset.hover = '\(on ? "1" : "0")'")
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    hidePanel()
    return false
  }

  private func buildStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = item.button {
      let image = NSImage(systemSymbolName: "point.3.connected.trianglepath", accessibilityDescription: "Plexus")
      image?.isTemplate = true
      button.image = image
      button.toolTip = "Plexus — click to show or hide"
      button.target = self
      button.action = #selector(onStatusClick)
      button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }
    let menu = NSMenu()
    menu.addItem(withTitle: "Show Window", action: #selector(showPanel), keyEquivalent: "")
    menu.addItem(withTitle: "Hide Window", action: #selector(hidePanel), keyEquivalent: "")
    menu.addItem(.separator())
    menu.addItem(withTitle: "Walk Demo", action: #selector(openDemo), keyEquivalent: "")
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit Plexus", action: #selector(quit), keyEquivalent: "q")
    self.statusMenu = menu
    self.statusItem = item
    refreshMenu()
  }

  @objc func onStatusClick() {
    let type = NSApp.currentEvent?.type
    if type == .rightMouseUp || NSApp.currentEvent?.modifierFlags.contains(.control) == true {
      guard let button = statusItem.button else { return }
      statusMenu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.height + 4), in: button)
      return
    }
    toggle()
  }

  private func refreshMenu() {
    guard statusMenu != nil else { return }
    let visible = panel?.isVisible == true
    if statusMenu.items.count >= 2 {
      statusMenu.items[0].title = visible ? "Window is On" : "Show Window"
      statusMenu.items[0].isEnabled = !visible
      statusMenu.items[1].title = "Hide Window"
      statusMenu.items[1].isEnabled = visible
    }
  }

  private func buildOrb() {
    let size: CGFloat = 58
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
    var origin = NSPoint(x: screen.maxX - size - 22, y: screen.minY + 72)
    if let saved = UserDefaults.standard.string(forKey: "orbFrame") {
      let rect = NSRectFromString(saved)
      if rect.width > 20, rect.height > 20 { origin = rect.origin }
    }
    let orb = OrbPanel(
      contentRect: NSRect(origin: origin, size: NSSize(width: size, height: size)),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    orb.isFloatingPanel = true
    orb.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.floatingWindow)) + 1)
    orb.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    orb.hidesOnDeactivate = false
    orb.becomesKeyOnlyIfNeeded = true
    orb.isOpaque = false
    orb.backgroundColor = .clear
    orb.hasShadow = true
    orb.isMovableByWindowBackground = false
    let view = OrbView(frame: NSRect(origin: .zero, size: NSSize(width: size, height: size)))
    view.autoresizingMask = [.width, .height]
    view.onClick = { [weak self] in self?.showPanel() }
    view.onMoved = { [weak self] in self?.saveOrbFrame() }
    view.onDismiss = { [weak self] in self?.dismissOrb() }
    orb.contentView = view
    self.orbPanel = orb
    self.orbView = view
  }

  private func saveOrbFrame() {
    guard let orbPanel else { return }
    UserDefaults.standard.set(NSStringFromRect(orbPanel.frame), forKey: "orbFrame")
  }

  private func showOrb(_ show: Bool) {
    guard let orbPanel, let orbView else { return }
    if show {
      if !orbPanel.isVisible {
        orbPanel.orderFrontRegardless()
        orbView.startAnimating()
      }
    } else {
      orbView.stopAnimating()
      if orbPanel.isVisible { orbPanel.orderOut(nil) }
    }
  }

  private func loadSavedChrome() {
    let file = plexusDir().appendingPathComponent("prefs.json")
    guard let data = try? Data(contentsOf: file),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return }
    if let opacity = obj["opacity"] as? Double {
      panelOpacity = min(1, max(0.4, opacity))
    } else if let opacity = obj["opacity"] as? Int {
      panelOpacity = min(1, max(0.4, Double(opacity)))
    }
    if let value = obj["theme"] as? String, value == "light" || value == "dark" || value == "system" {
      theme = value
    }
  }

  private func resolvedLight() -> Bool {
    if theme == "system" {
      return NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) != .darkAqua
    }
    return theme == "light"
  }

  private func applyChrome() {
    panel?.alphaValue = CGFloat(min(1, max(0.4, panelOpacity)))
    let light = resolvedLight()
    grabBar?.light = light
    sessionBtn?.light = light
    settingsBtn?.light = light
    let bg = light
      ? NSColor(calibratedRed: 0.953, green: 0.953, blue: 0.965, alpha: 1)
      : NSColor(calibratedRed: 0.04, green: 0.04, blue: 0.047, alpha: 1)
    rootView?.layer?.backgroundColor = bg.cgColor
    webView?.layer?.backgroundColor = bg.cgColor
    if #available(macOS 12.0, *) {
      webView?.underPageBackgroundColor = bg
    }
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    let body = message.body
    DispatchQueue.main.async { [weak self] in
      self?.handleExploreMessage(body)
    }
  }

  private func handleExploreMessage(_ body: Any) {
    guard let obj = body as? [String: Any], let type = obj["type"] as? String else { return }
    if type == "opacity" {
      let value: Double
      if let n = obj["value"] as? Double { value = n }
      else if let n = obj["value"] as? Int { value = Double(n) }
      else { return }
      panelOpacity = min(1, max(0.4, value))
      applyChrome()
    }
    if type == "theme", let value = obj["value"] as? String {
      if value == "light" || value == "dark" || value == "system" {
        theme = value
      }
      applyChrome()
    }
    if type == "logout" {
      loggedOut = true
      demoHold = false
      userHidden = true
      showOrb(false)
      panel.orderOut(nil)
      refreshMenu()
    }
    if type == "title", let value = obj["value"] as? String {
      let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
      grabBar?.titleText = text.isEmpty ? "Plexus" : text
      panel?.title = grabBar?.titleText ?? "Plexus"
    }
    if type == "picker" {
      applyPickerShield(obj)
    }
  }

  private func applyPickerShield(_ obj: [String: Any]) {
    let open = obj["open"] as? Bool ?? false
    sessionBtn?.lockHover = open
    settingsBtn?.lockHover = open
    guard open else {
      pickerShield?.isHidden = true
      pickerShield?.hole = .zero
      return
    }
    sessionBtn?.clearHover()
    settingsBtn?.clearHover()
    let width = jsonNumber(obj["width"])
    let height = jsonNumber(obj["height"])
    guard width > 1, height > 1, let web = webView, let shield = pickerShield else {
      pickerShield?.isHidden = true
      return
    }
    let js = NSRect(
      x: jsonNumber(obj["x"]),
      y: jsonNumber(obj["y"]),
      width: width,
      height: height
    )
    let flipped = NSRect(
      x: js.minX,
      y: web.bounds.height - js.minY - js.height,
      width: js.width,
      height: js.height
    )
    shield.hole = web.convert(flipped, to: shield).insetBy(dx: -2, dy: -2)
    shield.isHidden = false
  }

  func windowDidMove(_ notification: Notification) {
    scheduleSavePanelFrame()
  }

  func windowDidResize(_ notification: Notification) {
    scheduleSavePanelFrame()
    runJS("window.__syncPickerOverlay && window.__syncPickerOverlay()")
  }

  func windowDidChangeScreen(_ notification: Notification) {
    scheduleSavePanelFrame()
  }

  private func jsonNumber(_ value: Any?) -> CGFloat {
    if let n = value as? Double { return CGFloat(n) }
    if let n = value as? Int { return CGFloat(n) }
    if let n = value as? NSNumber { return CGFloat(truncating: n) }
    return 0
  }

  private func defaultPanelRect() -> NSRect {
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
    let size = NSSize(width: 780, height: 580)
    return NSRect(
      x: screen.maxX - size.width - 20,
      y: screen.maxY - size.height - 20,
      width: size.width,
      height: size.height
    )
  }

  private func placed(_ saved: NSRect, on savedScreen: NSRect?, named savedName: String?) -> NSRect {
    var target: NSScreen?
    if #available(macOS 10.15, *), let savedName, !savedName.isEmpty {
      target = NSScreen.screens.first { $0.localizedName == savedName }
    }
    if target == nil, let savedScreen {
      target = NSScreen.screens.first {
        abs($0.frame.origin.x - savedScreen.origin.x) < 2
          && abs($0.frame.origin.y - savedScreen.origin.y) < 2
          && abs($0.frame.width - savedScreen.width) < 2
          && abs($0.frame.height - savedScreen.height) < 2
      }
    }
    if target == nil {
      let center = NSPoint(x: saved.midX, y: saved.midY)
      target = NSScreen.screens.first { NSMouseInRect(center, $0.visibleFrame, false) }
    }
    let screen = target ?? NSScreen.main
    guard let vis = screen?.visibleFrame else { return saved }
    var frame = saved
    if let savedScreen, let current = screen, abs(current.frame.origin.x - savedScreen.origin.x) > 2
      || abs(current.frame.origin.y - savedScreen.origin.y) > 2
    {
      frame.origin.x = vis.minX + (saved.minX - savedScreen.minX)
      frame.origin.y = vis.minY + (saved.minY - savedScreen.minY)
    }
    frame.size.width = min(max(frame.size.width, 280), vis.width)
    frame.size.height = min(max(frame.size.height, 220), vis.height)
    frame.origin.x = min(max(frame.origin.x, vis.minX), vis.maxX - frame.size.width)
    frame.origin.y = min(max(frame.origin.y, vis.minY), vis.maxY - frame.size.height)
    return frame
  }

  private func loadSavedPanelRect() -> NSRect {
    var saved: NSRect?
    var screenRect: NSRect?
    var screenName: String?
    if let raw = UserDefaults.standard.string(forKey: "panelFrame") {
      let rect = NSRectFromString(raw)
      if rect.width >= 200, rect.height >= 160 { saved = rect }
    }
    if let raw = UserDefaults.standard.string(forKey: "panelScreen") {
      let rect = NSRectFromString(raw)
      if rect.width > 0 { screenRect = rect }
    }
    screenName = UserDefaults.standard.string(forKey: "panelScreenName")
    let file = plexusDir().appendingPathComponent("prefs.json")
    if saved == nil,
       let data = try? Data(contentsOf: file),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let frame = obj["panelFrame"] as? [String: Any]
    {
      let rect = NSRect(
        x: jsonNumber(frame["x"]),
        y: jsonNumber(frame["y"]),
        width: jsonNumber(frame["w"]),
        height: jsonNumber(frame["h"])
      )
      if rect.width >= 200, rect.height >= 160 { saved = rect }
      if let screen = obj["panelScreen"] as? [String: Any] {
        screenRect = NSRect(
          x: jsonNumber(screen["x"]),
          y: jsonNumber(screen["y"]),
          width: jsonNumber(screen["w"]),
          height: jsonNumber(screen["h"])
        )
        screenName = screen["name"] as? String ?? screenName
      }
    }
    guard let saved else { return defaultPanelRect() }
    return placed(saved, on: screenRect, named: screenName)
  }

  private func patchPrefs(_ patch: [String: Any]) {
    let file = plexusDir().appendingPathComponent("prefs.json")
    var obj: [String: Any] = [:]
    if let data = try? Data(contentsOf: file),
       let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    {
      obj = parsed
    }
    for (key, value) in patch {
      obj[key] = value
    }
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj)
    else { return }
    try? data.write(to: file, options: .atomic)
  }

  private func scheduleSavePanelFrame() {
    if restoringFrame { return }
    saveFrameTimer?.invalidate()
    saveFrameTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: false) { [weak self] _ in
      self?.savePanelFrame()
    }
  }

  private func savePanelFrame() {
    guard let panel, !restoringFrame else { return }
    let frame = panel.frame
    UserDefaults.standard.set(NSStringFromRect(frame), forKey: "panelFrame")
    if let screen = panel.screen {
      UserDefaults.standard.set(NSStringFromRect(screen.frame), forKey: "panelScreen")
      if #available(macOS 10.15, *) {
        UserDefaults.standard.set(screen.localizedName, forKey: "panelScreenName")
      }
    }
    var patch: [String: Any] = [
      "panelFrame": [
        "x": Double(frame.origin.x),
        "y": Double(frame.origin.y),
        "w": Double(frame.size.width),
        "h": Double(frame.size.height),
      ],
    ]
    if let screen = panel.screen {
      var info: [String: Any] = [
        "x": Double(screen.frame.origin.x),
        "y": Double(screen.frame.origin.y),
        "w": Double(screen.frame.size.width),
        "h": Double(screen.frame.size.height),
      ]
      if #available(macOS 10.15, *) {
        info["name"] = screen.localizedName
      }
      patch["panelScreen"] = info
    }
    patchPrefs(patch)
  }

  private func plexusDir() -> URL {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let next = home.appendingPathComponent(".plexus")
    let prev = home.appendingPathComponent(".grok/explore")
    if !FileManager.default.fileExists(atPath: next.path),
       FileManager.default.fileExists(atPath: prev.path) {
      try? FileManager.default.copyItem(at: prev, to: next)
    }
    return next
  }

  private func writePid() {
    let dir = plexusDir()
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let pid = String(ProcessInfo.processInfo.processIdentifier)
    try? pid.write(to: dir.appendingPathComponent("hud.pid"), atomically: true, encoding: .utf8)
  }

  private func watchCommands() {
    commandTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      self?.drainCommand()
    }
  }

  private func watchFocus() {
    focusTimer = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: true) { [weak self] _ in
      self?.refreshPidsAndFocus()
    }
    refreshPidsAndFocus()
  }

  private func drainCommand() {
    let file = plexusDir().appendingPathComponent("hud-cmd")
    guard let raw = try? String(contentsOf: file, encoding: .utf8) else { return }
    try? FileManager.default.removeItem(at: file)
    let command = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if command == "quit", Date().timeIntervalSince(startedAt) < 2 {
      return
    }
    switch command {
    case "quit":
      quit()
    case "show":
      showPanel()
    case "hide":
      hidePanel()
    case "reload":
      loadPage()
      showPanel()
    default:
      toggle()
    }
  }

  private func refreshPidsAndFocus() {
    guard let endpoint = URL(string: "http://127.0.0.1:7733/api/state") else { return }
    var request = URLRequest(url: endpoint)
    request.timeoutInterval = 0.35
    URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
      var pids: [pid_t] = []
      if let data,
         let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let raw = obj["pids"] as? [Any]
      {
        pids = raw.compactMap { value in
          if let n = value as? NSNumber { return pid_t(truncating: n) }
          if let i = value as? Int { return pid_t(i) }
          return nil
        }
      }
      DispatchQueue.main.async {
        self?.sessionPids = pids
        self?.applyFocus()
      }
    }.resume()
  }

  private func isSessionFocused() -> Bool {
    let hudPid = pid_t(ProcessInfo.processInfo.processIdentifier)
    guard let front = NSWorkspace.shared.frontmostApplication else { return false }
    let frontPid = front.processIdentifier
    // Clicking the HUD must not count as "Grok Build is focused".
    if frontPid == hudPid { return lastRelated }
    if isGrokBotApp(front) { return false }
    if sessionsRunInside(front, sessionPids: sessionPids) { return true }
    // Orca / Claude / Codex GUI apps host the agent under a helper reparented
    // to launchd, so pid ancestry alone misses the focused app.
    if isGrokBuildHost(front) || isClaudeCodeApp(front) || isCodexApp(front) {
      return sessionPids.contains { $0 > 1 && kill($0, 0) == 0 }
    }
    return false
  }

  private func applyFocus() {
    if loggedOut {
      showOrb(false)
      if panel.isVisible {
        panel.orderOut(nil)
        refreshMenu()
      }
      return
    }
    let related = isSessionFocused()
    if demoHold {
      lastRelated = related
      showOrb(false)
      if !panel.isVisible {
        panel.orderFrontRegardless()
        refreshMenu()
      }
      return
    }
    lastRelated = related
    if !related {
      showOrb(false)
      if panel.isVisible {
        panel.orderOut(nil)
        refreshMenu()
      }
      return
    }
    if userHidden {
      if panel.isVisible {
        panel.orderOut(nil)
        refreshMenu()
      }
      showOrb(!orbDismissed)
      return
    }
    showOrb(false)
    if !panel.isVisible {
      panel.orderFrontRegardless()
      refreshMenu()
    }
  }

  private func loadPage() {
    webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4))
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    reloadTries = 0
    webView.allowsMagnification = false
    setChromeHover(chromeHover)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    retryLoad()
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    retryLoad()
  }

  private func retryLoad() {
    reloadTries += 1
    if reloadTries > 40 { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
      self?.loadPage()
    }
  }

  @objc func showPanel() {
    loggedOut = false
    userHidden = false
    orbDismissed = false
    showOrb(false)
    if demoHold || isSessionFocused() {
      panel.orderFrontRegardless()
    }
    refreshMenu()
  }

  @objc func hidePanel() {
    userHidden = true
    demoHold = false
    sessionBtn?.hideTip()
    settingsBtn?.hideTip()
    runJS("window.__closePickers && window.__closePickers()")
    setChromeHover(false)
    panel.orderOut(nil)
    refreshMenu()
    if !orbDismissed, isSessionFocused() {
      showOrb(true)
    }
  }

  private func dismissOrb() {
    orbDismissed = true
    showOrb(false)
  }

  @objc func toggle() {
    if loggedOut || !panel.isVisible {
      showPanel()
    } else {
      hidePanel()
    }
  }

  @objc func openDemo() {
    demoHold = true
    userHidden = false
    var bits = URLComponents(url: url, resolvingAgainstBaseURL: false) ?? URLComponents()
    var items = bits.queryItems ?? []
    items.removeAll { $0.name == "demo" }
    items.append(URLQueryItem(name: "demo", value: "1"))
    bits.queryItems = items
    if let demoURL = bits.url {
      webView.load(URLRequest(url: demoURL))
    }
    panel.orderFrontRegardless()
    refreshMenu()
  }

  @objc func quit() {
    savePanelFrame()
    NSApp.terminate(nil)
  }
}

func parseArgs() -> (url: URL, hidden: Bool) {
  var url = URL(string: "http://127.0.0.1:7733")!
  var hidden = false
  var args = Array(CommandLine.arguments.dropFirst())
  while !args.isEmpty {
    let item = args.removeFirst()
    if item == "--url", let next = args.first {
      args.removeFirst()
      if let parsed = URL(string: next) { url = parsed }
    } else if item.hasPrefix("--url=") {
      if let parsed = URL(string: String(item.dropFirst(6))) { url = parsed }
    } else if item == "--hide" {
      hidden = true
    }
  }
  return (url, hidden)
}

let args = parseArgs()
let app = NSApplication.shared
let delegate = AppDelegate(url: args.url, startHidden: args.hidden)
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
