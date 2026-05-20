// Package server is a thin root package whose only job is to expose
// the embedded SQL migration files to other packages that need them
// (notably cmd/oreohouse and internal/db). //go:embed cannot reach
// upward in the file tree, so the directive has to live next to the
// migrations directory.
package server

import (
	"embed"
	"io/fs"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Migrations returns the embedded SQL migration files, rooted at the
// migrations directory so each entry name is just the migration
// filename (e.g. "0001_users_and_sessions.sql").
func Migrations() fs.FS {
	sub, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		// Unreachable: the migrations directory is guaranteed to exist
		// at build time by the //go:embed directive above.
		panic(err)
	}
	return sub
}
