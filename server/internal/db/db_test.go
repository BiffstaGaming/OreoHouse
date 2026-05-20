package db

import (
	"context"
	"testing"
	"testing/fstest"
)

func TestMigrate_AppliesPendingMigrations(t *testing.T) {
	ctx := context.Background()
	d, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer d.Close()

	migrations := fstest.MapFS{
		"0001_first.sql": &fstest.MapFile{
			Data: []byte("CREATE TABLE alpha (id INTEGER PRIMARY KEY)"),
		},
		"0002_second.sql": &fstest.MapFile{
			Data: []byte("CREATE TABLE beta (id INTEGER PRIMARY KEY)"),
		},
	}

	if err := Migrate(ctx, d, migrations); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	for _, table := range []string{"alpha", "beta"} {
		var got string
		err := d.QueryRowContext(ctx,
			"SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&got)
		if err != nil {
			t.Errorf("table %q not created: %v", table, err)
		}
	}

	var count int
	if err := d.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM _migrations").Scan(&count); err != nil {
		t.Fatalf("counting _migrations: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 migrations recorded, got %d", count)
	}
}

func TestMigrate_SkipsAppliedMigrations(t *testing.T) {
	ctx := context.Background()
	d, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer d.Close()

	migrations := fstest.MapFS{
		"0001_first.sql": &fstest.MapFile{
			Data: []byte("CREATE TABLE alpha (id INTEGER PRIMARY KEY)"),
		},
	}

	if err := Migrate(ctx, d, migrations); err != nil {
		t.Fatalf("first Migrate: %v", err)
	}
	// Running again must be a no-op — creating alpha twice would error.
	if err := Migrate(ctx, d, migrations); err != nil {
		t.Fatalf("second Migrate: %v", err)
	}
}

func TestMigrate_RollsBackOnError(t *testing.T) {
	ctx := context.Background()
	d, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer d.Close()

	migrations := fstest.MapFS{
		"0001_broken.sql": &fstest.MapFile{
			Data: []byte("CREATE TABLE alpha (id INTEGER PRIMARY KEY); NOT_VALID_SQL;"),
		},
	}

	if err := Migrate(ctx, d, migrations); err == nil {
		t.Fatal("expected Migrate to fail on broken SQL")
	}

	var count int
	if err := d.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM _migrations").Scan(&count); err != nil {
		t.Fatalf("counting _migrations: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 migrations recorded after failure, got %d", count)
	}

	// The CREATE TABLE alpha statement must also have been rolled back.
	var name string
	err = d.QueryRowContext(ctx,
		"SELECT name FROM sqlite_master WHERE type='table' AND name='alpha'").Scan(&name)
	if err == nil {
		t.Errorf("expected alpha table to be rolled back, but it exists")
	}
}

func TestMigrate_AppliesInLexicalOrder(t *testing.T) {
	ctx := context.Background()
	d, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer d.Close()

	// 0002 creates a table that 0003 alters. If the runner applied them
	// in map-iteration order (random) instead of sorted, 0003 would fail.
	migrations := fstest.MapFS{
		"0003_alters_alpha.sql": &fstest.MapFile{
			Data: []byte("ALTER TABLE alpha ADD COLUMN extra TEXT"),
		},
		"0002_creates_alpha.sql": &fstest.MapFile{
			Data: []byte("CREATE TABLE alpha (id INTEGER PRIMARY KEY)"),
		},
	}

	if err := Migrate(ctx, d, migrations); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
}

func TestOpen_EnablesForeignKeys(t *testing.T) {
	ctx := context.Background()
	d, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer d.Close()

	var fk int
	if err := d.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fk); err != nil {
		t.Fatalf("PRAGMA foreign_keys: %v", err)
	}
	if fk != 1 {
		t.Errorf("expected foreign_keys=1, got %d", fk)
	}
}
