// OreoHouse admin panel — vanilla JS, no build step.
//
// State machine: on load we have a token in localStorage or we don't.
// If we do, try GET /api/admin/users; on success we're in. On 401/403
// we drop the token and show the login screen. Login posts to
// /api/auth/login, stores the token, then runs the same probe.
//
// All API calls share a single fetcher that adds the Authorization
// header and surfaces error messages in the matching <p class="error">.

const TOKEN_KEY = "oreohouse-admin-token";
const USERNAME_KEY = "oreohouse-admin-username";

const $ = (sel) => document.querySelector(sel);

const screens = {
  login: $("#login-screen"),
  dashboard: $("#dashboard"),
};

const els = {
  who: $("#who"),
  logout: $("#logout"),
  loginForm: $("#login-form"),
  loginError: $("#login-error"),
  usersBody: $("#users-body"),
  usersError: $("#users-error"),
  addForm: $("#add-form"),
  addError: $("#add-error"),
  addSuccess: $("#add-success"),
  resetModal: $("#reset-modal"),
  resetForm: $("#reset-form"),
  resetTarget: $("#reset-target"),
  resetError: $("#reset-error"),
  resetCancel: $("#reset-cancel"),
};

let resetTargetId = null;

// ---- token handling -------------------------------------------------

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function setToken(token, username) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    if (username) localStorage.setItem(USERNAME_KEY, username);
  } else {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
  }
}

// ---- API ------------------------------------------------------------

async function api(method, path, body) {
  const init = { method, headers: {} };
  const token = getToken();
  if (token) init.headers["Authorization"] = "Bearer " + token;
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(path, init);
  if (resp.status === 204) return null;
  let data = null;
  const ct = resp.headers.get("Content-Type") || "";
  if (ct.includes("application/json")) data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const err = new Error((data && data.error) || `HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

// ---- screens --------------------------------------------------------

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].hidden = key !== name;
  }
  if (name === "dashboard") {
    els.logout.hidden = false;
    els.who.textContent = "Signed in as " + (localStorage.getItem(USERNAME_KEY) || "?");
  } else {
    els.logout.hidden = true;
    els.who.textContent = "";
  }
}

function showError(elem, msg) {
  elem.textContent = msg;
  elem.hidden = false;
}

function clearMsg(...elems) {
  for (const e of elems) {
    e.textContent = "";
    e.hidden = true;
  }
}

// ---- formatting -----------------------------------------------------

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

// ---- screens: login -------------------------------------------------

els.loginForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  clearMsg(els.loginError);
  const form = new FormData(els.loginForm);
  const username = String(form.get("username") || "").trim();
  const password = String(form.get("password") || "");
  if (!username || !password) {
    showError(els.loginError, "Enter both fields.");
    return;
  }
  try {
    const resp = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      showError(els.loginError, (data && data.error) || `Sign-in failed (HTTP ${resp.status}).`);
      return;
    }
    setToken(data.token, data.user.username);
    // The login endpoint doesn't tell us is_admin — probe the admin
    // surface and let the 403 path bounce non-admins out.
    await loadDashboard();
  } catch (err) {
    showError(els.loginError, err.message || "Sign-in failed.");
  }
});

// ---- screens: dashboard ---------------------------------------------

async function loadDashboard() {
  clearMsg(els.usersError, els.addError, els.addSuccess);
  try {
    // Fetch users + stats in parallel — both are independent and the
    // stats endpoint also returns per-user numbers we'll merge in.
    const [users, stats] = await Promise.all([
      api("GET", "/api/admin/users"),
      api("GET", "/api/admin/stats").catch(function (err) {
        // Stats are best-effort decoration; auth/db errors propagate
        // via the users call.
        console.warn("stats failed:", err);
        return null;
      }),
    ]);
    renderStats(stats);
    renderUsers(users.users || [], stats);
    showScreen("dashboard");
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      setToken("", "");
      showScreen("login");
      if (err.status === 403) {
        showError(els.loginError, "That account isn't an admin.");
      }
      return;
    }
    showScreen("dashboard");
    showError(els.usersError, err.message || "Failed to load users.");
  }
}

function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + " " + units[i];
}

function renderStats(snap) {
  const root = document.getElementById("stats-root");
  const gen = document.getElementById("stats-generated");
  if (!root) return;
  root.innerHTML = "";
  if (!snap) {
    root.textContent = "Stats unavailable.";
    return;
  }
  const o = snap.overview || {};

  // Three semantic groups instead of one undifferentiated grid. Each
  // section has its own muted heading + its own grid row so the eye
  // doesn't have to parse 14 unrelated tiles in sequence.
  const sections = [
    {
      title: "Activity",
      tiles: [
        { label: "Users",      value: o.total_users },
        { label: "Active 7d",  value: o.active_users_7d },
        { label: "Active 30d", value: o.active_users_30d },
        { label: "Admins",     value: o.admin_users },
      ],
    },
    {
      title: "Messages",
      tiles: [
        { label: "Total",     value: o.total_messages, hint: (o.messages_7d || 0) + " in last 7d" },
        { label: "Reactions", value: o.total_reactions },
        { label: "Edited",    value: o.edited_messages },
        { label: "Deleted",   value: o.deleted_messages },
        { label: "Pinned",    value: o.pinned_messages },
      ],
    },
    {
      title: "Conversations & media",
      tiles: [
        { label: "DMs",     value: o.dm_conversations },
        { label: "Groups",  value: o.group_conversations },
        { label: "Rooms",   value: o.room_conversations },
        { label: "Files",   value: o.total_attachments,
          hint: (o.image_attachments || 0) + " images, " + (o.other_attachments || 0) + " other" },
        { label: "Storage", value: humanBytes(o.total_upload_bytes || 0) },
      ],
    },
  ];

  for (const section of sections) {
    const wrap = document.createElement("div");
    wrap.className = "stats-section";

    const h = document.createElement("h3");
    h.className = "stats-section-title";
    h.textContent = section.title;
    wrap.appendChild(h);

    const grid = document.createElement("div");
    grid.className = "stats-grid";
    for (const t of section.tiles) {
      const card = document.createElement("div");
      card.className = "stat-tile";
      const v = document.createElement("div");
      v.className = "stat-value";
      v.textContent = String(t.value ?? "0");
      const l = document.createElement("div");
      l.className = "stat-label";
      l.textContent = t.label;
      card.appendChild(v);
      card.appendChild(l);
      if (t.hint) {
        const hint = document.createElement("div");
        hint.className = "stat-hint";
        hint.textContent = t.hint;
        card.appendChild(hint);
      }
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
    root.appendChild(wrap);
  }

  if (gen && snap.generated_at) {
    gen.textContent = "Snapshot generated " + fmtDate(snap.generated_at);
  }
}

function renderUsers(users, stats) {
  // Build a quick lookup of per-user stats by user id.
  const byID = new Map();
  if (stats && stats.per_user) {
    for (const row of stats.per_user) byID.set(row.id, row);
  }

  els.usersBody.innerHTML = "";
  for (const u of users) {
    const tr = document.createElement("tr");

    tr.appendChild(td(String(u.id), "num"));
    tr.appendChild(td(u.username, "username"));

    const adminCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge" + (u.is_admin ? " admin" : "");
    badge.textContent = u.is_admin ? "admin" : "user";
    adminCell.appendChild(badge);
    tr.appendChild(adminCell);

    tr.appendChild(td(fmtDateShort(u.created_at), "date"));
    tr.appendChild(td(fmtDateShort(u.last_seen_at), "date"));

    // Per-user activity columns (sourced from /api/admin/stats).
    const s = byID.get(u.id) || {};
    tr.appendChild(td(String(s.messages_sent ?? 0), "num"));
    tr.appendChild(td(String(s.attachments_uploaded ?? 0), "num"));
    tr.appendChild(td(humanBytes(s.bytes_uploaded ?? 0), "num"));
    tr.appendChild(td(String(s.reactions_given ?? 0), "num"));
    tr.appendChild(td(String(s.conversations_in ?? 0), "num"));
    tr.appendChild(td(s.latest_client_version || "—", "client"));

    const actions = document.createElement("td");
    actions.className = "row-actions";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "icon-btn";
    reset.title = "Reset " + u.username + "'s password";
    reset.textContent = "🔑 Reset";
    reset.addEventListener("click", () => openResetModal(u));
    actions.appendChild(reset);
    tr.appendChild(actions);

    els.usersBody.appendChild(tr);
  }
}

// fmtDateShort renders an ISO timestamp as "DD MMM, HH:mm" — about
// half the width of toLocaleString("default", { ... }) and reads
// better in the dense user table.
function fmtDateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return d.getDate() + " " + months[d.getMonth()] + ", " +
         String(d.getHours()).padStart(2, "0") + ":" +
         String(d.getMinutes()).padStart(2, "0");
}

function td(text, cls) {
  const cell = document.createElement("td");
  if (cls) cell.className = cls;
  cell.textContent = text;
  return cell;
}

// ---- add user -------------------------------------------------------

els.addForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  clearMsg(els.addError, els.addSuccess);
  const form = new FormData(els.addForm);
  const username = String(form.get("username") || "").trim();
  const password = String(form.get("password") || "");
  try {
    const data = await api("POST", "/api/admin/users", { username, password });
    els.addForm.reset();
    els.addSuccess.textContent = `Created ${data.user.username} (id=${data.user.id}).`;
    els.addSuccess.hidden = false;
    await loadDashboard();
  } catch (err) {
    showError(els.addError, err.message || "Failed to create user.");
  }
});

// ---- reset password modal -------------------------------------------

function openResetModal(user) {
  resetTargetId = user.id;
  els.resetTarget.textContent = user.username;
  clearMsg(els.resetError);
  els.resetForm.reset();
  if (typeof els.resetModal.showModal === "function") {
    els.resetModal.showModal();
  } else {
    // Fallback for older browsers that don't support <dialog>.
    els.resetModal.setAttribute("open", "");
  }
}

function closeResetModal() {
  if (typeof els.resetModal.close === "function") {
    els.resetModal.close();
  } else {
    els.resetModal.removeAttribute("open");
  }
  resetTargetId = null;
}

els.resetCancel.addEventListener("click", closeResetModal);

els.resetForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!resetTargetId) return;
  clearMsg(els.resetError);
  const form = new FormData(els.resetForm);
  const password = String(form.get("password") || "");
  try {
    await api("PUT", `/api/admin/users/${resetTargetId}/password`, { password });
    closeResetModal();
  } catch (err) {
    showError(els.resetError, err.message || "Failed to set password.");
  }
});

// ---- logout ---------------------------------------------------------

els.logout.addEventListener("click", async () => {
  try {
    await api("POST", "/api/auth/logout");
  } catch {
    // Logout is best-effort; the local token clear is what matters.
  }
  setToken("", "");
  showScreen("login");
});

// ---- boot -----------------------------------------------------------

if (getToken()) {
  loadDashboard();
} else {
  showScreen("login");
}
