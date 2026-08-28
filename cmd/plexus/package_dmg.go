package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/ryusudol/plexus/internal/paths"
)

func packageDMG() error {
	if err := packageHUD(); err != nil {
		return err
	}
	root := paths.RepoRoot()
	dist := filepath.Join(root, "macos", "dist")
	app := filepath.Join(dist, "Plexus.app")
	if _, err := os.Stat(filepath.Join(app, "Contents", "MacOS", "PlexusHUD")); err != nil {
		return fmt.Errorf("missing %s", app)
	}

	stage := filepath.Join(dist, "dmg-stage")
	_ = os.RemoveAll(stage)
	if err := os.MkdirAll(stage, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(stage)

	if err := copyTree(app, filepath.Join(stage, "Plexus.app")); err != nil {
		return err
	}
	if err := os.Symlink("/Applications", filepath.Join(stage, "Applications")); err != nil {
		return err
	}

	rw := filepath.Join(dist, "Plexus.rw.dmg")
	final := filepath.Join(dist, "Plexus.dmg")
	_ = os.Remove(rw)
	_ = os.Remove(final)
	detachVolume("Plexus")

	if err := run("hdiutil", "create",
		"-volname", "Plexus",
		"-srcfolder", stage,
		"-ov",
		"-fs", "HFS+",
		"-format", "UDRW",
		rw,
	); err != nil {
		return err
	}

	mount, err := attachRW(rw)
	if err != nil {
		return err
	}
	layoutDMG("Plexus", mount)
	detachVolume("Plexus")

	if err := run("hdiutil", "convert", rw,
		"-format", "UDZO",
		"-imagekey", "zlib-level=9",
		"-ov",
		"-o", final,
	); err != nil {
		return err
	}
	_ = os.Remove(rw)
	fmt.Println(final)
	return nil
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w\n%s", name, strings.Join(args, " "), err, out)
	}
	return nil
}

func detachVolume(name string) {
	_ = exec.Command("hdiutil", "detach", "/Volumes/"+name, "-force").Run()
	time.Sleep(300 * time.Millisecond)
}

func attachRW(image string) (string, error) {
	cmd := exec.Command("hdiutil", "attach", "-readwrite", "-noverify", "-nobrowse", image)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("hdiutil attach: %w\n%s", err, out)
	}
	mount := ""
	for _, line := range strings.Split(string(out), "\n") {
		if i := strings.Index(line, "/Volumes/"); i >= 0 {
			mount = strings.TrimSpace(line[i:])
		}
	}
	if mount == "" {
		return "", fmt.Errorf("could not find mount point:\n%s", out)
	}
	return mount, nil
}

func layoutDMG(volume, mount string) {
	_ = exec.Command("bless", "--folder", mount, "--openfolder", mount).Run()
	script := `
tell application "Finder"
  tell disk "` + volume + `"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {280, 140, 900, 520}
    set opts to icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 96
    delay 0.4
    set position of item "Plexus.app" of container window to {160, 180}
    set position of item "Applications" of container window to {460, 180}
    close
    open
    update without registering applications
    delay 0.8
  end tell
end tell
`
	_ = exec.Command("osascript", "-e", script).Run()
	icon := filepath.Join(paths.RepoRoot(), "macos", "Resources", "AppIcon.icns")
	if _, err := os.Stat(icon); err == nil {
		dest := filepath.Join(mount, ".VolumeIcon.icns")
		_ = copyFile(icon, dest, 0o644)
		_ = exec.Command("SetFile", "-c", "icnC", dest).Run()
		_ = exec.Command("SetFile", "-a", "C", mount).Run()
	}
}
