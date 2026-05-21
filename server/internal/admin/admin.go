// Package admin implements the "oreohouse user <subcommand>" CLI
// commands used by the family admin to manage accounts.
package admin

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"golang.org/x/term"

	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
)

// utf8BOM is the three bytes EF BB BF (U+FEFF, UTF-8 encoded). PowerShell
// 5.1 prepends this to anything piped to a native command, and the
// password-stdin path strips it so passwords typed at the keyboard match
// what gets hashed.
var utf8BOM = string([]byte{0xEF, 0xBB, 0xBF})

// RunUser dispatches the "user" subcommands.
// args is the arguments after "user" (e.g. ["add", "--username", "x"]).
// stdin is read in --password-stdin mode; stdout receives normal output.
func RunUser(ctx context.Context, args []string, svc *auth.Service, stdin io.Reader, stdout io.Writer) error {
	if len(args) < 1 {
		return errors.New("usage: oreohouse user <add|list|promote|demote> [flags]")
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "add":
		return userAdd(ctx, rest, svc, stdin, stdout)
	case "list":
		return userList(ctx, rest, svc, stdout)
	case "promote":
		return userSetAdmin(ctx, rest, svc, stdout, true)
	case "demote":
		return userSetAdmin(ctx, rest, svc, stdout, false)
	case "-h", "--help", "help":
		fmt.Fprintln(stdout, "Usage: oreohouse user <add|list|promote|demote> [flags]")
		fmt.Fprintln(stdout, "  add      Create a new user (prompts for password by default).")
		fmt.Fprintln(stdout, "           The first user added to a fresh database is auto-promoted to admin.")
		fmt.Fprintln(stdout, "  list     Print all users, with the ADMIN column showing role.")
		fmt.Fprintln(stdout, "  promote  Mark --username as an admin (gates /api/admin/* and /admin/).")
		fmt.Fprintln(stdout, "  demote   Clear the admin flag on --username. Refuses the last admin.")
		return nil
	default:
		return fmt.Errorf("unknown user subcommand %q (expected add, list, promote, or demote)", sub)
	}
}

func userAdd(ctx context.Context, args []string, svc *auth.Service, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("user add", flag.ContinueOnError)
	fs.SetOutput(stdout)
	var (
		username      = fs.String("username", "", "username for the new user (required)")
		passwordStdin = fs.Bool("password-stdin", false, "read password from stdin (first line) instead of prompting interactively")
	)
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *username == "" {
		return errors.New("--username is required")
	}

	password, err := readPassword(*passwordStdin, stdin)
	if err != nil {
		return err
	}

	user, err := svc.CreateUser(ctx, *username, password)
	if err != nil {
		return err
	}
	// Bootstrap: if there is no admin in the database yet, auto-promote
	// this brand-new user. This is the only way an admin appears on a
	// fresh install — there is no self-signup and the admin panel
	// requires an existing admin to log in.
	n, err := svc.CountAdmins(ctx)
	if err != nil {
		return fmt.Errorf("counting admins: %w", err)
	}
	promoted := false
	if n == 0 {
		if err := svc.SetAdmin(ctx, user.ID, true); err != nil {
			return fmt.Errorf("promoting first user to admin: %w", err)
		}
		promoted = true
	}
	if promoted {
		fmt.Fprintf(stdout, "User %q created (id=%d) and promoted to admin (first user on a fresh database).\n", user.Username, user.ID)
	} else {
		fmt.Fprintf(stdout, "User %q created (id=%d).\n", user.Username, user.ID)
	}
	return nil
}

// userSetAdmin implements both "user promote" (isAdmin=true) and
// "user demote" (isAdmin=false). They share enough plumbing that
// folding them is clearer than two near-duplicate functions.
func userSetAdmin(ctx context.Context, args []string, svc *auth.Service, stdout io.Writer, isAdmin bool) error {
	name := "user demote"
	if isAdmin {
		name = "user promote"
	}
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stdout)
	username := fs.String("username", "", "username to change (required)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *username == "" {
		return errors.New("--username is required")
	}
	u, err := svc.GetUserByUsername(ctx, *username)
	if err != nil {
		return err
	}
	if u.IsAdmin == isAdmin {
		if isAdmin {
			fmt.Fprintf(stdout, "User %q is already an admin; nothing to do.\n", u.Username)
		} else {
			fmt.Fprintf(stdout, "User %q is not an admin; nothing to do.\n", u.Username)
		}
		return nil
	}
	if err := svc.SetAdmin(ctx, u.ID, isAdmin); err != nil {
		return err
	}
	if isAdmin {
		fmt.Fprintf(stdout, "User %q promoted to admin.\n", u.Username)
	} else {
		fmt.Fprintf(stdout, "User %q demoted from admin.\n", u.Username)
	}
	return nil
}

func userList(ctx context.Context, args []string, svc *auth.Service, stdout io.Writer) error {
	fs := flag.NewFlagSet("user list", flag.ContinueOnError)
	fs.SetOutput(stdout)
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}

	users, err := svc.ListUsers(ctx)
	if err != nil {
		return err
	}
	w := tabwriter.NewWriter(stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tUSERNAME\tADMIN\tCREATED")
	for _, u := range users {
		admin := "-"
		if u.IsAdmin {
			admin = "yes"
		}
		fmt.Fprintf(w, "%d\t%s\t%s\t%s\n", u.ID, u.Username, admin, u.CreatedAt.UTC().Format(time.RFC3339))
	}
	return w.Flush()
}

// readPassword reads a password either from stdin (first line, no echo
// concerns) when fromStdin is true, or via two prompts on the terminal
// otherwise (entry + confirmation). The terminal path uses
// golang.org/x/term to disable echo.
func readPassword(fromStdin bool, stdin io.Reader) (string, error) {
	if fromStdin {
		s := bufio.NewScanner(stdin)
		if !s.Scan() {
			if err := s.Err(); err != nil {
				return "", fmt.Errorf("reading password from stdin: %w", err)
			}
			return "", errors.New("expected a password on stdin")
		}
		// PowerShell 5.1 prepends a UTF-8 BOM (EF BB BF) when piping
		// strings to native commands. Strip a leading BOM so the password
		// the user typed matches what we hash.
		return strings.TrimPrefix(s.Text(), utf8BOM), nil
	}
	pw, err := promptPassword("Password: ")
	if err != nil {
		return "", fmt.Errorf("reading password: %w", err)
	}
	confirm, err := promptPassword("Confirm:  ")
	if err != nil {
		return "", fmt.Errorf("reading confirmation: %w", err)
	}
	if pw != confirm {
		return "", errors.New("passwords do not match")
	}
	return pw, nil
}

func promptPassword(label string) (string, error) {
	fmt.Fprint(os.Stderr, label)
	pw, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	return string(pw), nil
}
