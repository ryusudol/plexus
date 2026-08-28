package transpile

import "testing"

func TestRewriteSpecifiers(t *testing.T) {
	in := `import { parentFolder } from "../lib/extract.ts";
import { pathUnder } from "../lib/under.ts";
const x = await import("./chrome.ts");
`
	got := rewriteSpecifiers(in)
	if want := `import { parentFolder } from "../lib/extract.js";
import { pathUnder } from "../lib/under.js";
const x = await import("./chrome.js");
`; got != want {
		t.Fatalf("got %q", got)
	}
}
