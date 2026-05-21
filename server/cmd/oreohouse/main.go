package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/admin"
	"github.com/BiffstaGaming/OreoHouse/server/internal/api"
	"github.com/BiffstaGaming/OreoHouse/server/internal/attachments"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/conversations"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
	"github.com/BiffstaGaming/OreoHouse/server/internal/messages"
	"github.com/BiffstaGaming/OreoHouse/server/internal/ws"
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
	case "user":
		if err := runUser(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
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
	fmt.Fprintln(os.Stderr, "  user    Manage user accounts (add, list, promote, demote)")
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", envOr("OREOHOUSE_ADDR", defaultAddr), "HTTP listen address (also OREOHOUSE_ADDR)")
	dataDir := fs.String("data-dir", envOr("OREOHOUSE_DATA_DIR", defaultDataDir), "data directory for SQLite + uploads (also OREOHOUSE_DATA_DIR)")
	sessionTTLDays := fs.Int("session-ttl-days", envOrInt("OREOHOUSE_SESSION_TTL_DAYS", 0), "session token lifetime in days; 0 = never expire (also OREOHOUSE_SESSION_TTL_DAYS)")
	maxUploadMB := fs.Int("max-upload-mb", envOrInt("OREOHOUSE_MAX_UPLOAD_MB", 25), "per-upload size cap in MiB (also OREOHOUSE_MAX_UPLOAD_MB)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	startupCtx := context.Background()
	sqlDB, err := openDB(startupCtx, *dataDir)
	if err != nil {
		return err
	}
	defer sqlDB.Close()
	slog.Info("sqlite opened", "path", filepath.Join(*dataDir, dbFilename))

	authSvc := auth.NewService(sqlDB, daysAsDuration(*sessionTTLDays))
	convsSvc := conversations.NewService(sqlDB)
	msgsSvc := messages.NewService(sqlDB)
	attachmentsSvc, err := attachments.NewService(sqlDB, filepath.Join(*dataDir, "uploads"))
	if err != nil {
		return fmt.Errorf("creating attachments service: %w", err)
	}

	authHandler := api.NewAuthHandler(authSvc)
	adminHandler := api.NewAdminHandler(authSvc)

	hub := ws.NewHub()
	convsHandler := api.NewConversationsHandler(authSvc, convsSvc, msgsSvc, attachmentsSvc, hub)
	filesHandler := api.NewFilesHandler(authSvc, attachmentsSvc, convsSvc, msgsSvc, int64(*maxUploadMB)*(1<<20))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go hub.Run(ctx)

	wsHandler := ws.NewHandler(hub, authSvc, convsSvc, msgsSvc, attachmentsSvc)

	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	// The Tauri client's webview runs at a different origin than the
	// server (https://tauri.localhost on Windows, tauri://localhost on
	// other platforms), so REST responses need explicit CORS headers
	// for the browser to let the client read them. Same threat model
	// as InsecureSkipVerify on /ws — LAN-only deployment, allow any
	// origin. We don't use cookies, so credentials stay off and the
	// wildcard origin is allowed.
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: false,
		MaxAge:           300,
	}))
	r.Get("/health", handleHealth)
	r.Get("/ws", wsHandler.ServeHTTP)
	authHandler.Mount(r)
	adminHandler.Mount(r)
	convsHandler.Mount(r)
	filesHandler.Mount(r)

	srv := &http.Server{
		Addr:              *addr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}

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

func runUser(args []string) error {
	dataDir := envOr("OREOHOUSE_DATA_DIR", defaultDataDir)
	ctx := context.Background()
	sqlDB, err := openDB(ctx, dataDir)
	if err != nil {
		return err
	}
	defer sqlDB.Close()
	// TTL is irrelevant for CLI operations; they don't create sessions.
	svc := auth.NewService(sqlDB, 0)
	return admin.RunUser(ctx, args, svc, os.Stdin, os.Stdout)
}

func openDB(ctx context.Context, dataDir string) (*sql.DB, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("creating data dir: %w", err)
	}
	dbPath := filepath.Join(dataDir, dbFilename)
	d, err := db.Open(ctx, dbPath)
	if err != nil {
		return nil, err
	}
	if err := db.Migrate(ctx, d, server.Migrations()); err != nil {
		_ = d.Close()
		return nil, fmt.Errorf("running migrations: %w", err)
	}
	return d, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envOrInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func daysAsDuration(days int) time.Duration {
	if days <= 0 {
		return 0
	}
	return time.Duration(days) * 24 * time.Hour
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
