import type { TreeNode } from "./types.ts";

function add(
  nodes: Map<string, TreeNode>,
  id: string,
  name: string,
  parentId: string | null,
  kind: "folder" | "file" = "folder",
) {
  nodes.set(id, {
    id,
    name,
    path: id,
    parentId,
    childIds: [],
    hasChildren: false,
    childrenLoaded: kind === "file",
    kind,
  });
  if (parentId) {
    const parent = nodes.get(parentId);
    if (!parent) return;
    parent.childIds.push(id);
    parent.hasChildren = true;
  }
}

/**
 * A wide, nested folder tree used to show auto-fold without scanning a huge repo.
 */
export function buildShowcaseTree(): { rootId: string; nodes: Map<string, TreeNode> } {
  const nodes = new Map<string, TreeNode>();
  add(nodes, "root", "acme", null);

  const packages = [
    "api",
    "web",
    "mobile",
    "infra",
    "data",
    "ml",
    "design",
    "docs",
    "ops",
    "sdk",
    "cli",
    "bench",
  ];

  for (const name of packages) {
    const id = `root/${name}`;
    add(nodes, id, name, "root");
    for (const sub of ["src", "lib", "test", "docs"]) {
      const subId = `${id}/${sub}`;
      add(nodes, subId, sub, id);
    }
  }

  const webSrc = "root/web/src";
  const screens = [
    "home",
    "search",
    "settings",
    "billing",
    "agents",
    "session",
    "editor",
    "terminal",
    "plugins",
    "hooks",
  ];
  for (const screen of screens) {
    add(nodes, `${webSrc}/${screen}`, screen, webSrc);
  }
  add(nodes, `${webSrc}/agents/index.ts`, "index.ts", `${webSrc}/agents`, "file");
  add(nodes, `${webSrc}/session/store.ts`, "store.ts", `${webSrc}/session`, "file");
  add(nodes, `${webSrc}/editor/canvas.ts`, "canvas.ts", `${webSrc}/editor`, "file");

  const apiSrc = "root/api/src";
  for (const name of ["routes", "auth", "db", "jobs", "models", "hooks"]) {
    add(nodes, `${apiSrc}/${name}`, name, apiSrc);
  }
  add(nodes, `${apiSrc}/hooks/plexus.ts`, "plexus.ts", `${apiSrc}/hooks`, "file");

  const mlSrc = "root/ml/src";
  for (const name of ["train", "eval", "features", "dataflow"]) {
    add(nodes, `${mlSrc}/${name}`, name, mlSrc);
  }

  return { rootId: "root", nodes };
}

export function showcaseWalk(): string[] {
  return [
    "root/web",
    "root/web/src",
    "root/web/src/agents",
    "root/web/src/agents/index.ts",
    "root/web/src/session",
    "root/web/src/session/store.ts",
    "root/api",
    "root/api/src",
    "root/api/src/hooks",
    "root/api/src/hooks/plexus.ts",
    "root/ml",
    "root/ml/src",
    "root/ml/src/eval",
    "root/docs",
    "root/web/src/editor",
    "root/web/src/editor/canvas.ts",
    "root/cli",
    "root/cli/src",
  ];
}
