package server

import (
	"embed"
	"io/fs"
)

//go:embed static
var staticFiles embed.FS

// staticSubFS strips the "static/" prefix so the embedded files are served at
// their own names (e.g. /static/style.css → static/style.css in the embed).
var staticSubFS fs.FS

func init() {
	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		// static/ is compiled in; Sub cannot fail at runtime.
		panic("server: embed fs.Sub failed: " + err.Error())
	}
	staticSubFS = sub
}
