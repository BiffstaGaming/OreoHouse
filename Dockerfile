# syntax=docker/dockerfile:1.7

# --- Build stage --------------------------------------------------------
# Go 1.25-alpine because modernc.org/sqlite v1.50+ pulls a go.mod that
# requires >= 1.25. CLAUDE.md still says "Go 1.22+" — the floor is
# whatever our deps demand.
FROM golang:1.25-alpine AS builder
WORKDIR /src

# Cache deps first.
COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ ./

# Static binary: no CGO (modernc.org/sqlite is pure Go).
ENV CGO_ENABLED=0 GOOS=linux
RUN go build -trimpath -ldflags="-s -w" -o /out/oreohouse ./cmd/oreohouse

# --- Final stage --------------------------------------------------------
FROM gcr.io/distroless/static-debian12

WORKDIR /app
COPY --from=builder /out/oreohouse /app/oreohouse

ENV OREOHOUSE_ADDR=:8080 \
    OREOHOUSE_DATA_DIR=/data

EXPOSE 8080
ENTRYPOINT ["/app/oreohouse"]
CMD ["serve"]
