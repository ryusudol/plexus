function add(nodes, id, name, parentId) {
  nodes.set(id, {
    id,
    name,
    path: id,
    parentId,
    childIds: [],
    hasChildren: false,
  });
  if (parentId) {
    const parent = nodes.get(parentId);
    parent.childIds.push(id);
    parent.hasChildren = true;
  }
}

/**
 * A wide, nested folder tree used to show auto-fold without scanning a huge repo.
 */
export function buildShowcaseTree() {
  const nodes = new Map();
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

  const apiSrc = "root/api/src";
  for (const name of ["routes", "auth", "db", "jobs", "models", "hooks"]) {
    add(nodes, `${apiSrc}/${name}`, name, apiSrc);
  }

  const mlSrc = "root/ml/src";
  for (const name of ["train", "eval", "features", "dataflow"]) {
    add(nodes, `${mlSrc}/${name}`, name, mlSrc);
  }

  return { rootId: "root", nodes };
}

export function showcaseWalk() {
  return [
    "root/web",
    "root/web/src",
    "root/web/src/agents",
    "root/web/src/session",
    "root/api",
    "root/api/src",
    "root/api/src/hooks",
    "root/ml",
    "root/ml/src",
    "root/ml/src/eval",
    "root/docs",
    "root/web/src/editor",
    "root/cli",
    "root/cli/src",
  ];
}
