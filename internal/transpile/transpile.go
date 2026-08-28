package transpile

import (
	"os"
	"regexp"
	"sync"

	"github.com/evanw/esbuild/pkg/api"
)

type entry struct {
	mtime int64
	body  string
}

var cache sync.Map

var fromTS = regexp.MustCompile(`(from\s+)(["'])([^"']+)\.ts(["'])`)
var importTS = regexp.MustCompile(`(import\s*\(\s*)(["'])([^"']+)\.ts(["'])(\s*\))`)

func rewriteSpecifiers(source string) string {
	source = fromTS.ReplaceAllString(source, `${1}${2}${3}.js${4}`)
	return importTS.ReplaceAllString(source, `${1}${2}${3}.js${4}${5}`)
}

func Transpile(filePath string) (string, error) {
	st, err := os.Stat(filePath)
	if err != nil {
		return "", err
	}
	mtime := st.ModTime().UnixNano()
	if hit, ok := cache.Load(filePath); ok {
		e := hit.(entry)
		if e.mtime == mtime {
			return e.body, nil
		}
	}
	src, err := os.ReadFile(filePath)
	if err != nil {
		return "", err
	}
	result := api.Transform(string(src), api.TransformOptions{
		Loader:     api.LoaderTS,
		Format:     api.FormatESModule,
		Target:     api.ES2022,
		Sourcemap:  api.SourceMapNone,
		Sourcefile: filePath,
	})
	if len(result.Errors) > 0 {
		return "", &transpileError{result.Errors[0].Text}
	}
	body := rewriteSpecifiers(string(result.Code))
	cache.Store(filePath, entry{mtime: mtime, body: body})
	return body, nil
}

type transpileError struct{ msg string }

func (e *transpileError) Error() string { return e.msg }

func ResolveBrowserScript(resolved string) string {
	if len(resolved) > 3 && resolved[len(resolved)-3:] == ".js" {
		tsPath := resolved[:len(resolved)-3] + ".ts"
		if _, err := os.Stat(resolved); err != nil {
			if _, err := os.Stat(tsPath); err == nil {
				return tsPath
			}
		}
	}
	return resolved
}
