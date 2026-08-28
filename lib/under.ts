/** Browser-safe path prefix checks. Do not import Node here. */

export function normalizeSlash(value: string): string {
  return value.replace(/\\/g, "/");
}

export function pathUnder(root: string | null | undefined, value: string | null | undefined): boolean {
  if (!root || !value) return false;
  const r = normalizeSlash(String(root)).replace(/\/+$/, "") || "/";
  const v = normalizeSlash(String(value));
  return v === r || v.startsWith(`${r}/`);
}

export function pathsOverlap(a: string | null | undefined, b: string | null | undefined): boolean {
  return pathUnder(a, b) || pathUnder(b, a);
}

export function uniquePush(list: string[], item: string): boolean {
  if (list.includes(item)) return false;
  list.push(item);
  return true;
}

export function uniqueUnder(root: string, lists: Iterable<string[] | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const item of list || []) {
      if (!pathUnder(root, item) || seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}
