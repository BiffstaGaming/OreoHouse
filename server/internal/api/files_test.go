package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	server "github.com/BiffstaGaming/OreoHouse/server"
	"github.com/BiffstaGaming/OreoHouse/server/internal/attachments"
	"github.com/BiffstaGaming/OreoHouse/server/internal/auth"
	"github.com/BiffstaGaming/OreoHouse/server/internal/conversations"
	"github.com/BiffstaGaming/OreoHouse/server/internal/db"
	"github.com/BiffstaGaming/OreoHouse/server/internal/messages"
	"github.com/BiffstaGaming/OreoHouse/server/internal/proto"
)

type filesStack struct {
	auth        *auth.Service
	convs       *conversations.Service
	msgs        *messages.Service
	attachments *attachments.Service
	srv         *httptest.Server
}

func newFilesStack(t *testing.T, maxBytes int64) *filesStack {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(ctx, d, server.Migrations()); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })

	uploadDir := t.TempDir()
	attSvc, err := attachments.NewService(d, uploadDir)
	if err != nil {
		t.Fatalf("attachments.NewService: %v", err)
	}
	authSvc := auth.NewService(d, 0)
	convs := conversations.NewService(d)
	msgs := messages.NewService(d)

	r := chi.NewRouter()
	NewFilesHandler(authSvc, attSvc, convs, msgs, maxBytes).Mount(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	return &filesStack{auth: authSvc, convs: convs, msgs: msgs, attachments: attSvc, srv: srv}
}

func (s *filesStack) seedUserWithSession(t *testing.T, name string) (auth.User, string) {
	t.Helper()
	u, err := s.auth.CreateUser(context.Background(), name, "hunter2hunter")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	sess, err := s.auth.CreateSession(context.Background(), u.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return u, sess.Token
}

func uploadBody(t *testing.T, filename, mimeType string, body []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	header := make(map[string][]string)
	header["Content-Disposition"] = []string{
		`form-data; name="file"; filename="` + filename + `"`,
	}
	header["Content-Type"] = []string{mimeType}
	part, err := mw.CreatePart(header)
	if err != nil {
		t.Fatalf("CreatePart: %v", err)
	}
	if _, err := part.Write(body); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close mw: %v", err)
	}
	return &buf, mw.FormDataContentType()
}

func TestUpload_HappyPath(t *testing.T) {
	s := newFilesStack(t, 1<<20)
	_, token := s.seedUserWithSession(t, "alice")

	body, contentType := uploadBody(t, "note.txt", "text/plain", []byte("hello"))
	req, _ := http.NewRequest(http.MethodPost, s.srv.URL+"/api/uploads", body)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", contentType)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var view proto.AttachmentView
	if err := json.NewDecoder(resp.Body).Decode(&view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if view.ID == 0 || view.Filename != "note.txt" || view.SizeBytes != 5 {
		t.Errorf("unexpected view: %+v", view)
	}
}

func TestUpload_RejectsMissingAuth(t *testing.T) {
	s := newFilesStack(t, 1<<20)
	body, contentType := uploadBody(t, "x.txt", "text/plain", []byte("x"))
	req, _ := http.NewRequest(http.MethodPost, s.srv.URL+"/api/uploads", body)
	req.Header.Set("Content-Type", contentType)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestUpload_RejectsOversize(t *testing.T) {
	s := newFilesStack(t, 4) // 4 bytes max
	_, token := s.seedUserWithSession(t, "alice")
	body, contentType := uploadBody(t, "x.txt", "text/plain", []byte("this is way too long"))
	req, _ := http.NewRequest(http.MethodPost, s.srv.URL+"/api/uploads", body)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", contentType)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("expected 413, got %d", resp.StatusCode)
	}
}

func TestUpload_RejectsNonMultipartBody(t *testing.T) {
	s := newFilesStack(t, 1<<20)
	_, token := s.seedUserWithSession(t, "alice")
	req, _ := http.NewRequest(http.MethodPost, s.srv.URL+"/api/uploads", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

func TestDownload_OwnOrphanWorks(t *testing.T) {
	s := newFilesStack(t, 1<<20)
	alice, token := s.seedUserWithSession(t, "alice")

	// Seed an orphan upload via the service directly so we control the bytes.
	a, err := s.attachments.Store(context.Background(), alice.ID,
		"f.txt", "text/plain", strings.NewReader("hello"), 1<<20)
	if err != nil {
		t.Fatalf("Store: %v", err)
	}

	req, _ := http.NewRequest(http.MethodGet,
		s.srv.URL+"/api/files/"+itoa(a.ID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	got, _ := io.ReadAll(resp.Body)
	if string(got) != "hello" {
		t.Errorf("body: got %q, want hello", got)
	}
	if resp.Header.Get("Content-Type") != "text/plain" {
		t.Errorf("Content-Type: got %q", resp.Header.Get("Content-Type"))
	}
}

func TestDownload_AcceptsQueryTokenForImageSrc(t *testing.T) {
	s := newFilesStack(t, 1<<20)
	alice, token := s.seedUserWithSession(t, "alice")
	a, _ := s.attachments.Store(context.Background(), alice.ID,
		"f.txt", "text/plain", strings.NewReader("hi"), 1<<20)

	url := s.srv.URL + "/api/files/" + itoa(a.ID) + "?token=" + token
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200 with query token, got %d", resp.StatusCode)
	}
}

func TestDownload_OrphanForbiddenForOthers(t *testing.T) {
	s := newFilesStack(t, 1<<20)
	alice, _ := s.seedUserWithSession(t, "alice")
	_, bobTok := s.seedUserWithSession(t, "bob")

	a, _ := s.attachments.Store(context.Background(), alice.ID,
		"secret.txt", "text/plain", strings.NewReader("hush"), 1<<20)

	req, _ := http.NewRequest(http.MethodGet,
		s.srv.URL+"/api/files/"+itoa(a.ID), nil)
	req.Header.Set("Authorization", "Bearer "+bobTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for non-uploader orphan, got %d", resp.StatusCode)
	}
}

func TestDownload_AllowedForConversationMember(t *testing.T) {
	s := newFilesStack(t, 1<<20)
	alice, _ := s.seedUserWithSession(t, "alice")
	bob, bobTok := s.seedUserWithSession(t, "bob")
	ctx := context.Background()

	// alice and bob in a DM; alice uploads + attaches a file to a message.
	c, _ := s.convs.FindOrCreateDM(ctx, alice.ID, bob.ID)
	m, _ := s.msgs.Send(ctx, c.ID, alice.ID, "see attached")
	a, _ := s.attachments.Store(ctx, alice.ID, "pic.txt", "text/plain", strings.NewReader("hi"), 1<<20)
	if err := s.attachments.Attach(ctx, a.ID, m.ID, alice.ID); err != nil {
		t.Fatalf("Attach: %v", err)
	}

	req, _ := http.NewRequest(http.MethodGet,
		s.srv.URL+"/api/files/"+itoa(a.ID), nil)
	req.Header.Set("Authorization", "Bearer "+bobTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200 for conv-member, got %d", resp.StatusCode)
	}
}

func TestDownload_ForbiddenForNonMember(t *testing.T) {
	s := newFilesStack(t, 1<<20)
	alice, _ := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")
	_, carolTok := s.seedUserWithSession(t, "carol")
	ctx := context.Background()

	c, _ := s.convs.FindOrCreateDM(ctx, alice.ID, bob.ID)
	m, _ := s.msgs.Send(ctx, c.ID, alice.ID, "see attached")
	a, _ := s.attachments.Store(ctx, alice.ID, "pic.txt", "text/plain", strings.NewReader("hi"), 1<<20)
	_ = s.attachments.Attach(ctx, a.ID, m.ID, alice.ID)

	req, _ := http.NewRequest(http.MethodGet,
		s.srv.URL+"/api/files/"+itoa(a.ID), nil)
	req.Header.Set("Authorization", "Bearer "+carolTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for non-member, got %d", resp.StatusCode)
	}
}

func TestDownloadMessageZip_BundlesAllAttachments(t *testing.T) {
	s := newFilesStack(t, 1<<20)
	alice, aliceTok := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")
	ctx := context.Background()

	c, _ := s.convs.FindOrCreateDM(ctx, alice.ID, bob.ID)
	m, _ := s.msgs.Send(ctx, c.ID, alice.ID, "multi-file")
	// Two attachments, including duplicate filenames to exercise the
	// uniqueZipName collision handling.
	a1, _ := s.attachments.Store(ctx, alice.ID, "doc.pdf", "application/pdf", strings.NewReader("file1"), 1<<20)
	_ = s.attachments.Attach(ctx, a1.ID, m.ID, alice.ID)
	a2, _ := s.attachments.Store(ctx, alice.ID, "doc.pdf", "application/pdf", strings.NewReader("file2-different"), 1<<20)
	_ = s.attachments.Attach(ctx, a2.ID, m.ID, alice.ID)

	req, _ := http.NewRequest(http.MethodGet,
		s.srv.URL+"/api/messages/"+itoa(m.ID)+"/attachments.zip", nil)
	req.Header.Set("Authorization", "Bearer "+aliceTok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/zip" {
		t.Errorf("Content-Type: got %q want application/zip", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("not a valid zip: %v", err)
	}
	if len(zr.File) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(zr.File))
	}
	names := []string{zr.File[0].Name, zr.File[1].Name}
	// Expect doc.pdf then doc (2).pdf via uniqueZipName.
	if names[0] != "doc.pdf" || names[1] != "doc (2).pdf" {
		t.Errorf("expected ['doc.pdf','doc (2).pdf'], got %v", names)
	}
}

func TestDownloadMessageZip_DeniesNonMembers(t *testing.T) {
	s := newFilesStack(t, 1<<20)
	alice, _ := s.seedUserWithSession(t, "alice")
	bob, _ := s.seedUserWithSession(t, "bob")
	_, carolTok := s.seedUserWithSession(t, "carol")
	ctx := context.Background()

	c, _ := s.convs.FindOrCreateDM(ctx, alice.ID, bob.ID)
	m, _ := s.msgs.Send(ctx, c.ID, alice.ID, "private")
	a, _ := s.attachments.Store(ctx, alice.ID, "x.txt", "text/plain", strings.NewReader("nope"), 1<<20)
	_ = s.attachments.Attach(ctx, a.ID, m.ID, alice.ID)

	req, _ := http.NewRequest(http.MethodGet,
		s.srv.URL+"/api/messages/"+itoa(m.ID)+"/attachments.zip", nil)
	req.Header.Set("Authorization", "Bearer "+carolTok)
	resp, _ := http.DefaultClient.Do(req)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for non-member, got %d", resp.StatusCode)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
