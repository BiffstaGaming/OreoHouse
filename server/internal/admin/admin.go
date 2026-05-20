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
	"text/tabwriter"
	"time"

	"golang.org/x/term"

	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
)

// RunUser dispatches the "user" subcommands ("add" and "list").
// args is the arguments after "user" (e.g. ["add", "--username", "x"]).
// stdin is read in --password-stdin mode; stdout receives normal output.
func RunUser(ctx context.Context, args []string, svc *auth.Service, stdin io.Reader, stdout io.Writer) error {
	if len(args) < 1 {
		return errors.New("usage: oreohouse user <add|list> [flags]")
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "add":
		return userAdd(ctx, rest, svc, stdin, stdout)
	case "list":
		return userList(ctx, rest, svc, stdout)
	case "-h", "--help", "help":
		fmt.Fprintln(stdout, "Usage: oreohouse user <add|list> [flags]")
		fmt.Fprintln(stdout, "  add   Create a new user (prompts for password by default)")
		fmt.Fprintln(stdout, "  list  Print all users")
		return nil
	default:
		return fmt.Errorf("unknown user subcommand %q (expected add or list)", sub)
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
	fmt.Fprintf(stdout, "User %q created (id=%d).\n", user.Username, user.ID)
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
	fmt.Fprintln(w, "ID\tUSERNAME\tCREATED")
	for _, u := range users {
		fmt.Fprintf(w, "%d\t%s\t%s\n", u.ID, u.Username, u.CreatedAt.UTC().Format(time.RFC3339))
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
		return s.Text(), nil
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
