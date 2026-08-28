import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(ROOT, "macos", "dist", "Plexus.app");
const contents = path.join(app, "Contents");
const macOS = path.join(contents, "MacOS");
const binary = path.join(ROOT, "macos", ".build", "release", "PlexusHUD");
if (!fs.existsSync(binary)) {
  console.error("Missing HUD binary. Run swift build first.");
  process.exit(1);
}
fs.mkdirSync(macOS, { recursive: true });
fs.copyFileSync(binary, path.join(macOS, "PlexusHUD"));
fs.chmodSync(path.join(macOS, "PlexusHUD"), 0o755);
fs.copyFileSync(path.join(ROOT, "macos", "Info.plist"), path.join(contents, "Info.plist"));
const resSrc = path.join(ROOT, "macos", "Resources");
const resDst = path.join(contents, "Resources");
fs.mkdirSync(resDst, { recursive: true });
if (fs.existsSync(resSrc)) {
  for (const name of fs.readdirSync(resSrc)) {
    fs.copyFileSync(path.join(resSrc, name), path.join(resDst, name));
  }
}
console.log(app);
