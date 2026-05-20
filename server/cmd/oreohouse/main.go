package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
)

const (
	defaultAddr    = ":8080"
	defaultDataDir = "./data"
	dbFilename     = "oreohouse.db"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "serve":
		if err := runServe(os.Args[2:]); err != nil {
			slog.Error("serve failed", "error", err)
			os.Exit(1)
		}
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "Usage: oreohouse <command> [flags]")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Commands:")
	fmt.Fprintln(os.Stderr, "  serve   Run the HTTP + WebSocket server")
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", envOr("OREOHOUSE_ADDR", defaultAddr), "HTTP listen address (also OREOHOUSE_ADDR)")
	dataDir := fs.String("data-dir", envOr("OREOHOUSE_DATA_DIR", defaultDataDir), "data directory for SQLite + uploads (also OREOHOUSE_DATA_DIR)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if err := os.MkdirAll(*dataDir, 0o755); err != nil {
		return fmt.Errorf("creating data dir: %w", err)
	}

	dbPath := filepath.Join(*dataDir, dbFilename)
	startupCtx := context.Background()
	sqlDB, err := db.Open(startupCtx, dbPath)
	if err != nil {
		return err
	}
	defer sqlDB.Close()
	if err := db.Migrate(startupCtx, sqlDB, server.Migrations()); err != nil {
		return fmt.Errorf("running migrations: %w", err)
	}
	slog.Info("sqlite opened", "path", dbPath)

	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Get("/health", handleHealth)
	r.Get("/ws", handleWS)

	srv := &http.Server{
		Addr:              *addr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		slog.Info("server listening", "addr", *addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		slog.Info("shutdown signal received")
	case err := <-errCh:
		return fmt.Errorf("listen: %w", err)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	slog.Info("server stopped")
	return nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Phase 0: LAN-only dev, accept any origin so the Tauri client
		// (which uses a custom protocol origin) can connect.
		InsecureSkipVerify: true,
	})
	if err != nil {
		slog.Error("ws accept failed", "error", err)
		return
	}
	defer conn.Close(websocket.StatusInternalError, "internal error")

	slog.Info("ws client connected", "remote", r.RemoteAddr)

	ctx := r.Context()
	for {
		var incoming map[string]any
		if err := wsjson.Read(ctx, conn, &incoming); err != nil {
			slog.Info("ws client disconnected", "remote", r.RemoteAddr, "error", err)
			return
		}
		if incoming == nil {
			incoming = map[string]any{}
		}
		incoming["received_at"] = time.Now().UTC().Format(time.RFC3339Nano)
		if err := wsjson.Write(ctx, conn, incoming); err != nil {
			slog.Info("ws write failed", "remote", r.RemoteAddr, "error", err)
			return
		}
	}
}
