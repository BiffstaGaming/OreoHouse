import type {
  AttachmentView,
  ConversationView,
  CreateDMRequest,
  CreateGroupRequest,
  CreateRoomRequest,
  ErrorResponse,
  ListConversationsResponse,
  ListMessagesResponse,
  ListRoomsResponse,
  LoginRequest,
  LoginResponse,
  MessageView,
  RoomView,
} from "../types/proto";

// login POSTs /api/auth/login and returns the parsed body on 200. On
// 4xx/5xx it throws an Error whose message is taken from the JSON
// `error` field when present, or `HTTP <status>` otherwise.
export async function login(
  serverUrl: string,
  req: LoginRequest,
): Promise<LoginResponse> {
  const url = new URL("/api/auth/login", serverUrl);
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as ErrorResponse;
      if (body.error) msg = body.error;
    } catch {
      /* body wasn't JSON, keep the HTTP <status> fallback */
    }
    throw new Error(msg);
  }
  return (await resp.json()) as LoginResponse;
}

// logout POSTs /api/auth/logout. Idempotent on the server side, so we
// swallow any errors here too — the local session is already gone.
export async function logout(
  serverUrl: string,
  token: string,
): Promise<void> {
  const url = new URL("/api/auth/logout", serverUrl);
  try {
    await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* network failure on logout shouldn't block the UI flow */
  }
}

// httpToWs derives the WS URL for /ws from the HTTP server URL and
// the session token. Throws if serverUrl is not a valid URL.
export function httpToWs(serverUrl: string, token: string): string {
  const url = new URL("/ws", serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

// listConversations GETs /api/conversations.
export async function listConversations(
  serverUrl: string,
  token: string,
): Promise<ConversationView[]> {
  const body = await getJSON<ListConversationsResponse>(
    serverUrl,
    token,
    "/api/conversations",
  );
  return body.conversations;
}

// createDM POSTs /api/conversations/dm. Idempotent on the server — if
// a DM with the same user already exists, the existing conversation
// is returned.
export async function createDM(
  serverUrl: string,
  token: string,
  userID: number,
): Promise<ConversationView> {
  return postJSON<ConversationView>(
    serverUrl,
    token,
    "/api/conversations/dm",
    { user_id: userID } satisfies CreateDMRequest,
  );
}

// createGroup POSTs /api/conversations/group. The creator is always
// included; memberIDs is the list of additional users to invite.
export async function createGroup(
  serverUrl: string,
  token: string,
  name: string,
  memberIDs: number[],
): Promise<ConversationView> {
  return postJSON<ConversationView>(
    serverUrl,
    token,
    "/api/conversations/group",
    { name, member_ids: memberIDs } satisfies CreateGroupRequest,
  );
}

// createRoom POSTs /api/conversations/room. Name is required.
export async function createRoom(
  serverUrl: string,
  token: string,
  name: string,
  topic: string = "",
): Promise<ConversationView> {
  return postJSON<ConversationView>(
    serverUrl,
    token,
    "/api/conversations/room",
    { name, topic } satisfies CreateRoomRequest,
  );
}

// leaveConversation POSTs /api/conversations/{id}/leave. Returns when
// the server has removed the caller from the member list.
export async function leaveConversation(
  serverUrl: string,
  token: string,
  conversationID: number,
): Promise<void> {
  const url = new URL(
    `/api/conversations/${conversationID}/leave`,
    serverUrl,
  );
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as ErrorResponse;
      if (body.error) msg = body.error;
    } catch {
      /* keep fallback */
    }
    throw new Error(msg);
  }
}

// listRooms GETs /api/rooms — every room in the system with member
// counts, newest first.
export async function listRooms(
  serverUrl: string,
  token: string,
): Promise<RoomView[]> {
  const body = await getJSON<ListRoomsResponse>(
    serverUrl,
    token,
    "/api/rooms",
  );
  return body.rooms;
}

// joinRoom POSTs /api/rooms/{id}/join. Idempotent.
export async function joinRoom(
  serverUrl: string,
  token: string,
  roomID: number,
): Promise<ConversationView> {
  return postJSON<ConversationView>(
    serverUrl,
    token,
    `/api/rooms/${roomID}/join`,
    {},
  );
}

// uploadFile POSTs /api/uploads as multipart/form-data and returns
// the new AttachmentView. The returned id can be embedded in a
// subsequent WS message's attachment_ids[].
export async function uploadFile(
  serverUrl: string,
  token: string,
  file: File,
): Promise<AttachmentView> {
  const url = new URL("/api/uploads", serverUrl);
  const fd = new FormData();
  fd.append("file", file, file.name);
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as ErrorResponse;
      if (body.error) msg = body.error;
    } catch {
      /* keep fallback */
    }
    throw new Error(msg);
  }
  return (await resp.json()) as AttachmentView;
}

// fileURL builds the GET /api/files/{id} URL with the session token
// as a query parameter — needed for <img src> and <a href download>
// since neither can set an Authorization header.
export function fileURL(
  serverUrl: string,
  token: string,
  attachmentID: number,
): string {
  const url = new URL(`/api/files/${attachmentID}`, serverUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

// listMessages GETs /api/conversations/{id}/messages with cursor
// pagination. Pass beforeID=0 (default) for the most recent page.
// Response is newest-first; callers reverse if rendering top-down.
export async function listMessages(
  serverUrl: string,
  token: string,
  conversationID: number,
  beforeID: number = 0,
  limit: number = 50,
): Promise<MessageView[]> {
  const path = new URL(
    `/api/conversations/${conversationID}/messages`,
    serverUrl,
  );
  path.searchParams.set("limit", String(limit));
  if (beforeID > 0) path.searchParams.set("before", String(beforeID));
  const body = await getJSON<ListMessagesResponse>(
    serverUrl,
    token,
    path.pathname + path.search,
  );
  return body.messages;
}

async function getJSON<T>(
  serverUrl: string,
  token: string,
  path: string,
): Promise<T> {
  const url = new URL(path, serverUrl);
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseResponse<T>(resp);
}

async function postJSON<T>(
  serverUrl: string,
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  const url = new URL(path, serverUrl);
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return parseResponse<T>(resp);
}

async function parseResponse<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as ErrorResponse;
      if (body.error) msg = body.error;
    } catch {
      /* body wasn't JSON, keep the HTTP <status> fallback */
    }
    throw new Error(msg);
  }
  return (await resp.json()) as T;
}
