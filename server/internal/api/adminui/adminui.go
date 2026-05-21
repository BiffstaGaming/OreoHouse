// Package adminui serves the embedded /admin/ web page. The page is
// plain HTML + ES-module JavaScript with no build step — see
// docs/decisions/0002-admin-ui-vanilla-html.md for the rationale.
package adminui

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed assets/*
var assetsFS embed.FS

// Handler returns an http.Handler that serves the embedded admin UI.
// Mount it under /admin/ via:
//
//	r.Handle("/admin", http.RedirectHandler("/admin/", http.StatusMovedPermanently))
//	r.Handle("/admin/*", http.StripPrefix("/admin/", adminui.Handler()))
//
// The trailing-slash redirect is important: without it, the in-page
// references to ./app.js / ./style.css resolve against the wrong base
// path.
func Handler() http.Handler {
	sub, err := fs.Sub(assetsFS, "assets")
	if err != nil {
		// Unreachable: assets/ exists at build time per //go:embed.
		panic(err)
	}
	return http.FileServer(http.FS(sub))
}
