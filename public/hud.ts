import type { GraphLayout, TrailMode } from "../lib/layout.ts";
import type { FollowMode, TreeNode } from "../lib/types.ts";

export type { FollowMode };
export type ThemePref = "light" | "dark" | "system";
export type LiveKind = "on" | "waiting";

export type AgentMark = {
  id: string;
  label: string;
  color: string;
  nodeId: string;
  targetId: string | null;
  traveling: boolean;
  x: number;
  y: number;
};

export type SessionListItem = {
  id: string;
  title?: string;
  cwd?: string;
  live?: boolean;
  provider?: string;
  selected?: boolean;
};

export type SnapshotPayload = {
  root?: string | null;
  name?: string;
  sessions?: SessionListItem[];
  sessionId?: string | null;
  agents?: Array<{ id: string; label?: string; title?: string; folderPath?: string; filePath?: string | null }>;
  visited?: string[];
  files?: string[];
  busy?: boolean;
};

export type LogEntry = {
  toolName?: string;
  folderPath: string;
  filePath?: string | null;
};

export type AppState = {
  mode: "live" | "demo";
  rootId: string;
  rootPath: string;
  nodes: Map<string, TreeNode>;
  parentOf: Map<string, string | null>;
  expanded: Set<string>;
  lastFocus: Map<string, number>;
  userPins: Set<string>;
  visited: Map<string, number>;
  visitedEdges: Set<string>;
  agents: Map<string, AgentMark>;
  hidden: Map<string, Set<string>>;
  shown: Map<string, string[]>;
  layout: GraphLayout | null;
  log: LogEntry[];
  accent: string;
  agentSymbol: string | null;
  shape: TrailMode;
  theme: ThemePref;
  opacity: number;
  graphFollow: FollowMode;
  settingsHidden: boolean;
  sessionId: string | null;
  sessions: SessionListItem[];
};

export const svgNS = "http://www.w3.org/2000/svg";
export const DEFAULT_ACCENT = "#ff4fcb";
export const WHITE = "#f4f4f6";
export const INK = "#16161a";

export const PALETTE = [
  { id: "pink", hex: "#ff4fcb" },
  { id: "red", hex: "#ff4d4d" },
  { id: "orange", hex: "#ff8a3a" },
  { id: "yellow", hex: "#f5d76e" },
  { id: "green", hex: "#3ddc97" },
  { id: "blue", hex: "#4d9fff" },
  { id: "purple", hex: "#b57bff" },
  { id: "white", hex: "#f4f4f6" },
];

export const SHAPES = [
  { id: "tree" as const, label: "Tree", title: "Branching tree" },
  { id: "circle" as const, label: "Circle", title: "Circular map" },
  { id: "neurons" as const, label: "Neurons", title: "Neural arbor" },
];

export function nearestPalette(hex: string | null | undefined): string {
  const want = String(hex || "").toLowerCase();
  const exact = PALETTE.find((c) => c.hex === want);
  if (exact) return exact.hex;
  const toRgb = (h: string) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  let best = DEFAULT_ACCENT;
  let bestDist = Infinity;
  const [r, g, b] = /^#[0-9a-f]{6}$/.test(want) ? toRgb(want) : [255, 79, 203];
  for (const color of PALETTE) {
    const [cr, cg, cb] = toRgb(color.hex);
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = color.hex;
    }
  }
  return best;
}

export function whisperName(name: unknown): string {
  const raw = String(name || "").replace(/[_-]+/g, " ").trim();
  if (raw.length <= 16) return raw;
  return raw.slice(0, 15);
}

export function shortLabel(label: unknown, id: unknown): string {
  if (label && !/^01[a-f0-9-]{20,}$/i.test(String(label)) && label !== "main") return String(label);
  if (!id) return "agent";
  const value = String(id);
  return value.length > 10 ? value.slice(0, 4) : value;
}

export function sessionLabel(item: SessionListItem): string {
  const title = String(item.title || "").trim();
  if (title && !/^01[a-f0-9-]{20,}$/i.test(title) && title !== "main") return title;
  return String(item.cwd || "").trim() || "project";
}

export function folderTail(path: unknown): string {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || String(path || "");
}

export function cssEscape(value: unknown): string {
  if (window.CSS && CSS.escape) return CSS.escape(String(value));
  return String(value).replace(/"/g, '\\"');
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

export function svgEl(name: string, attrs: Record<string, string | number | null | undefined> = {}, parent?: Element | null) {
  const node = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    node.setAttribute(key, String(value));
  }
  if (parent) parent.appendChild(node);
  return node;
}
