// Package db provides a SQLite connection helper and a migration runner.
//
// The connection wrapper turns on foreign key enforcement (off by
// default in SQLite). The migration runner applies pending .sql files
// from an embedded fs.FS in lexical order, each in its own
// transaction, and records the names in a _migrations tracking table
// so a second run is a no-op.
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

// Open opens (or creates) the SQLite database at the given filesystem
// path and turns on foreign-key enforcement. Pass ":memory:" for an
// ephemeral in-memory database (useful in tests).
func Open(ctx context.Context, path string) (*sql.DB, error) {
	d, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("opening sqlite at %q: %w", path, err)
	}
	if err := d.PingContext(ctx); err != nil {
		_ = d.Close()
		return nil, fmt.Errorf("pinging sqlite: %w", err)
	}
	if _, err := d.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		_ = d.Close()
		return nil, fmt.Errorf("enabling foreign keys: %w", err)
	}
	return d, nil
}

// Migrate applies any .sql files in migrations that aren't yet recorded
// in the _migrations tracking table. Files are applied in lexical order,
// each inside its own transaction.
func Migrate(ctx context.Context, d *sql.DB, migrations fs.FS) error {
	if _, err := d.ExecContext(ctx, `
        CREATE TABLE IF NOT EXISTS _migrations (
            name       TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        )
    `); err != nil {
		return fmt.Errorf("creating _migrations table: %w", err)
	}

	names, err := listMigrations(migrations)
	if err != nil {
		return fmt.Errorf("listing migrations: %w", err)
	}

	for _, name := range names {
		applied, err := isApplied(ctx, d, name)
		if err != nil {
			return err
		}
		if applied {
			continue
		}
		if err := applyMigration(ctx, d, migrations, name); err != nil {
			return err
		}
	}
	return nil
}

func isApplied(ctx context.Context, d *sql.DB, name string) (bool, error) {
	var n int
	err := d.QueryRowContext(ctx,
		"SELECT 1 FROM _migrations WHERE name = ?", name).Scan(&n)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return false, fmt.Errorf("checking migration %s: %w", name, err)
}

func applyMigration(ctx context.Context, d *sql.DB, migrations fs.FS, name string) error {
	body, err := fs.ReadFile(migrations, name)
	if err != nil {
		return fmt.Errorf("reading migration %s: %w", name, err)
	}
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("beginning tx for %s: %w", name, err)
	}
	if _, err := tx.ExecContext(ctx, string(body)); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("applying migration %s: %w", name, err)
	}
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO _migrations (name, applied_at) VALUES (?, datetime('now'))",
		name); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("recording migration %s: %w", name, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing migration %s: %w", name, err)
	}
	return nil
}

func listMigrations(migrations fs.FS) ([]string, error) {
	var names []string
	err := fs.WalkDir(migrations, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, ".sql") {
			names = append(names, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	return names, nil
}
