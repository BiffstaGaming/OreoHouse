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
    const data = await api("GET", "/api/admin/users");
    renderUsers(data.users || []);
    showScreen("dashboard");
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      // Either no session or not an admin — boot to login.
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

function renderUsers(users) {
  els.usersBody.innerHTML = "";
  for (const u of users) {
    const tr = document.createElement("tr");

    tr.appendChild(td(String(u.id)));
    tr.appendChild(td(u.username));

    const adminCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge" + (u.is_admin ? " admin" : "");
    badge.textContent = u.is_admin ? "admin" : "user";
    adminCell.appendChild(badge);
    tr.appendChild(adminCell);

    tr.appendChild(td(fmtDate(u.created_at)));
    tr.appendChild(td(fmtDate(u.last_seen_at)));

    const actions = document.createElement("td");
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset password";
    reset.addEventListener("click", () => openResetModal(u));
    actions.appendChild(reset);
    tr.appendChild(actions);

    els.usersBody.appendChild(tr);
  }
}

function td(text) {
  const cell = document.createElement("td");
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
