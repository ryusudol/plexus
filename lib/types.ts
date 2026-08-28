export type Provider = "grok" | "claude" | "codex";

export type Visit = {
  kind: string;
  toolName: string | null;
  agentId: string;
  agentLabel: string;
  workspaceRoot: string | null;
  folderPath: string | null;
  filePath: string | null;
  ts: string | null;
};

export type ParsedVisit = {
  toolCallId: string | null;
  kind: string;
  visit: Visit;
};

export type LineParse = {
  visits: ParsedVisit[];
  activity: "busy" | "idle" | null;
  prompt: boolean;
};

export type SessionHint = {
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  label?: string;
  agentLabel?: string;
  agent?: string;
  provider?: Provider | string;
};

export type SessionRow = {
  session_id: string;
  nativeId?: string;
  pid?: number;
  cwd: string;
  opened_at?: string;
  title?: string;
  agent?: string;
  provider?: Provider | string;
  updates?: string;
  mtime?: number;
  live?: boolean;
};

export type OrcaPane = {
  sessionId: string;
  cwd: string | null;
  tabId: string | null;
};

export type OrcaFocus = {
  cwd: string | null;
  sessionId: string | null;
};

export type FollowMode = "focus" | "project";

export type SnapshotAgent = {
  id: string;
  label: string;
  title?: string;
  folderPath: string;
  filePath?: string | null;
};

export type SnapshotSession = {
  id: string;
  title: string;
  cwd: string;
  live: boolean;
  provider: Provider | string;
  selected: boolean;
};

export type Snapshot = {
  type?: "snapshot";
  sessions: SnapshotSession[];
  sessionId: string | null;
  sessionTitle: string | null;
  root: string | null;
  agents: SnapshotAgent[];
  visited: string[];
  files: string[];
  busy: boolean;
  pids: number[];
  followMode?: FollowMode;
  name?: string;
};

export type HubEvent =
  | ({ type: "snapshot" } & Snapshot)
  | { type: "activity"; active: boolean; sessionId: string | null; cwd?: string }
  | {
      type: "agent";
      agentId: string;
      status: "start" | "stop";
      agentLabel?: string;
      cwd?: string;
    }
  | {
      type: "visit";
      agentId: string;
      agentLabel: string;
      folderPath: string;
      filePath: string | null;
      toolName: string | null;
      cwd?: string;
      ts: string | null;
    }
  | { type: "root"; path: string; name: string };

export type Prefs = {
  accent?: string;
  shape?: "tree" | "circle";
  theme?: "light" | "dark" | "system";
  opacity?: number;
  graphFollow?: FollowMode;
  settingsHidden?: boolean;
  sessionId?: string;
  agentSymbol?: string | null;
};

export type TreeNode = {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  childIds: string[];
  hasChildren: boolean;
  childrenLoaded?: boolean;
  kind?: "folder" | "file";
};

export type FolderChild = {
  name: string;
  path: string;
  hasChildren: boolean;
};
