import { parseTrailMode } from "../lib/layout.ts";
import {
  DEFAULT_ACCENT,
  INK,
  PALETTE,
  SHAPES,
  nearestSpeed,
  speedRate,
  folderTail,
  nearestPalette,
  sessionLabel,
  type SessionListItem,
  type ThemePref,
} from "./hud.ts";
import {
  accentForTheme,
  els,
  flags,
  hitFill,
  hooks,
  notifyHost,
  prefGet,
  prefSet,
  resolvedTheme,
  savePrefs,
  stageFill,
  state,
  systemDark,
} from "./runtime.ts";

export function setAgentSymbol(dataUrl: string | null | undefined) {
  state.agentSymbol = dataUrl || null;
  const face = els.faceBtn || els.faceWrap;
  if (face) {
    if (state.agentSymbol) {
      face.style.backgroundImage = `url("${state.agentSymbol}")`;
      face.classList.add("has-face");
    } else {
      face.style.backgroundImage = "";
      face.classList.remove("has-face");
    }
  }
  const reset = els.faceMenu?.querySelector('[data-face="reset"]');
  if (reset instanceof HTMLElement) reset.hidden = !state.agentSymbol;
  for (const agent of state.agents.values()) hooks.drawAgent(agent);
}

export function readFace(file: File) {
  return new Promise<string>((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error("not an image"));
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 96;
      const ctx = canvas.getContext("2d");
      ctx.beginPath();
      ctx.arc(48, 48, 48, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      const scale = Math.max(96 / img.width, 96 / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, 48 - w / 2, 48 - h / 2, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not read image"));
    };
    img.src = url;
  });
}

let themeUserSet = false;

export function applyTheme(theme: string | ThemePref, { persist = false } = {}) {
  const next = theme === "light" || theme === "system" || theme === "dark" ? theme : "dark";
  const prev = state.theme;
  state.theme = next;
  const resolved = resolvedTheme();
  const prevResolved = document.documentElement.getAttribute("data-theme");
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-theme-pref", next);
  document.documentElement.style.colorScheme = resolved;
  document.documentElement.style.setProperty("--accent", accentForTheme());
  hitFill.setAttribute("fill", stageFill());
  const changed = prev !== next || prevResolved !== resolved;
  if (changed) {
    notifyHost({ type: "theme", value: next, resolved });
    notifyHost({ type: "accent", value: accentForTheme() });
    for (const agent of state.agents.values()) hooks.drawAgent(agent);
    if (state.layout) hooks.drawTree(state.layout);
  }
  paintTheme();
  paintPalette();
  if (persist) {
    themeUserSet = true;
    savePrefs({ theme: next });
  }
  if (changed) requestAnimationFrame(() => syncPickerOverlay());
}

export function applyOpacity(value: number, { persist = false } = {}) {
  const next = Math.min(1, Math.max(0.4, Number(value) || 0.96));
  state.opacity = next;
  const pct = Math.round(next * 100);
  if (els.opacity) els.opacity.value = String(pct);
  if (els.opacityOut) els.opacityOut.textContent = String(pct);
  document.documentElement.style.setProperty("--glass-fill", `${((pct - 40) / 60) * 100}%`);
  notifyHost({ type: "opacity", value: next });
  if (persist) savePrefs();
}

export function paintSpeed() {
  const root = els.speedSeg || document.getElementById("speed-seg");
  if (!root) return;
  const current = nearestSpeed(state.agentSpeed);
  for (const btn of root.querySelectorAll<HTMLButtonElement>("button[data-speed]")) {
    const on = btn.dataset.speed === current;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
}

export function applyAgentSpeed(value: unknown, { persist = false } = {}) {
  const preset = nearestSpeed(value);
  const next = speedRate(preset);
  state.agentSpeed = next;
  paintSpeed();
  if (persist) savePrefs({ agentSpeed: next });
  else prefSet("speed", String(next));
}

export function paintFollow() {
  const root = els.followSeg || document.getElementById("follow-seg");
  if (!root) return;
  for (const btn of root.querySelectorAll<HTMLButtonElement>("button[data-follow]")) {
    const on = btn.dataset.follow === state.graphFollow;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
}

export function applyFollow(mode: string, { persist = false } = {}) {
  state.graphFollow = mode === "project" ? "project" : "focus";
  paintFollow();
  if (persist) savePrefs({ graphFollow: state.graphFollow });
}

export function applySettingsHidden(hidden: boolean, { persist = false } = {}) {
  state.settingsHidden = Boolean(hidden);
  document.documentElement.dataset.settings = state.settingsHidden ? "off" : "on";
  if (persist) savePrefs({ settingsHidden: state.settingsHidden });
}

export function anyPickerOpen() {
  return Boolean(
    (els.sessionPicker && !els.sessionPicker.hidden) ||
      (els.settingsPicker && !els.settingsPicker.hidden),
  );
}

export function syncPickerOverlay() {
  const open = anyPickerOpen();
  if (els.pickerScrim) els.pickerScrim.hidden = !open;
  if (open) document.documentElement.dataset.picker = "open";
  else delete document.documentElement.dataset.picker;
  const picker =
    els.sessionPicker && !els.sessionPicker.hidden
      ? els.sessionPicker
      : els.settingsPicker && !els.settingsPicker.hidden
        ? els.settingsPicker
        : null;
  const post = () => {
    const rect = picker?.getBoundingClientRect();
    notifyHost({
      type: "picker",
      open,
      x: rect?.left ?? 0,
      y: rect?.top ?? 0,
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
    });
  };
  if (open) {
    requestAnimationFrame(post);
    requestAnimationFrame(() => requestAnimationFrame(post));
  } else post();
}

export function closePickers() {
  setSessionPickerOpen(false);
  setSettingsPickerOpen(false);
}

export function setSettingsPickerOpen(open: boolean) {
  if (!els.settingsPicker) return;
  if (open) {
    if (els.sessionPicker) {
      els.sessionPicker.hidden = true;
      if (els.sessionSearch) els.sessionSearch.value = "";
    }
  }
  els.settingsPicker.hidden = !open;
  syncPickerOverlay();
}

export function toggleSettingsPicker() {
  setSettingsPickerOpen(Boolean(els.settingsPicker?.hidden));
}

export function setColorMenuOpen(_open: boolean) {}

export function setFaceMenuOpen(open: boolean) {
  if (!els.faceMenu || !els.faceBtn) return;
  els.faceMenu.hidden = !open;
  els.faceBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

export function paintPalette() {
  if (els.colorCurrent) {
    els.colorCurrent.style.backgroundColor = state.accent;
    const name = PALETTE.find((c) => c.hex === state.accent)?.id || "color";
    els.colorCurrent.title = name;
  }
  if (!els.palette) return;
  els.palette.replaceChildren();
  for (const color of PALETTE) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (color.hex === state.accent ? " on" : "");
    btn.title = color.id;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-label", color.id);
    btn.style.background = color.id === "white" && resolvedTheme() === "light" ? INK : color.hex;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setAccent(color.hex);
      savePrefs();
    });
    els.palette.appendChild(btn);
  }
}

export function setAccent(hex: string | null | undefined) {
  const value = nearestPalette(hex);
  state.accent = value;
  document.documentElement.style.setProperty("--accent", accentForTheme(value));
  notifyHost({ type: "accent", value: accentForTheme(value) });
  paintPalette();
  for (const agent of state.agents.values()) {
    agent.color = hooks.colorFor(agent.id);
    hooks.drawAgent(agent);
  }
  if (state.layout) hooks.drawTree(state.layout);
}

export function bindCenterBtn() {
  const stage = els.stage || document.getElementById("stage");
  if (!stage) return;
  let tools = document.querySelector(".stage-tools");
  if (!tools) {
    tools = document.createElement("div");
    tools.className = "stage-tools";
    stage.appendChild(tools);
  }
  const demo = document.getElementById("btn-demo") || els.demo;
  if (demo) {
    demo.title = "Replay trail";
    demo.setAttribute("aria-label", "Replay trail");
    if (!demo.querySelector("svg")) {
      demo.textContent = "";
      demo.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5.1 3.05a.9.9 0 0 1 1.37-.76l7.2 4.45a.9.9 0 0 1 0 1.52l-7.2 4.45a.9.9 0 0 1-1.37-.76z"/></svg>';
    }
    if (demo.parentElement !== tools) tools.appendChild(demo);
  }
  let btn = document.getElementById("btn-center") || els.center;
  if (!btn) {
    btn = document.createElement("button");
    btn.setAttribute("type", "button");
    btn.id = "btn-center";
    btn.title = "Center graph";
    btn.setAttribute("aria-label", "Center graph");
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><path d="M8 1.2v2.6M8 12.2v2.6M1.2 8h2.6M12.2 8h2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  } else if (!btn.querySelector("svg")) {
    btn.textContent = "";
    btn.setAttribute("aria-label", "Center graph");
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><path d="M8 1.2v2.6M8 12.2v2.6M1.2 8h2.6M12.2 8h2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  }
  if (btn.parentElement !== tools) tools.appendChild(btn);
  els.center = btn;
  els.demo = demo;
  if (btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    hooks.centerView();
  });
}

export function ensureShapeEl() {
  let shape = els.shape && document.body.contains(els.shape) ? els.shape : document.getElementById("shape");
  if (!shape) {
    shape = document.createElement("div");
    shape.id = "shape";
    shape.className = "seg";
    shape.setAttribute("role", "tablist");
    shape.setAttribute("aria-label", "Trail layout");
    document.querySelector(".instrument")?.appendChild(shape);
  }
  shape.classList.add("seg", "trail-seg");
  els.shape = shape;
  return shape;
}

export function paintTheme() {
  const root = els.themeSeg || document.getElementById("theme-seg");
  if (!root) return;
  for (const btn of root.querySelectorAll<HTMLButtonElement>("button")) {
    const on = btn.dataset.theme === state.theme;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
}

export function setSettingsOpen(open: boolean) {
  const tray = els.settingsTray || document.getElementById("settings-tray");
  const btn = els.settingsBtn || document.getElementById("btn-settings");
  if (!tray || !btn) return;
  tray.classList.toggle("open", open);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

export function layoutInstrument() {
  const header = els.instrument || document.querySelector(".instrument");
  const bar = els.settings || document.getElementById("settings");
  const tray = els.settingsTray || document.getElementById("settings-tray");
  if (!header || !bar || !tray || flags.instrumentBusy) return;
  flags.instrumentBusy = true;
  const keys = ["color", "display", "follow", "trail", "glass", "speed"];
  const cells = keys
    .map((id) => header.querySelector(`[data-setting="${id}"]`) || bar.querySelector(`[data-setting="${id}"]`) || tray.querySelector(`[data-setting="${id}"]`))
    .filter(Boolean);
  header.classList.toggle("settings-off", state.settingsHidden);
  if (state.settingsHidden) {
    for (const cell of cells) bar.appendChild(cell);
    header.classList.remove("compact");
    setSettingsOpen(false);
    requestAnimationFrame(() => {
      flags.instrumentBusy = false;
    });
    return;
  }
  for (const cell of cells) bar.appendChild(cell);
  const styles = getComputedStyle(header);
  const pad = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
  const gap = parseFloat(getComputedStyle(bar).columnGap || getComputedStyle(bar).gap) || 12;
  const widths = new Map(cells.map((cell) => [cell, Math.ceil(cell.getBoundingClientRect().width) || 80]));
  const pack = () => {
    let space = header.clientWidth - pad;
    const shown = [];
    const hidden = [];
    for (const cell of cells) {
      const need = (widths.get(cell) || 80) + gap;
      if (need <= space) {
        shown.push(cell);
        space -= need;
      } else hidden.push(cell);
    }
    return { shown, hidden };
  };
  const result = pack();
  for (const cell of result.shown) bar.appendChild(cell);
  for (const cell of result.hidden) tray.appendChild(cell);
  const compact = result.hidden.length > 0;
  header.classList.toggle("compact", compact);
  setSettingsOpen(compact);
  requestAnimationFrame(() => {
    flags.instrumentBusy = false;
  });
}

export function paintShape() {
  bindCenterBtn();
  const root = ensureShapeEl();
  if (!root) return;
  root.replaceChildren();
  for (const item of SHAPES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.textContent = item.label;
    btn.title = item.title;
    btn.className = item.id === state.shape ? "on" : "";
    btn.setAttribute("aria-selected", item.id === state.shape ? "true" : "false");
    btn.addEventListener("click", () => setShape(item.id));
    els.shape.appendChild(btn);
  }
}

export async function setShape(shape: string, { persist = true, morph = true } = {}) {
  const next = parseTrailMode(shape);
  const changed = next !== state.shape;
  state.shape = next;
  paintShape();
  if (persist) savePrefs({ shape: next });
  else prefSet("shape", next);
  if (changed && morph && state.layout) await hooks.morphShape();
}

export function setSessionTitle(text: string | null | undefined) {
  const label = String(text || "").trim() || "Plexus";
  document.title = label;
  notifyHost({ type: "title", value: label });
}

export function fillSessionSelect(sessions: SessionListItem[] | null | undefined, selectedId?: string | null) {
  state.sessions = sessions || [];
  if (selectedId) state.sessionId = selectedId;
  const current =
    state.sessions.find((item) => item.id === state.sessionId || item.selected) || state.sessions[0];
  if (current) {
    state.sessionId = current.id;
    setSessionTitle(sessionLabel(current));
  } else {
    setSessionTitle(state.mode === "demo" ? "Preview" : "Plexus");
  }
  renderSessionPicker();
}

export function renderSessionPicker() {
  if (!els.sessionList) return;
  const q = String(els.sessionSearch?.value || "").trim().toLowerCase();
  const list = state.sessions.filter((item) => {
    if (!q) return true;
    const hay = `${sessionLabel(item)} ${item.cwd || ""} ${item.id || ""}`.toLowerCase();
    return hay.includes(q);
  });
  els.sessionList.replaceChildren();
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "picker-sub";
    empty.style.padding = "12px 10px";
    empty.textContent = state.sessions.length ? "No matches" : "No live sessions";
    els.sessionList.appendChild(empty);
    return;
  }
  for (const item of list) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "picker-row" + (item.id === state.sessionId ? " on" : "");
    row.setAttribute("role", "option");
    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "picker-title";
    title.textContent = sessionLabel(item);
    const sub = document.createElement("div");
    sub.className = "picker-sub";
    if (item.id === state.sessionId) {
      const dot = document.createElement("span");
      dot.className = "picker-dot";
      sub.appendChild(dot);
    }
    const bits = [];
    if (item.id === state.sessionId) bits.push("Current");
    if (item.provider && item.provider !== "grok") bits.push(item.provider);
    const place = folderTail(item.cwd);
    if (place) bits.push(place);
    const meta = document.createElement("span");
    meta.textContent = bits.join(" · ");
    sub.appendChild(meta);
    body.append(title, sub);
    row.appendChild(body);
    row.addEventListener("pointerenter", () => row.classList.add("is-hover"));
    row.addEventListener("pointerleave", () => row.classList.remove("is-hover"));
    row.addEventListener("click", () => hooks.attachSession(item.id));
    els.sessionList.appendChild(row);
  }
}

export function setSessionPickerOpen(open: boolean) {
  if (!els.sessionPicker) return;
  if (open && els.settingsPicker) els.settingsPicker.hidden = true;
  els.sessionPicker.hidden = !open;
  if (open) {
    renderSessionPicker();
    queueMicrotask(() => els.sessionSearch?.focus());
  } else if (els.sessionSearch) {
    els.sessionSearch.value = "";
  }
  syncPickerOverlay();
}

export function toggleSessionPicker() {
  setSessionPickerOpen(Boolean(els.sessionPicker?.hidden));
}

export function bindChromeEvents() {
  els.opacity?.addEventListener("input", () => {
    applyOpacity(Number(els.opacity.value) / 100);
  });
  els.opacity?.addEventListener("change", () => {
    applyOpacity(Number(els.opacity.value) / 100, { persist: true });
  });
  els.speedSeg?.addEventListener("click", (ev) => {
    const btn = (ev.target as Element | null)?.closest<HTMLButtonElement>("button[data-speed]");
    if (!btn?.dataset.speed) return;
    applyAgentSpeed(btn.dataset.speed, { persist: true });
  });
  const themeButtonFromEvent = (ev: Event) => {
    const node = ev.target instanceof Element ? ev.target : (ev.target as Node | null)?.parentElement;
    const btn = node?.closest<HTMLButtonElement>("button[data-theme]");
    if (!btn?.dataset.theme) return null;
    if (els.settingsPicker && !els.settingsPicker.contains(btn)) return null;
    return btn;
  };
  const pickTheme = (btn: HTMLButtonElement) => {
    const value = btn.dataset.theme;
    if (!value) return;
    applyTheme(value, { persist: true });
  };
  // Apply on press so a later lost click still switches; close after the gesture.
  els.settingsPicker?.addEventListener(
    "pointerdown",
    (ev) => {
      const btn = themeButtonFromEvent(ev);
      if (!btn) return;
      pickTheme(btn);
    },
    true,
  );
  els.settingsPicker?.addEventListener("pointerup", (ev) => {
    const btn = themeButtonFromEvent(ev);
    if (!btn) return;
    pickTheme(btn);
    queueMicrotask(() => setSettingsPickerOpen(false));
  });
  els.settingsPicker?.addEventListener("click", (ev) => {
    const btn = themeButtonFromEvent(ev);
    if (!btn) return;
    ev.stopPropagation();
    pickTheme(btn);
    setSettingsPickerOpen(false);
  });
  els.followSeg?.addEventListener("click", (ev) => {
    const btn = (ev.target as Element | null)?.closest<HTMLButtonElement>("button[data-follow]");
    if (!btn) return;
    applyFollow(btn.dataset.follow, { persist: true });
  });
  els.sessionSearch?.addEventListener("input", () => renderSessionPicker());
  els.sessionSearch?.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      setSessionPickerOpen(false);
    }
  });
  els.pickerScrim?.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    closePickers();
  });
  if (window.ResizeObserver) {
    for (const picker of [els.sessionPicker, els.settingsPicker]) {
      if (!picker) continue;
      new ResizeObserver(() => {
        if (!picker.hidden) syncPickerOverlay();
      }).observe(picker);
    }
  }
  document.addEventListener("click", (ev) => {
    const target = ev.target as Node | null;
    if (els.menu && !els.menu.contains(target)) els.menu.hidden = true;
    if (els.colorPick && !els.colorPick.contains(target)) setColorMenuOpen(false);
    if (els.sessionPicker && !els.sessionPicker.hidden && !els.sessionPicker.contains(target)) {
      setSessionPickerOpen(false);
    }
    if (els.settingsPicker && !els.settingsPicker.hidden && !els.settingsPicker.contains(target)) {
      setSettingsPickerOpen(false);
    }
  });
  document.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "p") {
      ev.preventDefault();
      toggleSessionPicker();
    }
    if (ev.key === "Escape") {
      if (els.sessionPicker && !els.sessionPicker.hidden) {
        ev.preventDefault();
        setSessionPickerOpen(false);
      }
      if (els.settingsPicker && !els.settingsPicker.hidden) {
        ev.preventDefault();
        setSettingsPickerOpen(false);
      }
    }
  });
  window.__toggleSessions = toggleSessionPicker;
  window.__toggleSettings = toggleSettingsPicker;
  window.__closePickers = closePickers;
  window.__syncPickerOverlay = syncPickerOverlay;
}

export function restoreChrome() {
  setAccent(prefGet("accent") || DEFAULT_ACCENT);
  setAgentSymbol(prefGet("face"));
  setShape(prefGet("shape") || "neurons", { persist: false, morph: false });
  applyTheme(prefGet("theme") || "system");
  applyFollow(prefGet("follow") || "focus", { persist: false });
  applySettingsHidden(prefGet("settings") === "off", { persist: false });
  if (systemDark.addEventListener) {
    systemDark.addEventListener("change", () => {
      if (state.theme === "system") applyTheme("system");
    });
  } else if (systemDark.addListener) {
    systemDark.addListener(() => {
      if (state.theme === "system") applyTheme("system");
    });
  }
  applyOpacity(Number(prefGet("opacity") || 0.96));
  applyAgentSpeed(prefGet("speed") || "medium");
  fetch("/api/prefs")
    .then((res) => (res.ok ? res.json() : null))
    .then((prefs) => {
      if (prefs?.accent) setAccent(prefs.accent);
      if (Object.prototype.hasOwnProperty.call(prefs || {}, "agentSymbol")) {
        setAgentSymbol(prefs.agentSymbol);
      }
      if (prefs?.shape) setShape(prefs.shape, { persist: false, morph: false });
      if (prefs?.theme && !themeUserSet) applyTheme(prefs.theme);
      if (typeof prefs?.opacity === "number") applyOpacity(prefs.opacity);
      if (prefs?.agentSpeed != null) applyAgentSpeed(prefs.agentSpeed);
      if (prefs?.graphFollow) applyFollow(prefs.graphFollow, { persist: false });
      if (typeof prefs?.settingsHidden === "boolean") applySettingsHidden(prefs.settingsHidden, { persist: false });
    })
    .catch(() => {});
  layoutInstrument();
}
