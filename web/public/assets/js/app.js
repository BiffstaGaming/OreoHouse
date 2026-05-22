// OreoHouse web client — main controller.
//
// Boot order:
//   1. PHP injected window.OREO = { serverUrl, token, user }
//   2. We connect WS + GET /api/conversations in parallel
//   3. On welcome we render the sidebar; clicking a contact opens
//      the chat pane and pulls history via GET .../messages.
//
// State is intentionally global (a single `state` object) — there's
// one window, one user, one socket. No framework, no JSX, just DOM.

(function () {
    'use strict';

    const $ = function (sel) { return document.querySelector(sel); };
    const root = document.getElementById('app');
    const UI = window.OreoUI;
    const API = window.OreoAPI;
    const H  = window.OreoHelpers;

    if (!window.OREO || !window.OREO.token) {
        window.location.href = '/index.php';
        return;
    }

    // ---- state -----------------------------------------------------

    const state = {
        me: window.OREO.user,
        users: new Map(),                  // id -> UserInfo (cached pool)
        online: new Map(),                 // id -> { state, custom_text }
        conversations: new Map(),          // id -> ConversationView
        messages: new Map(),               // convID -> [MessageView]
        reactions: new Map(),              // messageID -> [{emoji, user_ids}]
        reads: new Map(),                  // convID -> Map<userID, lastReadID>
        pinned: new Map(),                 // convID -> Set<messageID>
        unread: new Map(),                 // convID -> count
        typers: new Map(),                 // convID -> Map<userID, expiresAt>
        // Per-conv UI mute (no blip/flash/unread). Persisted in localStorage.
        mutedConvs: H.loadMutedConvs(),
        // Per-machine sound mute (suppresses every sound). Persisted.
        soundsMuted: H.loadSoundsMuted(),
        // Reply / edit composer state. Mutually exclusive.
        replyTarget: null,                 // MessageView
        editingMessage: null,              // MessageView
        // Custom status (online/away/busy + free text). Sent over WS.
        customStatus: { state: 'online', custom_text: '' },
        // Per-machine arming gate for sign-in/out chimes — the welcome
        // burst should not turn into a chorus. Armed 3s after boot.
        presenceArmedAt: Date.now() + 3000,
        // True until the user has loaded all of history (or hit EOF).
        // Per-conv map so we don't repeatedly hit the server.
        historyLoaded: new Map(),          // convID -> true when no more
        historyLoading: new Set(),         // convID set while in flight
        currentConvID: null,
        ws: null,
    };

    state.users.set(state.me.id, state.me);
    // Sounds helper consults this getter on every play* call.
    H.setMutedGetter(function () { return state.soundsMuted; });

    function upsertUser(u) {
        if (!u || !u.id) return;
        const existing = state.users.get(u.id);
        if (!existing || JSON.stringify(existing) !== JSON.stringify(u)) {
            state.users.set(u.id, u);
            // Re-render any open avatars for this user; the cheap
            // approach is to ping a global refresh hook.
            refreshAvatarsFor(u.id);
        }
    }

    function refreshAvatarsFor(userID) {
        // Repaint all <img class="avatar"> tagged with data-user-id.
        document.querySelectorAll('[data-user-id="' + userID + '"]').forEach(function (node) {
            const u = state.users.get(userID);
            if (!u) return;
            const newNode = UI.avatar(u, parseInt(node.dataset.size || '32', 10));
            newNode.dataset.userId = String(userID);
            newNode.dataset.size = node.dataset.size || '32';
            node.replaceWith(newNode);
        });
    }

    // ---- layout shell ----------------------------------------------

    function renderShell() {
        root.innerHTML = '';

        const topbar = UI.el('header', { class: 'topbar' }, [
            UI.el('div', { class: 'topbar-brand' }, [
                UI.el('img', { class: 'topbar-icon', src: '/assets/img/icon.png', alt: '' }),
                UI.el('span', { text: 'OreoHouse' }),
                UI.el('span', { id: 'topbar-unread', class: 'topbar-unread' }),
            ]),
            UI.el('div', { class: 'topbar-spacer' }),
            UI.el('button', {
                class: 'topbar-icon-btn',
                id: 'topbar-sound',
                title: state.soundsMuted ? 'Sounds muted (click to unmute)' : 'Sounds on (click to mute)',
                onclick: toggleSoundsMuted,
            }, state.soundsMuted ? '🔇' : '🔊'),
            UI.el('button', {
                class: 'topbar-icon-btn',
                title: 'Search messages (Ctrl+K)',
                onclick: openSearchModal,
            }, '🔍'),
            statusChip(),
            UI.el('button', { class: 'topbar-self', onclick: openProfileModal }, [
                wrapAvatar(state.me, 28),
                UI.el('span', { class: 'self-label', text: UI.displayLabel(state.me) }),
            ]),
            UI.el('button', {
                class: 'topbar-icon-btn',
                title: 'Menu',
                onclick: function (ev) { openSettingsMenu(ev.currentTarget); },
            }, '⚙️'),
        ]);

        const sidebar = UI.el('aside', { class: 'sidebar', id: 'sidebar' });
        const main = UI.el('section', { class: 'main', id: 'main' }, [
            UI.el('div', { class: 'placeholder' }, 'Pick a conversation to start chatting.'),
        ]);

        root.appendChild(topbar);
        root.appendChild(UI.el('div', { class: 'layout' }, [sidebar, main]));
    }

    function wrapAvatar(user, size) {
        const a = UI.avatar(user, size);
        a.dataset.userId = String(user.id);
        a.dataset.size = String(size || 32);
        return a;
    }

    // ---- sidebar / contact list ------------------------------------

    function renderSidebar() {
        const sb = document.getElementById('sidebar');
        if (!sb) return;
        sb.innerHTML = '';

        const search = UI.el('input', {
            class: 'sidebar-search',
            type: 'search',
            placeholder: 'Filter…',
            oninput: function (ev) { filterSidebar(ev.target.value); },
        });
        sb.appendChild(search);

        sb.appendChild(UI.el('div', { class: 'sidebar-actions' }, [
            UI.el('button', { class: 'sidebar-action', onclick: openNewGroupModal, title: 'Start a group chat' }, '+ Group'),
            UI.el('button', { class: 'sidebar-action', onclick: openNewRoomModal, title: 'Create a persistent room' }, '+ Room'),
            UI.el('button', { class: 'sidebar-action', onclick: openBrowseRoomsModal, title: 'Browse joinable rooms' }, 'Browse'),
        ]));

        // Group conversations by type for tidy sections.
        const dms = [];
        const groups = [];
        const rooms = [];
        state.conversations.forEach(function (conv) {
            if (conv.type === 'dm') dms.push(conv);
            else if (conv.type === 'room') rooms.push(conv);
            else groups.push(conv);
        });

        // Online users that aren't already a DM partner — let the user
        // start a new conversation with one click.
        const dmPartnerIDs = new Set();
        dms.forEach(function (d) {
            d.members.forEach(function (m) { if (m.id !== state.me.id) dmPartnerIDs.add(m.id); });
        });
        const startableUsers = [];
        state.online.forEach(function (_, uid) {
            if (uid === state.me.id) return;
            if (dmPartnerIDs.has(uid)) return;
            const u = state.users.get(uid);
            if (u) startableUsers.push(u);
        });

        if (dms.length > 0) {
            sb.appendChild(sectionHeader('Direct messages'));
            dms.sort(byRecency).forEach(function (c) { sb.appendChild(contactRow(c)); });
        }
        if (startableUsers.length > 0) {
            sb.appendChild(sectionHeader('Online'));
            startableUsers.sort(function (a, b) {
                return UI.displayLabel(a).localeCompare(UI.displayLabel(b));
            }).forEach(function (u) {
                sb.appendChild(startDMRow(u));
            });
        }
        if (groups.length > 0) {
            sb.appendChild(sectionHeader('Groups'));
            groups.sort(byName).forEach(function (c) { sb.appendChild(contactRow(c)); });
        }
        if (rooms.length > 0) {
            sb.appendChild(sectionHeader('Rooms'));
            rooms.sort(byName).forEach(function (c) { sb.appendChild(contactRow(c)); });
        }
    }

    function sectionHeader(label) {
        return UI.el('div', { class: 'sidebar-section' }, label);
    }

    function byName(a, b) {
        return convDisplayName(a).localeCompare(convDisplayName(b));
    }
    function byRecency(a, b) {
        // Sort by created_at desc as a proxy. Last-activity tracking
        // would need a server field we don't have yet.
        return (b.created_at || '').localeCompare(a.created_at || '');
    }

    function convDisplayName(conv) {
        if (conv.name && conv.name.trim()) return conv.name;
        if (conv.type === 'dm') {
            const other = conv.members.find(function (m) { return m.id !== state.me.id; });
            return other ? UI.displayLabel(other) : '(empty conversation)';
        }
        // unnamed group — list the first few members
        const labels = conv.members
            .filter(function (m) { return m.id !== state.me.id; })
            .slice(0, 3)
            .map(UI.displayLabel);
        return labels.join(', ') || '(empty group)';
    }

    function contactRow(conv) {
        const isOpen = conv.id === state.currentConvID;
        const unread = state.unread.get(conv.id) || 0;

        let avatarNode;
        let dot = null;
        if (conv.type === 'dm') {
            const other = conv.members.find(function (m) { return m.id !== state.me.id; });
            if (other) {
                avatarNode = wrapAvatar(other, 36);
                const pres = state.online.get(other.id);
                dot = UI.presenceDot(pres ? pres.state : 'offline');
            } else {
                avatarNode = UI.el('span', { class: 'avatar avatar-empty' }, '?');
            }
        } else {
            avatarNode = UI.el('span', {
                class: 'avatar avatar-group',
                style: 'background:hsl(' + UI.avatarHue(conv.id) + ',55%,72%);',
            }, conv.type === 'room' ? '#' : '👥');
        }

        return UI.el('button', {
            class: 'contact' + (isOpen ? ' contact-open' : ''),
            onclick: function () { openConversation(conv.id); },
            'data-conv-name': convDisplayName(conv).toLowerCase(),
        }, [
            UI.el('span', { class: 'contact-avatar-wrap' }, [avatarNode, dot].filter(Boolean)),
            UI.el('span', { class: 'contact-label' }, [
                UI.el('span', { class: 'contact-title', text: convDisplayName(conv) }),
                conv.topic ? UI.el('span', { class: 'contact-topic', text: conv.topic }) : null,
            ]),
            unread > 0 ? UI.el('span', { class: 'contact-badge', text: String(unread) }) : null,
        ]);
    }

    function startDMRow(user) {
        return UI.el('button', {
            class: 'contact contact-start',
            onclick: async function () {
                try {
                    const conv = await API.createDM(user.id);
                    state.conversations.set(conv.id, conv);
                    conv.members.forEach(upsertUser);
                    renderSidebar();
                    openConversation(conv.id);
                } catch (e) {
                    alert('Could not start DM: ' + e.message);
                }
            },
            'data-conv-name': UI.displayLabel(user).toLowerCase(),
        }, [
            UI.el('span', { class: 'contact-avatar-wrap' }, [
                wrapAvatar(user, 36),
                UI.presenceDot((state.online.get(user.id) || {}).state || 'offline'),
            ]),
            UI.el('span', { class: 'contact-label' }, [
                UI.el('span', { class: 'contact-title', text: UI.displayLabel(user) }),
                UI.el('span', { class: 'contact-topic', text: 'Click to start chatting' }),
            ]),
        ]);
    }

    function filterSidebar(q) {
        const needle = (q || '').trim().toLowerCase();
        document.querySelectorAll('.contact[data-conv-name]').forEach(function (n) {
            const name = n.getAttribute('data-conv-name') || '';
            n.style.display = (needle === '' || name.indexOf(needle) !== -1) ? '' : 'none';
        });
    }

    // ---- main / conversation pane ----------------------------------

    async function openConversation(convID) {
        state.currentConvID = convID;
        state.unread.set(convID, 0);
        // Drop any reply/edit composer state lingering from the previous
        // conversation — UX would be confusing otherwise.
        state.replyTarget = null;
        state.editingMessage = null;
        renderSidebar();
        renderMain();
        // Load history (newest first) if we haven't already.
        const have = state.messages.get(convID);
        if (!have || have.length === 0) {
            try {
                const resp = await API.listMessages(convID, null, 50);
                const ordered = (resp.messages || []).slice().reverse();
                ordered.forEach(function (m) {
                    if (m.sender) upsertUser(m.sender);
                    if (m.reactions) state.reactions.set(m.id, m.reactions);
                });
                state.messages.set(convID, ordered);
                renderMain();
            } catch (e) {
                console.error('history load failed', e);
            }
            // Hydrate the pinned set so 📌 badges render on history.
            // Best-effort; failure is non-fatal — pins still flow via WS.
            try {
                const pins = await API.listPins(convID);
                let set = state.pinned.get(convID);
                if (!set) { set = new Set(); state.pinned.set(convID, set); }
                pins.forEach(function (p) { set.add(p.message.id); });
                if (convID === state.currentConvID) renderMain();
            } catch (e) { /* shrug */ }
        }
        markCurrentRead();
    }

    function renderMain() {
        const main = document.getElementById('main');
        if (!main) return;
        main.innerHTML = '';

        const convID = state.currentConvID;
        if (!convID) {
            main.appendChild(UI.el('div', { class: 'placeholder' }, 'Pick a conversation to start chatting.'));
            return;
        }
        const conv = state.conversations.get(convID);
        if (!conv) {
            main.appendChild(UI.el('div', { class: 'placeholder' }, 'Loading…'));
            return;
        }

        const isConvMuted = state.mutedConvs.has(convID);
        const header = UI.el('div', { class: 'chat-header' }, [
            UI.el('div', { class: 'chat-title' }, [
                UI.el('span', { class: 'chat-name', text: convDisplayName(conv) }),
                conv.topic ? UI.el('span', { class: 'chat-topic', text: conv.topic }) : null,
            ]),
            UI.el('div', { class: 'chat-meta', text: memberSummary(conv) }),
            UI.el('div', { class: 'chat-actions' }, [
                UI.el('button', {
                    class: 'composer-icon-btn',
                    title: 'View pinned messages',
                    onclick: function () { openPinsModal(convID); },
                }, '📌'),
                UI.el('button', {
                    class: 'composer-icon-btn',
                    title: 'Media & links in this conversation',
                    onclick: function () { openMediaPanel(convID); },
                }, '🖼️'),
                UI.el('button', {
                    class: 'composer-icon-btn',
                    title: isConvMuted ? 'Unmute this conversation' : 'Mute this conversation',
                    onclick: function () { toggleConvMute(convID); },
                }, isConvMuted ? '🔕' : '🔔'),
                conv.type !== 'dm'
                    ? UI.el('button', {
                        class: 'composer-icon-btn',
                        title: 'Add members',
                        onclick: function () { openAddMembersModal(convID); },
                    }, '➕')
                    : null,
                UI.el('button', {
                    class: 'composer-icon-btn',
                    title: 'Search in this conversation (Ctrl/Cmd+F)',
                    onclick: function () { openSearchModal(convID); },
                }, '🔎'),
                UI.el('button', {
                    class: 'composer-icon-btn',
                    title: 'More actions',
                    onclick: function (ev) { openConvActionsMenu(convID, ev.currentTarget); },
                }, '⋯'),
            ]),
        ]);

        const log = UI.el('div', {
            class: 'message-log',
            id: 'message-log',
            onscroll: function () {
                if (log.scrollTop < 80) loadOlderMessages(convID);
            },
        });
        renderMessages(log, convID);

        const typingBar = UI.el('div', { class: 'typing-bar', id: 'typing-bar' });
        renderTypingBar(typingBar, convID);

        const composer = renderComposer(conv);

        main.appendChild(header);
        main.appendChild(log);
        main.appendChild(typingBar);
        main.appendChild(composer);

        // Scroll to bottom on open.
        log.scrollTop = log.scrollHeight;
    }

    function memberSummary(conv) {
        if (conv.type === 'dm') {
            const other = conv.members.find(function (m) { return m.id !== state.me.id; });
            if (!other) return '';
            const p = state.online.get(other.id);
            if (!p) return 'offline';
            if (p.custom_text) return p.state + ' — ' + p.custom_text;
            return p.state;
        }
        return conv.members.length + ' member' + (conv.members.length === 1 ? '' : 's');
    }

    function renderMessages(log, convID) {
        const msgs = state.messages.get(convID) || [];
        msgs.forEach(function (m, i) {
            const prev = i > 0 ? msgs[i - 1] : null;
            log.appendChild(messageRow(m, prev));
        });
    }

    function messageRow(m, prev) {
        const sender = state.users.get(m.sender.id) || m.sender;
        const mine = sender.id === state.me.id;
        const groupWithPrev = prev && prev.sender.id === sender.id &&
            (new Date(m.created_at) - new Date(prev.created_at)) < 5 * 60 * 1000;
        const isPinned = (state.pinned.get(m.conversation_id) || new Set()).has(m.id);
        const isDeleted = !!m.deleted_at;
        const isEdited  = !!m.edited_at && !isDeleted;

        const row = UI.el('div', {
            class: 'msg' + (mine ? ' msg-mine' : '') + (groupWithPrev ? ' msg-grouped' : ''),
            'data-message-id': String(m.id),
        });

        if (!groupWithPrev) {
            row.appendChild(UI.el('div', { class: 'msg-avatar' }, [wrapAvatar(sender, 32)]));
        } else {
            row.appendChild(UI.el('div', { class: 'msg-avatar' }));
        }

        const bubble = UI.el('div', { class: 'msg-bubble' });

        // Teams-style reply quote, above everything else in the bubble.
        if (m.reply_to) {
            const quoteSender = state.users.get(m.reply_to.sender.id) || m.reply_to.sender;
            bubble.appendChild(UI.el('div', {
                class: 'msg-quote',
                title: m.reply_to.deleted ? 'Deleted message' : m.reply_to.body,
            }, [
                UI.el('div', { class: 'msg-quote-sender' }, [
                    UI.el('span', { class: 'msg-quote-arrow', text: '↪ ' }),
                    UI.el('span', { text: UI.displayLabel(quoteSender) }),
                ]),
                UI.el('div', { class: 'msg-quote-body' },
                    m.reply_to.deleted
                        ? UI.el('span', { class: 'msg-quote-deleted', text: '(deleted message)' })
                        : UI.el('span', { text: m.reply_to.body || '' }),
                ),
            ]));
        }

        if (!groupWithPrev) {
            bubble.appendChild(UI.el('div', { class: 'msg-meta' }, [
                UI.el('span', { class: 'msg-author', text: UI.displayLabel(sender) }),
                isPinned ? UI.el('span', { class: 'msg-pinned-badge', title: 'Pinned' }, '📌') : null,
                UI.el('span', { class: 'msg-time', text: UI.formatTime(m.created_at) }),
            ]));
        }

        if (isDeleted) {
            bubble.appendChild(UI.el('div', { class: 'msg-body msg-deleted', text: 'this message was deleted' }));
        } else if (m.body && m.body.length > 0) {
            const body = UI.el('div', { class: 'msg-body', html: UI.linkify(m.body) });
            if (isEdited) {
                body.appendChild(UI.el('span', { class: 'msg-edited', text: ' (edited)' }));
            }
            bubble.appendChild(body);
        }

        if (!isDeleted && m.attachments && m.attachments.length > 0) {
            const wrap = UI.el('div', { class: 'msg-attachments' });
            m.attachments.forEach(function (a) {
                if (UI.isImageMime(a.mime_type)) {
                    const img = UI.el('img', {
                        class: 'msg-image',
                        src: API.fileURL(a.id),
                        alt: a.filename,
                        loading: 'lazy',
                        onclick: function () { openLightbox(API.fileURL(a.id)); },
                    });
                    wrap.appendChild(img);
                } else {
                    wrap.appendChild(UI.el('a', {
                        class: 'msg-file',
                        href: API.fileURL(a.id),
                        target: '_blank',
                        rel: 'noopener noreferrer',
                    }, [
                        UI.el('span', { class: 'msg-file-icon' }, '📎'),
                        UI.el('span', { class: 'msg-file-name', text: a.filename }),
                        UI.el('span', { class: 'msg-file-size', text: humanSize(a.size_bytes) }),
                    ]));
                }
            });
            // 2+ attachments → "Save all as ZIP" link, so the user doesn't
            // have to right-click → Save link as on each one. Server
            // streams /api/messages/{id}/attachments.zip; the browser
            // does the rest.
            if (m.attachments.length >= 2) {
                wrap.appendChild(UI.el('a', {
                    class: 'msg-save-all',
                    href: API.messageAttachmentsZipURL(m.id),
                    title: 'Download all ' + m.attachments.length + ' attachments as a ZIP',
                }, '⬇ Save all (' + m.attachments.length + ')'));
            }
            bubble.appendChild(wrap);
        }

        // Reactions pills.
        const reactions = state.reactions.get(m.id) || m.reactions || [];
        if (reactions.length > 0) {
            const pillsWrap = UI.el('div', { class: 'msg-reactions' });
            reactions.forEach(function (g) {
                const reacted = g.user_ids.indexOf(state.me.id) !== -1;
                pillsWrap.appendChild(UI.el('button', {
                    class: 'reaction-pill' + (reacted ? ' reaction-mine' : ''),
                    onclick: function () { state.ws.sendReact(m.id, g.emoji); },
                    title: g.user_ids.map(function (uid) {
                        return UI.displayLabel(state.users.get(uid) || { username: 'user#' + uid });
                    }).join(', '),
                }, [
                    UI.el('span', { class: 'reaction-emoji', text: g.emoji }),
                    UI.el('span', { class: 'reaction-count', text: String(g.user_ids.length) }),
                ]));
            });
            bubble.appendChild(pillsWrap);
        }

        // Tick marks for own undeleted messages.
        if (mine && !isDeleted) {
            bubble.appendChild(renderTicks(m));
        }

        // Hover toolbar (reactions + actions).
        if (!isDeleted) {
            bubble.appendChild(buildMessageToolbar(m, mine));
        }

        row.appendChild(bubble);
        return row;
    }

    function renderTicks(m) {
        // Count members other than me who have read up to >= m.id.
        const conv = state.conversations.get(m.conversation_id);
        if (!conv) return UI.el('span');
        const otherIDs = conv.members
            .map(function (u) { return u.id; })
            .filter(function (id) { return id !== state.me.id; });
        const readsMap = state.reads.get(m.conversation_id) || new Map();
        let readers = 0;
        otherIDs.forEach(function (uid) {
            if ((readsMap.get(uid) || 0) >= m.id) readers++;
        });
        let icon, cls, title;
        if (readers === 0) {
            icon = '✓'; cls = 'msg-ticks-sent';
            title = 'Sent';
        } else if (readers < otherIDs.length) {
            icon = '✓✓'; cls = 'msg-ticks-partial';
            title = 'Read by ' + readers + '/' + otherIDs.length;
        } else {
            icon = '✓✓'; cls = 'msg-ticks-read';
            title = otherIDs.length === 1 ? 'Read' : 'Read by everyone';
        }
        return UI.el('div', { class: 'msg-ticks ' + cls, title: title }, icon);
    }

    function buildMessageToolbar(m, mine) {
        const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
        const bar = UI.el('div', { class: 'msg-toolbar' });
        QUICK.forEach(function (e) {
            bar.appendChild(UI.el('button', {
                class: 'tool-btn',
                title: 'React with ' + e,
                onclick: function () { state.ws.sendReact(m.id, e); },
            }, e));
        });
        bar.appendChild(UI.el('button', {
            class: 'tool-btn',
            title: 'More reactions…',
            onclick: function (ev) {
                openEmojiPicker(function (emoji) { state.ws.sendReact(m.id, emoji); }, ev.currentTarget);
            },
        }, '⊕'));
        bar.appendChild(UI.el('button', {
            class: 'tool-btn',
            title: 'Reply',
            onclick: function () { startReply(m); },
        }, '↩'));
        // Pin/Unpin available to every member.
        const isPinned = (state.pinned.get(m.conversation_id) || new Set()).has(m.id);
        bar.appendChild(UI.el('button', {
            class: 'tool-btn',
            title: isPinned ? 'Unpin' : 'Pin',
            onclick: function () {
                if (isPinned) state.ws.sendUnpin(m.id);
                else state.ws.sendPin(m.id);
            },
        }, isPinned ? '📍' : '📌'));
        // Edit / Delete are own-message only. Edit is server-gated to a
        // 15-minute window; the button is always shown — the server
        // will refuse and the UI logs the error.
        if (mine) {
            bar.appendChild(UI.el('button', {
                class: 'tool-btn',
                title: 'Edit',
                onclick: function () { startEdit(m); },
            }, '✏️'));
            bar.appendChild(UI.el('button', {
                class: 'tool-btn tool-btn-danger',
                title: 'Delete',
                onclick: function () {
                    if (confirm('Delete this message?')) state.ws.sendDelete(m.id);
                },
            }, '🗑'));
        }
        return bar;
    }

    function humanSize(b) {
        if (!b) return '';
        if (b < 1024) return b + ' B';
        if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
        return (b / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ---- composer --------------------------------------------------

    function renderComposer(conv) {
        const pending = []; // pending attachment uploads, attached on send

        const contextBar = UI.el('div', { class: 'composer-context-bar', id: 'composer-context-bar' });
        const pendingBar = UI.el('div', { class: 'composer-pending', id: 'composer-pending' });
        const textArea = UI.el('textarea', {
            class: 'composer-input',
            rows: '2',
            placeholder: 'Write a message — Enter to send, Shift+Enter for newline',
            oninput: function () {
                if (!state.editingMessage) state.ws.sendTyping(conv.id);
            },
            onkeydown: function (ev) {
                if (ev.key === 'Escape' && (state.replyTarget || state.editingMessage)) {
                    cancelComposerContext();
                    ev.preventDefault();
                    return;
                }
                if (ev.key === 'Enter' && !ev.shiftKey) {
                    ev.preventDefault();
                    submit();
                }
            },
            onpaste: function (ev) {
                handlePaste(ev, pending, pendingBar);
            },
        });

        function repaintContext() {
            contextBar.innerHTML = '';
            if (state.editingMessage) {
                contextBar.appendChild(UI.el('div', { class: 'composer-context composer-context-edit' }, [
                    UI.el('span', { class: 'composer-context-label', text: '✏️ Editing' }),
                    UI.el('span', { class: 'composer-context-body', text: state.editingMessage.body || '' }),
                    UI.el('button', {
                        class: 'composer-context-cancel',
                        title: 'Cancel (Esc)',
                        onclick: cancelComposerContext,
                    }, '×'),
                ]));
            } else if (state.replyTarget) {
                const rt = state.replyTarget;
                const sender = state.users.get(rt.sender.id) || rt.sender;
                contextBar.appendChild(UI.el('div', { class: 'composer-context composer-context-reply' }, [
                    UI.el('span', { class: 'composer-context-label' }, [
                        UI.el('span', { text: '↩ Replying to ' }),
                        UI.el('strong', { text: UI.displayLabel(sender) }),
                    ]),
                    UI.el('span', { class: 'composer-context-body', text: rt.body || (rt.attachments ? '(attachment)' : '') }),
                    UI.el('button', {
                        class: 'composer-context-cancel',
                        title: 'Cancel reply (Esc)',
                        onclick: cancelComposerContext,
                    }, '×'),
                ]));
            }
        }

        function cancelComposerContext() {
            state.editingMessage = null;
            state.replyTarget = null;
            textArea.value = '';
            repaintContext();
            repaintSendLabel();
        }

        // Exposed via closure so startReply / startEdit at the module
        // level can ask the active composer to repaint and focus.
        currentComposer = {
            focus: function (newBody) {
                if (typeof newBody === 'string') textArea.value = newBody;
                textArea.focus();
                // Move caret to end.
                const v = textArea.value;
                textArea.value = '';
                textArea.value = v;
                repaintContext();
                repaintSendLabel();
            },
        };

        function repaintSendLabel() {
            const btn = sendButton;
            if (!btn) return;
            btn.textContent = state.editingMessage ? 'Save' : 'Send';
        }

        function repaintPending() {
            pendingBar.innerHTML = '';
            pending.forEach(function (att, idx) {
                const node = UI.el('span', { class: 'composer-chip' }, [
                    UI.el('span', { text: '📎 ' + att.filename }),
                    UI.el('button', {
                        class: 'composer-chip-x',
                        title: 'Remove',
                        onclick: function () { pending.splice(idx, 1); repaintPending(); },
                    }, '×'),
                ]);
                pendingBar.appendChild(node);
            });
        }

        async function submit() {
            // Expand slash commands before send. /dice /coin etc.
            let body = H.expandSlashCommand(textArea.value.trim());

            // /help short-circuits: pop the local cheat-sheet modal
            // instead of sending the literal sentinel to the conv.
            if (body === H.HELP_SENTINEL) {
                textArea.value = '';
                openSlashHelpModal();
                return;
            }

            // Editing: send WS edit, NOT a new message.
            if (state.editingMessage) {
                if (body.length === 0) {
                    alert('An edited message cannot be empty. Delete it instead.');
                    return;
                }
                state.ws.sendEdit(state.editingMessage.id, body);
                state.editingMessage = null;
                textArea.value = '';
                repaintContext();
                repaintSendLabel();
                return;
            }

            if (body.length === 0 && pending.length === 0) return;
            const ids = pending.map(function (a) { return a.id; });
            const replyToID = state.replyTarget ? state.replyTarget.id : 0;
            state.ws.sendMessage(conv.id, body, ids, replyToID);
            textArea.value = '';
            pending.length = 0;
            state.replyTarget = null;
            repaintPending();
            repaintContext();
        }

        async function handleFiles(files) {
            for (let i = 0; i < files.length; i++) {
                try {
                    const att = await API.uploadFile(files[i], conv.id);
                    pending.push(att);
                    repaintPending();
                } catch (e) {
                    alert('Upload failed: ' + e.message);
                }
            }
        }

        const fileInput = UI.el('input', {
            type: 'file',
            multiple: true,
            style: 'display:none',
            onchange: function (ev) {
                handleFiles(ev.target.files || []);
                ev.target.value = '';
            },
        });

        const sendButton = UI.el('button', {
            class: 'composer-send',
            onclick: submit,
            text: 'Send',
        });

        const buttons = UI.el('div', { class: 'composer-buttons' }, [
            UI.el('button', {
                class: 'composer-icon-btn',
                title: 'Attach file',
                onclick: function () { fileInput.click(); },
            }, '📎'),
            UI.el('button', {
                class: 'composer-icon-btn',
                title: 'Emoji',
                onclick: function (ev) {
                    openEmojiPicker(function (e) {
                        const start = textArea.selectionStart || textArea.value.length;
                        const end = textArea.selectionEnd || textArea.value.length;
                        textArea.value = textArea.value.slice(0, start) + e + textArea.value.slice(end);
                        textArea.focus();
                        textArea.selectionStart = textArea.selectionEnd = start + e.length;
                    }, ev.currentTarget);
                },
            }, '😀'),
            UI.el('button', {
                class: 'composer-icon-btn',
                title: 'Nudge',
                onclick: function () {
                    if (state.ws.sendNudge(conv.id)) {
                        // Local feedback so you see something happen on
                        // your side even though the server only forwards.
                        flashChat();
                    }
                },
            }, '👋'),
            UI.el('div', { class: 'composer-spacer' }),
            sendButton,
        ]);

        // Initial paint of context (no-op if neither editing nor replying).
        repaintContext();

        const wrap = UI.el('div', { class: 'composer', ondragover: function (ev) {
            ev.preventDefault();
            wrap.classList.add('dragover');
        }, ondragleave: function () { wrap.classList.remove('dragover'); },
           ondrop: function (ev) {
            ev.preventDefault();
            wrap.classList.remove('dragover');
            const files = ev.dataTransfer && ev.dataTransfer.files;
            if (files && files.length) handleFiles(files);
        }}, [contextBar, pendingBar, textArea, buttons, fileInput]);

        return wrap;
    }

    // Module-level handle to the currently-rendered composer so that
    // startReply / startEdit can poke the input.
    let currentComposer = null;

    function startReply(m) {
        state.editingMessage = null;
        state.replyTarget = m;
        if (currentComposer) currentComposer.focus('');
    }
    function startEdit(m) {
        state.replyTarget = null;
        state.editingMessage = m;
        if (currentComposer) currentComposer.focus(m.body || '');
    }

    function handlePaste(ev, pending, pendingBar) {
        const items = ev.clipboardData && ev.clipboardData.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
                const file = items[i].getAsFile();
                if (!file) continue;
                ev.preventDefault();
                const named = new File([file], file.name || ('pasted-' + Date.now() + '.png'), { type: file.type });
                API.uploadFile(named, state.currentConvID).then(function (att) {
                    pending.push(att);
                    pendingBar.innerHTML = '';
                    pending.forEach(function (a, idx) {
                        const node = UI.el('span', { class: 'composer-chip' }, [
                            UI.el('span', { text: '📎 ' + a.filename }),
                            UI.el('button', {
                                class: 'composer-chip-x',
                                onclick: function () { pending.splice(idx, 1); pendingBar.innerHTML = ''; },
                            }, '×'),
                        ]);
                        pendingBar.appendChild(node);
                    });
                }).catch(function (e) { alert('Paste upload failed: ' + e.message); });
            }
        }
    }

    function flashChat() {
        const main = document.getElementById('main');
        if (!main) return;
        main.classList.add('shake');
        setTimeout(function () { main.classList.remove('shake'); }, 700);
    }

    // ---- typing bar ------------------------------------------------

    function renderTypingBar(node, convID) {
        const typers = state.typers.get(convID);
        if (!node) return;
        node.innerHTML = '';
        if (!typers || typers.size === 0) return;
        const now = Date.now();
        const names = [];
        typers.forEach(function (expires, uid) {
            if (expires < now) return;
            const u = state.users.get(uid);
            if (u && uid !== state.me.id) names.push(UI.displayLabel(u));
        });
        if (names.length === 0) return;
        const verb = names.length === 1 ? 'is typing…' : 'are typing…';
        node.textContent = names.join(', ') + ' ' + verb;
    }

    setInterval(function () {
        // Expire typers.
        const now = Date.now();
        let changed = false;
        state.typers.forEach(function (m, convID) {
            m.forEach(function (expires, uid) { if (expires < now) { m.delete(uid); changed = true; } });
        });
        if (changed) {
            const node = document.getElementById('typing-bar');
            if (node) renderTypingBar(node, state.currentConvID);
        }
    }, 1000);

    // ---- emoji picker ----------------------------------------------

    function openEmojiPicker(onPick, anchor) {
        const baseCategories = [
            { name: 'Smileys', emojis: ['😀','😁','😂','🤣','😅','😊','😇','🙂','🙃','😉','😍','😘','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','🥱','😴','😌','😛','😜','😝','🤤'] },
            { name: 'Hands', emojis: ['👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👋','🙌','👏','🙏','💪','🤝','✊','👊'] },
            { name: 'Hearts', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💖','💗','💘','💝'] },
            { name: 'Things', emojis: ['🎉','🎊','🎁','🎂','🎈','🍕','🍔','🍟','☕','🍺','🍷','🍻','🍩','🍪','🎮','🎵'] },
            { name: 'Animals', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔'] },
            { name: 'Nature', emojis: ['🌳','🌲','🌴','🌵','🌷','🌸','🌹','🌻','🌼','☀️','⛅','🌧️','⛈️','🌈','⭐','🌙'] },
        ];
        // Prepend a Recent tab when there's history.
        const recent = H.loadRecentEmoji();
        const categories = recent.length > 0
            ? [{ name: '🕒 Recent', emojis: recent }].concat(baseCategories)
            : baseCategories;

        document.querySelectorAll('.emoji-picker').forEach(function (n) { n.remove(); });

        const tabs = UI.el('div', { class: 'emoji-tabs' });
        const grid = UI.el('div', { class: 'emoji-grid' });
        let current = 0;
        function setCategory(i) {
            current = i;
            Array.from(tabs.children).forEach(function (t, idx) {
                t.classList.toggle('active', idx === i);
            });
            grid.innerHTML = '';
            categories[i].emojis.forEach(function (e) {
                grid.appendChild(UI.el('button', {
                    class: 'emoji-cell',
                    onclick: function () {
                        H.pushRecentEmoji(e);
                        onPick(e);
                        picker.remove();
                    },
                }, e));
            });
        }
        categories.forEach(function (c, i) {
            tabs.appendChild(UI.el('button', {
                class: 'emoji-tab',
                onclick: function () { setCategory(i); },
            }, c.name));
        });

        const picker = UI.el('div', { class: 'emoji-picker' }, [tabs, grid]);
        document.body.appendChild(picker);
        setCategory(0);

        // Anchor: position near the anchor's bounding box; otherwise
        // centre on screen.
        if (anchor && anchor.getBoundingClientRect) {
            const r = anchor.getBoundingClientRect();
            picker.style.left = Math.min(window.innerWidth - 280, r.left) + 'px';
            picker.style.top = Math.max(8, r.top - 240) + 'px';
        } else {
            picker.style.left = (window.innerWidth / 2 - 140) + 'px';
            picker.style.top = (window.innerHeight / 2 - 120) + 'px';
        }

        // Close when clicking outside.
        setTimeout(function () {
            document.addEventListener('click', closeOnOutside, true);
        }, 0);
        function closeOnOutside(ev) {
            if (!picker.contains(ev.target)) {
                picker.remove();
                document.removeEventListener('click', closeOnOutside, true);
            }
        }
    }

    // ---- image lightbox --------------------------------------------

    function openLightbox(url) {
        const box = UI.el('div', { class: 'lightbox', onclick: function () { box.remove(); } }, [
            UI.el('img', { src: url, alt: '' }),
        ]);
        document.body.appendChild(box);
        function escClose(ev) { if (ev.key === 'Escape') { box.remove(); document.removeEventListener('keydown', escClose); } }
        document.addEventListener('keydown', escClose);
    }

    // ---- theme system ----------------------------------------------

    const THEMES = [
        { name: 'aurora',   label: 'Aurora',   tagline: 'Modern dark — deep navy with a violet accent' },
        { name: 'daylight', label: 'Daylight', tagline: 'Modern light — clean off-white with sky-blue' },
        { name: 'classic',  label: 'Classic',  tagline: 'MSN throwback — bevels and blue gradients' },
    ];
    const DEFAULT_THEME = 'aurora';
    const THEME_KEY = 'oreohouse-theme';

    function loadTheme() {
        try {
            const raw = localStorage.getItem(THEME_KEY);
            if (raw === 'aurora' || raw === 'daylight' || raw === 'classic') return raw;
        } catch (_) { /* private mode etc */ }
        return DEFAULT_THEME;
    }
    function saveTheme(name) {
        try { localStorage.setItem(THEME_KEY, name); } catch (_) {}
    }
    function applyTheme(name) {
        document.documentElement.setAttribute('data-theme', name);
    }

    // Apply on boot so the first paint is right.
    applyTheme(loadTheme());

    // ---- profile modal ---------------------------------------------

    function openProfileModal() {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const me = state.users.get(state.me.id) || state.me;
        const currentTheme = loadTheme();

        // Avatar preview at the top. Re-rendered after upload/remove.
        const avatarWrap = UI.el('div', { class: 'profile-avatar-preview' });
        function repaintAvatar(user) {
            avatarWrap.innerHTML = '';
            avatarWrap.appendChild(UI.avatar(user, 80));
        }
        repaintAvatar(me);

        const displayInput = UI.el('input', {
            type: 'text',
            value: me.display_name || '',
            placeholder: me.username,
        });

        const avatarUpload = UI.el('input', {
            type: 'file',
            accept: 'image/*',
            style: 'display:none;',
            onchange: async function (ev) {
                const file = ev.target.files && ev.target.files[0];
                if (!file) return;
                try {
                    const updated = await API.uploadAvatar(file);
                    state.users.set(updated.id, updated);
                    if (state.me.id === updated.id) state.me = updated;
                    repaintAvatar(updated);
                } catch (e) {
                    alert('Upload failed: ' + e.message);
                }
                ev.target.value = '';
            },
        });

        async function removeAvatar() {
            try {
                const updated = await API.deleteAvatar();
                state.users.set(updated.id, updated);
                if (state.me.id === updated.id) state.me = updated;
                repaintAvatar(updated);
            } catch (e) {
                alert('Remove failed: ' + e.message);
            }
        }

        async function save() {
            try {
                await API.setProfile(displayInput.value.trim());
                backdrop.remove();
            } catch (e) {
                alert('Save failed: ' + e.message);
            }
        }

        // Build the theme radio rows.
        const themeOptions = UI.el('div', { class: 'theme-options' });
        function rebuildThemeRows(selected) {
            themeOptions.innerHTML = '';
            THEMES.forEach(function (t) {
                const isActive = t.name === selected;
                const row = UI.el('label', {
                    class: 'theme-option' + (isActive ? ' theme-option-active' : ''),
                    onclick: function () {
                        applyTheme(t.name);
                        saveTheme(t.name);
                        rebuildThemeRows(t.name);
                    },
                }, [
                    UI.el('input', {
                        type: 'radio',
                        name: 'oreohouse-theme',
                        value: t.name,
                        checked: isActive,
                    }),
                    UI.el('span', { class: 'theme-swatch theme-swatch-' + t.name }),
                    UI.el('span', { class: 'theme-meta' }, [
                        UI.el('span', { class: 'theme-label', text: t.label }),
                        UI.el('span', { class: 'theme-tagline', text: t.tagline }),
                    ]),
                ]);
                themeOptions.appendChild(row);
            });
        }
        rebuildThemeRows(currentTheme);

        const card = UI.el('div', { class: 'modal' }, [
            UI.el('h2', { text: 'Your profile' }),
            UI.el('div', { class: 'profile-avatar-row' }, [
                avatarWrap,
                UI.el('div', { class: 'profile-avatar-actions' }, [
                    UI.el('button', {
                        onclick: function () { avatarUpload.click(); },
                        text: me.has_avatar ? 'Change avatar' : 'Upload avatar',
                    }),
                    me.has_avatar
                        ? UI.el('button', { class: 'danger', onclick: removeAvatar, text: 'Remove avatar' })
                        : null,
                    avatarUpload,
                ]),
            ]),
            UI.el('label', {}, [UI.el('span', { text: 'Display name' }), displayInput]),
            UI.el('fieldset', { class: 'theme-picker' }, [
                UI.el('legend', { text: 'Theme' }),
                themeOptions,
            ]),
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { onclick: function () { backdrop.remove(); }, text: 'Close' }),
                UI.el('button', { class: 'primary', onclick: save, text: 'Save' }),
            ]),
        ]);
        const backdrop = UI.el('div', {
            class: 'modal-backdrop',
            onclick: function (ev) { if (ev.target === backdrop) backdrop.remove(); },
        }, [card]);
        document.body.appendChild(backdrop);
    }

    // ---- search modal ----------------------------------------------

    function openSearchModal(scopeConvID) {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        // When scopeConvID is set (Ctrl+F), search only inside that
        // conversation and show its name in the placeholder.
        const scopedConv = scopeConvID ? state.conversations.get(scopeConvID) : null;
        const placeholder = scopedConv
            ? ('Search in "' + convDisplayName(scopedConv) + '"…')
            : 'Type at least one word…';

        const input = UI.el('input', {
            class: 'search-input',
            type: 'search',
            placeholder: placeholder,
            autocomplete: 'off',
            spellcheck: 'false',
        });
        const resultsList = UI.el('ul', { class: 'search-results' });
        const status = UI.el('p', { class: 'placeholder' });

        let timer = null;
        input.addEventListener('input', function () {
            const q = input.value.trim();
            window.clearTimeout(timer);
            resultsList.innerHTML = '';
            if (!q) { status.textContent = ''; return; }
            status.textContent = 'Searching…';
            timer = window.setTimeout(async function () {
                try {
                    const rows = scopeConvID
                        ? await API.searchInConversation(scopeConvID, q)
                        : await API.searchMessages(q);
                    renderResults(rows, q);
                } catch (e) {
                    status.textContent = 'Search failed: ' + e.message;
                }
            }, 250);
        });

        function renderResults(rows, q) {
            resultsList.innerHTML = '';
            if (rows.length === 0) {
                status.textContent = 'No matches.';
                return;
            }
            status.textContent = '';
            const needle = q.toLowerCase();
            rows.forEach(function (m) {
                const bodyHit = m.body && m.body.toLowerCase().indexOf(needle) !== -1;
                const fileHits = (m.attachments || []).filter(function (a) {
                    return a.filename.toLowerCase().indexOf(needle) !== -1;
                });
                const conv = state.conversations.get(m.conversation_id);
                const convLabel = conv ? convDisplayName(conv) : ('conv #' + m.conversation_id);
                const sender = state.users.get(m.sender.id) || m.sender;

                const node = UI.el('li', {}, [
                    UI.el('button', {
                        class: 'search-result',
                        onclick: function () {
                            openConversation(m.conversation_id);
                            backdrop.remove();
                        },
                    }, [
                        UI.el('div', { class: 'search-result-meta' }, [
                            UI.el('span', { class: 'search-result-conv', text: convLabel }),
                            UI.el('span', { text: UI.displayLabel(sender) }),
                            UI.el('span', { class: 'search-result-time', text: UI.formatTime(m.created_at) }),
                        ]),
                        m.body ? UI.el('div', { class: 'search-result-body', text: m.body }) : null,
                        (!bodyHit && fileHits.length > 0)
                            ? UI.el('div', { class: 'search-result-files' }, [
                                UI.el('span', { text: '📎' }),
                                UI.el('span', { text: fileHits.map(function (a) { return a.filename; }).join(', ') }),
                            ])
                            : null,
                    ]),
                ]);
                resultsList.appendChild(node);
            });
        }

        const card = UI.el('div', { class: 'modal search-modal' }, [
            UI.el('h2', {}, [
                UI.el('span', { text: scopedConv ? 'Search in "' + convDisplayName(scopedConv) + '"' : 'Search messages' }),
                UI.el('button', {
                    class: 'search-modal-close',
                    onclick: function () { backdrop.remove(); },
                    text: '×',
                }),
            ]),
            UI.el('div', { class: 'search-modal-body' }, [
                input,
                status,
                resultsList,
            ]),
        ]);
        const backdrop = UI.el('div', {
            class: 'modal-backdrop',
            onclick: function (ev) { if (ev.target === backdrop) backdrop.remove(); },
        }, [card]);
        document.body.appendChild(backdrop);

        // Esc closes; focus the input.
        function escClose(ev) {
            if (ev.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', escClose); }
        }
        document.addEventListener('keydown', escClose);
        input.focus();
    }

    // Ctrl/Cmd+K opens search globally.
    document.addEventListener('keydown', function (ev) {
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
            ev.preventDefault();
            openSearchModal();
        }
    });

    // ---- media + links panel ---------------------------------------

    function openMediaPanel(convID) {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });

        let tab = 'media';
        const tabs = UI.el('div', { class: 'ml-tabs' });
        const body = UI.el('div', { class: 'ml-body' });

        function paintTabs() {
            tabs.innerHTML = '';
            tabs.appendChild(UI.el('button', {
                class: 'ml-tab' + (tab === 'media' ? ' ml-tab-active' : ''),
                onclick: function () { tab = 'media'; paintTabs(); loadActive(); },
                text: 'Media',
            }));
            tabs.appendChild(UI.el('button', {
                class: 'ml-tab' + (tab === 'links' ? ' ml-tab-active' : ''),
                onclick: function () { tab = 'links'; paintTabs(); loadActive(); },
                text: 'Links',
            }));
        }

        async function loadActive() {
            body.innerHTML = '';
            body.appendChild(UI.el('p', { class: 'placeholder', text: 'Loading…' }));
            try {
                if (tab === 'media') {
                    const items = await API.listConversationMedia(convID);
                    renderMedia(items);
                } else {
                    const items = await API.listConversationLinks(convID);
                    renderLinks(items);
                }
            } catch (e) {
                body.innerHTML = '';
                body.appendChild(UI.el('p', { class: 'placeholder', text: 'Failed to load: ' + e.message }));
            }
        }

        function isImage(mime) { return typeof mime === 'string' && mime.indexOf('image/') === 0; }
        function hostnameOf(url) {
            try { return new URL(url).hostname.replace(/^www\./, ''); }
            catch (_) { return url; }
        }

        function renderMedia(items) {
            body.innerHTML = '';
            if (items.length === 0) {
                body.appendChild(UI.el('p', { class: 'placeholder', text: 'No media shared in this conversation yet.' }));
                return;
            }
            const images = items.filter(function (i) { return isImage(i.attachment.mime_type); });
            const files = items.filter(function (i) { return !isImage(i.attachment.mime_type); });
            if (images.length > 0) {
                body.appendChild(UI.el('h3', { class: 'ml-section-title', text: 'Photos & videos' }));
                const grid = UI.el('div', { class: 'ml-image-grid' });
                images.forEach(function (it) {
                    const url = API.fileURL(it.attachment.id);
                    const tile = UI.el('a', {
                        class: 'ml-image-tile',
                        href: url,
                        target: '_blank',
                        rel: 'noopener noreferrer',
                        title: it.attachment.filename + ' — ' + UI.displayLabel(state.users.get(it.sender.id) || it.sender) + ' • ' + UI.formatTime(it.created_at),
                    }, [
                        UI.el('img', { src: url, alt: it.attachment.filename, loading: 'lazy' }),
                    ]);
                    grid.appendChild(tile);
                });
                body.appendChild(grid);
            }
            if (files.length > 0) {
                body.appendChild(UI.el('h3', { class: 'ml-section-title', text: 'Files' }));
                const list = UI.el('ul', { class: 'ml-file-list' });
                files.forEach(function (it) {
                    list.appendChild(UI.el('li', {}, [
                        UI.el('a', {
                            class: 'ml-file-row',
                            href: API.fileURL(it.attachment.id),
                            target: '_blank',
                            rel: 'noopener noreferrer',
                        }, [
                            UI.el('span', { class: 'ml-file-icon', text: '📎' }),
                            UI.el('span', { class: 'ml-file-meta' }, [
                                UI.el('span', { class: 'ml-file-name', text: it.attachment.filename }),
                                UI.el('span', { class: 'ml-file-sub', text: UI.displayLabel(state.users.get(it.sender.id) || it.sender) + ' • ' + UI.formatTime(it.created_at) }),
                            ]),
                        ]),
                    ]));
                });
                body.appendChild(list);
            }
        }

        function renderLinks(items) {
            body.innerHTML = '';
            if (items.length === 0) {
                body.appendChild(UI.el('p', { class: 'placeholder', text: 'No links shared in this conversation yet.' }));
                return;
            }
            const list = UI.el('ul', { class: 'ml-link-list' });
            items.forEach(function (l, i) {
                list.appendChild(UI.el('li', {}, [
                    UI.el('a', {
                        class: 'ml-link-row',
                        href: l.url,
                        target: '_blank',
                        rel: 'noopener noreferrer',
                        title: l.url,
                    }, [
                        UI.el('span', { class: 'ml-link-host', text: hostnameOf(l.url) }),
                        UI.el('span', { class: 'ml-link-url', text: l.url }),
                        UI.el('span', { class: 'ml-link-sub', text: UI.displayLabel(state.users.get(l.sender.id) || l.sender) + ' • ' + UI.formatTime(l.created_at) }),
                    ]),
                ]));
            });
            body.appendChild(list);
        }

        paintTabs();
        loadActive();

        const card = UI.el('div', { class: 'modal ml-modal' }, [
            UI.el('h2', {}, [
                UI.el('span', { text: 'Media & Links' }),
                UI.el('button', {
                    class: 'ml-modal-close',
                    onclick: function () { backdrop.remove(); },
                    text: '×',
                }),
            ]),
            tabs,
            body,
        ]);
        const backdrop = UI.el('div', {
            class: 'modal-backdrop',
            onclick: function (ev) { if (ev.target === backdrop) backdrop.remove(); },
        }, [card]);
        document.body.appendChild(backdrop);

        function escClose(ev) {
            if (ev.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', escClose); }
        }
        document.addEventListener('keydown', escClose);
    }

    // ---- reads / unread --------------------------------------------

    function markCurrentRead() {
        const convID = state.currentConvID;
        if (!convID) return;
        if (document.visibilityState !== 'visible') return;
        const msgs = state.messages.get(convID) || [];
        if (msgs.length === 0) return;
        const last = msgs[msgs.length - 1];
        const myReads = state.reads.get(convID) || new Map();
        if ((myReads.get(state.me.id) || 0) >= last.id) return;
        myReads.set(state.me.id, last.id);
        state.reads.set(convID, myReads);
        state.ws.sendRead(convID, last.id);
        state.unread.set(convID, 0);
        renderSidebar();
    }

    document.addEventListener('visibilitychange', markCurrentRead);
    window.addEventListener('focus', markCurrentRead);

    // ---- WS event wiring -------------------------------------------

    function connect() {
        const ws = new window.OreoWS();
        state.ws = ws;

        ws.on('welcome', function (msg) {
            (msg.online || []).forEach(function (p) {
                upsertUser(p.user);
                state.online.set(p.user.id, { state: p.state, custom_text: p.custom_text || '' });
            });
            (msg.reads || []).forEach(function (r) {
                let m = state.reads.get(r.conversation_id);
                if (!m) { m = new Map(); state.reads.set(r.conversation_id, m); }
                m.set(r.user_id, r.last_read_message_id);
            });
            // After welcome, render the sidebar with whatever conversations
            // we already loaded over REST.
            renderSidebar();
        });

        ws.on('presence', function (msg) {
            const wasOnline = state.online.has(msg.user.id);
            upsertUser(msg.user);
            if (msg.state === 'offline') {
                state.online.delete(msg.user.id);
            } else {
                state.online.set(msg.user.id, { state: msg.state, custom_text: msg.custom_text || '' });
            }
            // Sign-in / sign-out chime, but only AFTER the initial
            // burst on connect (3s gate) and never for self.
            const armed = Date.now() >= state.presenceArmedAt;
            if (armed && msg.user.id !== state.me.id) {
                const isOnline = msg.state !== 'offline';
                if (!wasOnline && isOnline) H.playSignIn();
                else if (wasOnline && !isOnline) H.playSignOut();
            }
            renderSidebar();
            if (state.currentConvID) {
                const conv = state.conversations.get(state.currentConvID);
                if (conv && conv.type === 'dm') {
                    const meta = document.querySelector('.chat-meta');
                    if (meta) meta.textContent = memberSummary(conv);
                }
            }
        });

        ws.on('message', function (m) {
            if (m.sender) upsertUser(m.sender);
            let bucket = state.messages.get(m.conversation_id);
            if (!bucket) { bucket = []; state.messages.set(m.conversation_id, bucket); }
            // Dedupe by id (replay-on-reconnect may resend).
            if (bucket.some(function (x) { return x.id === m.id; })) return;
            bucket.push(m);

            const convMuted = state.mutedConvs.has(m.conversation_id);

            if (m.conversation_id === state.currentConvID && document.visibilityState === 'visible') {
                const log = document.getElementById('message-log');
                if (log) {
                    const prev = bucket.length >= 2 ? bucket[bucket.length - 2] : null;
                    log.appendChild(messageRow(m, prev));
                    log.scrollTop = log.scrollHeight;
                }
                markCurrentRead();
            } else if (m.sender.id !== state.me.id) {
                if (!convMuted) {
                    state.unread.set(m.conversation_id, (state.unread.get(m.conversation_id) || 0) + 1);
                    H.playMessageBlip();
                    updateTitleBadge();
                    // Trigger an OS notification + ask permission the
                    // first time we'd want to. The Notifications API
                    // bails silently on browsers/permissions that
                    // don't support it.
                    maybeAskNotifications();
                    pushNotification(m);
                }
                renderSidebar();
            }
        });

        ws.on('message_edited', function (msg) {
            const bucket = state.messages.get(msg.conversation_id);
            if (!bucket) return;
            const m = bucket.find(function (x) { return x.id === msg.message_id; });
            if (!m) return;
            m.body = msg.body;
            m.edited_at = msg.edited_at;
            repaintMessage(msg.conversation_id, msg.message_id);
        });

        ws.on('message_deleted', function (msg) {
            const bucket = state.messages.get(msg.conversation_id);
            if (!bucket) return;
            const m = bucket.find(function (x) { return x.id === msg.message_id; });
            if (!m) return;
            m.deleted_at = msg.deleted_at;
            m.body = '';
            m.attachments = [];
            state.reactions.delete(msg.message_id);
            repaintMessage(msg.conversation_id, msg.message_id);
        });

        ws.on('message_pinned', function (msg) {
            let set = state.pinned.get(msg.conversation_id);
            if (!set) { set = new Set(); state.pinned.set(msg.conversation_id, set); }
            set.add(msg.message_id);
            repaintMessage(msg.conversation_id, msg.message_id);
        });

        ws.on('message_unpinned', function (msg) {
            const set = state.pinned.get(msg.conversation_id);
            if (set) set.delete(msg.message_id);
            repaintMessage(msg.conversation_id, msg.message_id);
        });

        ws.on('conversation_added', function (msg) {
            state.conversations.set(msg.conversation.id, msg.conversation);
            (msg.conversation.members || []).forEach(upsertUser);
            renderSidebar();
        });

        ws.on('conversation_members_changed', function (msg) {
            const conv = state.conversations.get(msg.conversation_id);
            if (!conv) return;
            conv.members = msg.members;
            msg.members.forEach(upsertUser);
            if (msg.conversation_id === state.currentConvID) renderMain();
            renderSidebar();
        });

        ws.on('typing', function (msg) {
            if (!msg.user || msg.user.id === state.me.id) return;
            let m = state.typers.get(msg.conversation_id);
            if (!m) { m = new Map(); state.typers.set(msg.conversation_id, m); }
            m.set(msg.user.id, Date.now() + 5000);
            if (msg.conversation_id === state.currentConvID) {
                const bar = document.getElementById('typing-bar');
                if (bar) renderTypingBar(bar, msg.conversation_id);
            }
        });

        ws.on('nudge', function (msg) {
            const convMuted = state.mutedConvs.has(msg.conversation_id);
            if (msg.conversation_id !== state.currentConvID) {
                if (!convMuted) {
                    state.unread.set(msg.conversation_id, (state.unread.get(msg.conversation_id) || 0) + 1);
                    renderSidebar();
                }
            } else {
                flashChat();
            }
            if (!convMuted) H.playNudge();
        });

        ws.on('read_receipt', function (msg) {
            let m = state.reads.get(msg.conversation_id);
            if (!m) { m = new Map(); state.reads.set(msg.conversation_id, m); }
            m.set(msg.user.id, msg.last_read_message_id);
            // Repaint my own messages up to the new high-water mark in
            // the active conv so tick marks update live.
            if (msg.conversation_id === state.currentConvID) {
                const bucket = state.messages.get(msg.conversation_id) || [];
                bucket.forEach(function (x) {
                    if (x.sender.id === state.me.id && x.id <= msg.last_read_message_id) {
                        repaintMessage(msg.conversation_id, x.id);
                    }
                });
            }
        });

        ws.on('user_profile_changed', function (msg) {
            upsertUser(msg.user);
        });

        ws.on('reaction', function (msg) {
            const groups = state.reactions.get(msg.message_id) || [];
            const idx = groups.findIndex(function (g) { return g.emoji === msg.emoji; });
            if (msg.action === 'add') {
                if (idx === -1) {
                    groups.push({ emoji: msg.emoji, user_ids: [msg.user.id] });
                } else if (groups[idx].user_ids.indexOf(msg.user.id) === -1) {
                    groups[idx].user_ids.push(msg.user.id);
                }
            } else {
                if (idx !== -1) {
                    groups[idx].user_ids = groups[idx].user_ids.filter(function (u) { return u !== msg.user.id; });
                    if (groups[idx].user_ids.length === 0) groups.splice(idx, 1);
                }
            }
            state.reactions.set(msg.message_id, groups);

            // Soft pop sound when SOMEONE ELSE reacts (action=add) to
            // one of MY messages and the conv isn't muted/focused.
            if (msg.action === 'add' && msg.user.id !== state.me.id) {
                const bucket = state.messages.get(msg.conversation_id) || [];
                const target = bucket.find(function (x) { return x.id === msg.message_id; });
                const convMuted = state.mutedConvs.has(msg.conversation_id);
                if (target && target.sender.id === state.me.id && !convMuted) {
                    if (msg.conversation_id !== state.currentConvID || document.visibilityState !== 'visible') {
                        H.playReactionPop();
                        state.unread.set(msg.conversation_id, (state.unread.get(msg.conversation_id) || 0) + 1);
                        updateTitleBadge();
                        renderSidebar();
                    }
                }
            }

            repaintMessage(msg.conversation_id, msg.message_id);
        });

        // Shared per-message repaint. Used by reaction, edit, delete,
        // pin/unpin, and read-receipt handlers.
        function repaintMessage(convID, messageID) {
            if (convID !== state.currentConvID) return;
            const row = document.querySelector('[data-message-id="' + messageID + '"]');
            if (!row) return;
            const bucket = state.messages.get(convID) || [];
            const m = bucket.find(function (x) { return x.id === messageID; });
            if (!m) return;
            const idx = bucket.indexOf(m);
            const prev = idx > 0 ? bucket[idx - 1] : null;
            row.replaceWith(messageRow(m, prev));
        }

        ws.on('error', function (msg) {
            console.warn('server error', msg);
        });

        ws.connect();
    }

    // ---- toggles & menus ------------------------------------------

    function toggleSoundsMuted() {
        state.soundsMuted = !state.soundsMuted;
        H.saveSoundsMuted(state.soundsMuted);
        const btn = document.getElementById('topbar-sound');
        if (btn) {
            btn.textContent = state.soundsMuted ? '🔇' : '🔊';
            btn.title = state.soundsMuted
                ? 'Sounds muted (click to unmute)'
                : 'Sounds on (click to mute)';
        }
    }

    function toggleConvMute(convID) {
        if (state.mutedConvs.has(convID)) state.mutedConvs.delete(convID);
        else state.mutedConvs.add(convID);
        H.saveMutedConvs(state.mutedConvs);
        if (convID === state.currentConvID) renderMain();
        renderSidebar();
    }

    function statusChip() {
        const cs = state.customStatus;
        return UI.el('button', {
            class: 'topbar-status status-' + cs.state,
            title: 'Click to change status',
            onclick: function (ev) { openStatusMenu(ev.currentTarget); },
        }, [
            UI.el('span', { class: 'status-dot status-dot-' + cs.state }),
            UI.el('span', { class: 'status-label', text: cs.state }),
            cs.custom_text
                ? UI.el('span', { class: 'status-custom', text: ' — ' + cs.custom_text })
                : null,
        ]);
    }

    function openStatusMenu(anchor) {
        document.querySelectorAll('.status-popover').forEach(function (n) { n.remove(); });
        const popover = UI.el('div', { class: 'status-popover' });
        const STATES = [
            { name: 'online', label: 'Online' },
            { name: 'away',   label: 'Away'   },
            { name: 'busy',   label: 'Busy'   },
        ];
        STATES.forEach(function (s) {
            popover.appendChild(UI.el('button', {
                class: 'status-option' + (state.customStatus.state === s.name ? ' status-option-active' : ''),
                onclick: function () {
                    state.customStatus.state = s.name;
                    state.ws.sendStatus(state.customStatus.state, state.customStatus.custom_text);
                    refreshStatusChip();
                    popover.remove();
                },
            }, [
                UI.el('span', { class: 'status-dot status-dot-' + s.name }),
                UI.el('span', { text: s.label }),
            ]));
        });
        const customInput = UI.el('input', {
            type: 'text',
            class: 'status-custom-input',
            placeholder: 'Custom message…',
            value: state.customStatus.custom_text,
            maxlength: '256',
        });
        const save = UI.el('button', {
            class: 'status-custom-save',
            onclick: function () {
                state.customStatus.custom_text = customInput.value.trim();
                state.ws.sendStatus(state.customStatus.state, state.customStatus.custom_text);
                refreshStatusChip();
                popover.remove();
            },
            text: 'Save',
        });
        popover.appendChild(UI.el('div', { class: 'status-custom-row' }, [customInput, save]));

        document.body.appendChild(popover);
        const r = anchor.getBoundingClientRect();
        popover.style.left = Math.max(8, r.left) + 'px';
        popover.style.top = (r.bottom + 4) + 'px';
        setTimeout(function () {
            document.addEventListener('click', function close(ev) {
                if (!popover.contains(ev.target) && ev.target !== anchor) {
                    popover.remove();
                    document.removeEventListener('click', close, true);
                }
            }, true);
        }, 0);
    }

    function refreshStatusChip() {
        // Just rebuild the topbar so the chip swaps in cleanly.
        renderShell();
        renderSidebar();
        if (state.currentConvID) renderMain();
    }

    // ---- unread surfaces (title, topbar badge, favicon) ------------

    function updateTitleBadge() {
        let total = 0;
        state.unread.forEach(function (n) { total += n; });
        document.title = (total > 0 ? '(' + total + ') ' : '') + 'OreoHouse';
        const badge = document.getElementById('topbar-unread');
        if (badge) {
            badge.textContent = total > 0 ? String(total) : '';
            badge.style.display = total > 0 ? '' : 'none';
        }
        updateFavicon(total);
    }

    // Canvas-generated favicon. Draws the cookie icon plus a small red
    // bubble with the count when total > 0. Cached as a base64 data
    // URL so we only repaint when the count actually changes.
    let _faviconBaseImg = null;
    let _lastFaviconCount = -1;
    function updateFavicon(total) {
        if (total === _lastFaviconCount) return;
        _lastFaviconCount = total;
        const draw = function (baseImg) {
            const c = document.createElement('canvas');
            c.width = 64; c.height = 64;
            const ctx = c.getContext('2d');
            if (baseImg) {
                ctx.drawImage(baseImg, 0, 0, 64, 64);
            } else {
                ctx.fillStyle = '#2c5dab';
                ctx.fillRect(0, 0, 64, 64);
            }
            if (total > 0) {
                ctx.beginPath();
                ctx.arc(46, 18, 18, 0, Math.PI * 2);
                ctx.fillStyle = '#dc2626';
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 22px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(total > 99 ? '99+' : String(total), 46, 19);
            }
            let link = document.querySelector('link[rel="icon"]');
            if (!link) {
                link = document.createElement('link');
                link.rel = 'icon';
                document.head.appendChild(link);
            }
            link.href = c.toDataURL('image/png');
        };
        if (_faviconBaseImg) { draw(_faviconBaseImg); return; }
        const img = new Image();
        img.onload = function () { _faviconBaseImg = img; draw(img); };
        img.onerror = function () { draw(null); };
        img.src = '/assets/img/icon.png';
    }

    setInterval(updateTitleBadge, 1000);

    // ---- Browser Notifications API --------------------------------
    //
    // Asks permission on the first incoming message we'd want to
    // notify about, then fires a desktop notification when a message
    // arrives in a non-focused tab (or a different conversation).
    // Click the notification → focus the tab + open the conv.

    let _notifPermissionAsked = false;
    function maybeAskNotifications() {
        if (_notifPermissionAsked) return;
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'default') return;
        _notifPermissionAsked = true;
        try { Notification.requestPermission(); } catch (_) { /* ignore */ }
    }
    function pushNotification(m) {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;
        if (document.visibilityState === 'visible' && m.conversation_id === state.currentConvID) return;
        const sender = state.users.get(m.sender.id) || m.sender;
        const conv = state.conversations.get(m.conversation_id);
        const title = UI.displayLabel(sender) + (conv && conv.type !== 'dm' ? ' in ' + convDisplayName(conv) : '');
        const body = m.body
            ? (m.body.length > 140 ? m.body.slice(0, 139) + '…' : m.body)
            : ((m.attachments && m.attachments.length > 0) ? '📎 ' + m.attachments[0].filename : '');
        try {
            const n = new Notification(title, {
                body: body,
                icon: '/assets/img/icon.png',
                tag: 'oreo-conv-' + m.conversation_id,
            });
            n.onclick = function () {
                window.focus();
                openConversation(m.conversation_id);
                n.close();
            };
        } catch (_) { /* iOS Safari etc */ }
    }

    // ---- Settings menu (⚙️ dropdown) ------------------------------

    function openSettingsMenu(anchor) {
        document.querySelectorAll('.settings-menu').forEach(function (n) { n.remove(); });
        const menu = UI.el('div', { class: 'settings-menu' });
        function item(label, onclick) {
            return UI.el('button', {
                class: 'settings-menu-item',
                onclick: function () { menu.remove(); onclick(); },
            }, label);
        }
        menu.appendChild(item('⚙️ Preferences', openPreferencesModal));
        menu.appendChild(item('ℹ️ About OreoHouse', openAboutModal));
        menu.appendChild(item('⌨️ Keyboard shortcuts', openShortcutsModal));
        menu.appendChild(item('💡 Slash commands', openSlashHelpModal));
        menu.appendChild(item('🔄 Check for updates', openUpdateModal));
        const repoUrl = (window.OREO && window.OREO.repoUrl) || 'https://github.com/BiffstaGaming/OreoHouse';
        menu.appendChild(UI.el('a', {
            class: 'settings-menu-item',
            href: repoUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            onclick: function () { menu.remove(); },
        }, '🐙 View on GitHub'));
        menu.appendChild(UI.el('div', { class: 'settings-menu-sep' }));
        menu.appendChild(UI.el('a', {
            class: 'settings-menu-item settings-menu-danger',
            href: '/logout.php',
        }, '🚪 Sign out'));

        document.body.appendChild(menu);
        const r = anchor.getBoundingClientRect();
        menu.style.right = (window.innerWidth - r.right) + 'px';
        menu.style.top = (r.bottom + 4) + 'px';
        setTimeout(function () {
            document.addEventListener('click', function close(ev) {
                if (!menu.contains(ev.target) && ev.target !== anchor) {
                    menu.remove();
                    document.removeEventListener('click', close, true);
                }
            }, true);
        }, 0);
    }

    function openAboutModal() {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const version = (window.OREO && window.OREO.version) || 'dev';
        const repoUrl = (window.OREO && window.OREO.repoUrl) || 'https://github.com/BiffstaGaming/OreoHouse';
        const card = UI.el('div', { class: 'modal about-modal' }, [
            UI.el('img', { class: 'about-logo', src: '/assets/img/logo.png', alt: 'OreoHouse' }),
            UI.el('h2', { text: 'OreoHouse' }),
            UI.el('p', { class: 'about-version', text: 'Web client — version ' + version }),
            UI.el('p', { class: 'about-blurb', text: 'Self-hosted family LAN messenger. Same accounts and conversations as the desktop app, just without the install.' }),
            UI.el('div', { class: 'about-links' }, [
                UI.el('a', { href: repoUrl, target: '_blank', rel: 'noopener noreferrer', text: 'GitHub' }),
                UI.el('a', { href: repoUrl + '/releases', target: '_blank', rel: 'noopener noreferrer', text: 'Release notes' }),
                UI.el('a', { href: repoUrl + '/issues', target: '_blank', rel: 'noopener noreferrer', text: 'Report a bug' }),
            ]),
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { class: 'primary', onclick: function () { backdrop.remove(); }, text: 'Close' }),
            ]),
        ]);
        const backdrop = makeBackdrop(card);
    }

    function openShortcutsModal() {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const isMac = /Mac|iPad|iPhone/i.test(navigator.platform);
        const cmd = isMac ? '⌘' : 'Ctrl';
        const rows = [
            [cmd + ' + K',     'Open search'],
            ['Enter',          'Send message'],
            ['Shift + Enter',  'Insert newline in composer'],
            ['Esc',            'Cancel reply / edit / close modal'],
            ['Click avatar',   'Open your profile + theme picker'],
            ['Click 📌',        'View pinned messages in this conversation'],
            ['Click 🖼️',        'View media + links in this conversation'],
            ['Click 🔔 / 🔕',   'Toggle this conversation\'s mute'],
            ['Click 🔊 / 🔇',   'Toggle all sounds'],
        ];
        const list = UI.el('table', { class: 'shortcuts-table' });
        rows.forEach(function (r) {
            list.appendChild(UI.el('tr', {}, [
                UI.el('td', { class: 'shortcut-key' }, [UI.el('kbd', { text: r[0] })]),
                UI.el('td', { class: 'shortcut-desc', text: r[1] }),
            ]));
        });
        const card = UI.el('div', { class: 'modal shortcuts-modal' }, [
            UI.el('h2', { text: 'Keyboard shortcuts' }),
            list,
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { class: 'primary', onclick: function () { backdrop.remove(); }, text: 'Close' }),
            ]),
        ]);
        const backdrop = makeBackdrop(card);
    }

    function openUpdateModal() {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const version = (window.OREO && window.OREO.version) || 'dev';
        const card = UI.el('div', { class: 'modal' }, [
            UI.el('h2', { text: 'Check for updates' }),
            UI.el('p', { text: 'Currently running version ' + version + '.' }),
            UI.el('p', { text: 'The web client always fetches the latest code on refresh — your admin pushes an update by pulling the new Docker image. Click Reload to get the latest now.' }),
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { onclick: function () { backdrop.remove(); }, text: 'Close' }),
                UI.el('button', { class: 'primary', onclick: function () { window.location.reload(); }, text: 'Reload' }),
            ]),
        ]);
        const backdrop = makeBackdrop(card);
    }

    // ---- conversation creation + management modals -----------------

    function openNewGroupModal() {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const nameInput = UI.el('input', { type: 'text', placeholder: 'Group name (optional)' });
        const memberPicker = renderMemberPicker(new Set([state.me.id]));
        async function create() {
            const ids = memberPicker.selectedIDs().filter(function (id) { return id !== state.me.id; });
            if (ids.length === 0) { alert('Pick at least one other member.'); return; }
            try {
                const conv = await API.createGroup(nameInput.value.trim(), ids);
                state.conversations.set(conv.id, conv);
                (conv.members || []).forEach(upsertUser);
                renderSidebar();
                openConversation(conv.id);
                backdrop.remove();
            } catch (e) { alert('Create failed: ' + e.message); }
        }
        const card = UI.el('div', { class: 'modal' }, [
            UI.el('h2', { text: 'New group chat' }),
            UI.el('label', {}, [UI.el('span', { text: 'Name' }), nameInput]),
            UI.el('label', {}, [UI.el('span', { text: 'Members' }), memberPicker.el]),
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { onclick: function () { backdrop.remove(); }, text: 'Cancel' }),
                UI.el('button', { class: 'primary', onclick: create, text: 'Create' }),
            ]),
        ]);
        const backdrop = makeBackdrop(card);
    }

    function openNewRoomModal() {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const nameInput = UI.el('input', { type: 'text', placeholder: 'Room name (required)', required: true });
        const topicInput = UI.el('input', { type: 'text', placeholder: 'Topic (optional)' });
        async function create() {
            const name = nameInput.value.trim();
            if (!name) { alert('Room name is required.'); return; }
            try {
                const conv = await API.createRoom(name, topicInput.value.trim());
                state.conversations.set(conv.id, conv);
                (conv.members || []).forEach(upsertUser);
                renderSidebar();
                openConversation(conv.id);
                backdrop.remove();
            } catch (e) { alert('Create failed: ' + e.message); }
        }
        const card = UI.el('div', { class: 'modal' }, [
            UI.el('h2', { text: 'New room' }),
            UI.el('label', {}, [UI.el('span', { text: 'Name' }), nameInput]),
            UI.el('label', {}, [UI.el('span', { text: 'Topic' }), topicInput]),
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { onclick: function () { backdrop.remove(); }, text: 'Cancel' }),
                UI.el('button', { class: 'primary', onclick: create, text: 'Create' }),
            ]),
        ]);
        const backdrop = makeBackdrop(card);
    }

    async function openBrowseRoomsModal() {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const list = UI.el('ul', { class: 'rooms-list' });
        const card = UI.el('div', { class: 'modal' }, [
            UI.el('h2', { text: 'Browse rooms' }),
            UI.el('p', { class: 'placeholder', text: 'Loading…' }),
            list,
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { onclick: function () { backdrop.remove(); }, text: 'Close' }),
            ]),
        ]);
        const backdrop = makeBackdrop(card);
        try {
            const rooms = await API.listRooms();
            list.innerHTML = '';
            const placeholder = card.querySelector('.placeholder');
            if (placeholder) placeholder.remove();
            if (rooms.length === 0) {
                card.insertBefore(UI.el('p', { class: 'placeholder', text: 'No rooms yet — create one with + Room.' }), list);
                return;
            }
            rooms.forEach(function (r) {
                const already = state.conversations.has(r.id);
                list.appendChild(UI.el('li', {}, [
                    UI.el('div', { class: 'room-row' }, [
                        UI.el('div', { class: 'room-meta' }, [
                            UI.el('div', { class: 'room-name', text: r.name }),
                            r.topic ? UI.el('div', { class: 'room-topic', text: r.topic }) : null,
                            UI.el('div', { class: 'room-sub', text: r.member_count + ' member' + (r.member_count === 1 ? '' : 's') }),
                        ]),
                        UI.el('button', {
                            class: 'primary',
                            disabled: already,
                            onclick: async function () {
                                try {
                                    const conv = await API.joinRoom(r.id);
                                    state.conversations.set(conv.id, conv);
                                    (conv.members || []).forEach(upsertUser);
                                    renderSidebar();
                                    openConversation(conv.id);
                                    backdrop.remove();
                                } catch (e) { alert('Join failed: ' + e.message); }
                            },
                            text: already ? 'Joined' : 'Join',
                        }),
                    ]),
                ]));
            });
        } catch (e) {
            list.innerHTML = '';
            card.appendChild(UI.el('p', { class: 'placeholder', text: 'Failed to load rooms: ' + e.message }));
        }
    }

    function openAddMembersModal(convID) {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const conv = state.conversations.get(convID);
        if (!conv) return;
        const already = new Set(conv.members.map(function (m) { return m.id; }));
        const picker = renderMemberPicker(already, /*hideAlreadyIn=*/true);
        async function add() {
            const ids = picker.selectedIDs().filter(function (id) { return !already.has(id); });
            if (ids.length === 0) { alert('Pick at least one user.'); return; }
            try {
                await API.addMembers(convID, ids);
                backdrop.remove();
            } catch (e) { alert('Add failed: ' + e.message); }
        }
        const card = UI.el('div', { class: 'modal' }, [
            UI.el('h2', { text: 'Add members' }),
            picker.el,
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { onclick: function () { backdrop.remove(); }, text: 'Cancel' }),
                UI.el('button', { class: 'primary', onclick: add, text: 'Add' }),
            ]),
        ]);
        const backdrop = makeBackdrop(card);
    }

    async function openPinsModal(convID) {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const body = UI.el('div', { class: 'pin-list' });
        const card = UI.el('div', { class: 'modal' }, [
            UI.el('h2', { text: 'Pinned messages' }),
            body,
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { onclick: function () { backdrop.remove(); }, text: 'Close' }),
            ]),
        ]);
        const backdrop = makeBackdrop(card);
        body.appendChild(UI.el('p', { class: 'placeholder', text: 'Loading…' }));
        try {
            const pins = await API.listPins(convID);
            body.innerHTML = '';
            if (pins.length === 0) {
                body.appendChild(UI.el('p', { class: 'placeholder', text: 'No pinned messages in this conversation yet.' }));
                return;
            }
            // Sync our in-memory pinned set with what the server says.
            let set = state.pinned.get(convID);
            if (!set) { set = new Set(); state.pinned.set(convID, set); }
            pins.forEach(function (p) { set.add(p.message.id); });

            pins.forEach(function (p) {
                const sender = state.users.get(p.message.sender.id) || p.message.sender;
                const pinner = state.users.get(p.pinned_by.id) || p.pinned_by;
                body.appendChild(UI.el('div', { class: 'pin-row' }, [
                    UI.el('div', { class: 'pin-meta' }, [
                        UI.el('span', { class: 'pin-sender', text: UI.displayLabel(sender) }),
                        UI.el('span', { class: 'pin-time', text: UI.formatTime(p.message.created_at) }),
                    ]),
                    UI.el('div', { class: 'pin-body', text: p.message.body || '(attachment only)' }),
                    UI.el('div', { class: 'pin-footer', text: '📌 by ' + UI.displayLabel(pinner) + ' • ' + UI.formatTime(p.pinned_at) }),
                ]));
            });
        } catch (e) {
            body.innerHTML = '';
            body.appendChild(UI.el('p', { class: 'placeholder', text: 'Failed to load pins: ' + e.message }));
        }
    }

    async function leaveCurrentConversation(convID) {
        try {
            await API.leaveConversation(convID);
            state.conversations.delete(convID);
            state.messages.delete(convID);
            if (state.currentConvID === convID) state.currentConvID = null;
            renderSidebar();
            renderMain();
        } catch (e) { alert('Leave failed: ' + e.message); }
    }

    function makeBackdrop(card) {
        const backdrop = UI.el('div', {
            class: 'modal-backdrop',
            onclick: function (ev) { if (ev.target === backdrop) backdrop.remove(); },
        }, [card]);
        document.body.appendChild(backdrop);
        function esc(ev) { if (ev.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', esc); } }
        document.addEventListener('keydown', esc);
        return backdrop;
    }

    // Multi-user picker that returns { el, selectedIDs() }. Used by
    // both the new-group and add-members modals.
    function renderMemberPicker(preselected, hideAlreadyIn) {
        const selected = new Set(preselected || []);
        const wrap = UI.el('div', { class: 'member-picker' });
        function repaint() {
            wrap.innerHTML = '';
            const all = Array.from(state.users.values())
                .filter(function (u) { return u.id !== state.me.id; })
                .filter(function (u) { return !hideAlreadyIn || !preselected.has(u.id); })
                .sort(function (a, b) { return UI.displayLabel(a).localeCompare(UI.displayLabel(b)); });
            if (all.length === 0) {
                wrap.appendChild(UI.el('p', { class: 'placeholder', text: 'No other users known yet.' }));
                return;
            }
            all.forEach(function (u) {
                const checked = selected.has(u.id);
                wrap.appendChild(UI.el('label', { class: 'member-picker-row' + (checked ? ' member-picker-row-checked' : '') }, [
                    UI.el('input', {
                        type: 'checkbox',
                        checked: checked,
                        onchange: function (ev) {
                            if (ev.target.checked) selected.add(u.id);
                            else selected.delete(u.id);
                            repaint();
                        },
                    }),
                    UI.el('span', { class: 'member-picker-name', text: UI.displayLabel(u) }),
                ]));
            });
        }
        repaint();
        return {
            el: wrap,
            selectedIDs: function () { return Array.from(selected); },
        };
    }

    // ---- scroll-to-load-older history ------------------------------

    async function loadOlderMessages(convID) {
        if (state.historyLoading.has(convID)) return;
        if (state.historyLoaded.get(convID)) return;
        const bucket = state.messages.get(convID) || [];
        if (bucket.length === 0) return;
        const oldestID = bucket[0].id;
        state.historyLoading.add(convID);
        try {
            const resp = await API.listMessages(convID, oldestID, 50);
            const ordered = (resp.messages || []).slice().reverse();
            if (ordered.length === 0) {
                state.historyLoaded.set(convID, true);
                return;
            }
            ordered.forEach(function (m) {
                if (m.sender) upsertUser(m.sender);
                if (m.reactions) state.reactions.set(m.id, m.reactions);
            });
            // Prepend to the existing bucket, preserving order.
            const merged = ordered.concat(bucket);
            state.messages.set(convID, merged);
            if (convID === state.currentConvID) {
                const log = document.getElementById('message-log');
                if (log) {
                    const previousScrollHeight = log.scrollHeight;
                    // Rebuild the log; scroll-preserve by anchoring to the
                    // delta in scrollHeight after re-render.
                    log.innerHTML = '';
                    renderMessages(log, convID);
                    log.scrollTop = log.scrollHeight - previousScrollHeight;
                }
            }
        } catch (e) {
            console.warn('load older failed', e);
        } finally {
            state.historyLoading.delete(convID);
        }
    }

    // ---- /help cheat-sheet modal -----------------------------------

    function openSlashHelpModal() {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const rows = (H.SLASH_HELP_ROWS || []);
        const list = UI.el('table', { class: 'shortcuts-table' });
        rows.forEach(function (r) {
            const keys = r.slice(0, r.length - 1).join(' / ');
            list.appendChild(UI.el('tr', {}, [
                UI.el('td', { class: 'shortcut-key' }, [UI.el('kbd', { text: keys })]),
                UI.el('td', { class: 'shortcut-desc', text: r[r.length - 1] }),
            ]));
        });
        const card = UI.el('div', { class: 'modal shortcuts-modal' }, [
            UI.el('h2', { text: 'Slash commands' }),
            UI.el('p', { class: 'about-blurb', text: 'Type one of these in the composer. /me, /shrug, /tableflip, /unflip, /dice, /coin, /8ball, /time all expand to text. /help shows this list and is never sent.' }),
            list,
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { class: 'primary', onclick: function () { backdrop.remove(); }, text: 'Close' }),
            ]),
        ]);
        const backdrop = makeBackdrop(card);
    }

    // ---- Preferences modal -----------------------------------------
    //
    // Pulls theme picking out of the Profile modal and adds master sound
    // + notification controls so all per-machine UX prefs live in one
    // place. Profile stays just display-name + avatar.

    function openPreferencesModal() {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });

        const currentTheme = loadTheme();

        // Theme picker (same shape as in the old profile modal).
        const themeOptions = UI.el('div', { class: 'theme-options' });
        function rebuildThemeRows(selected) {
            themeOptions.innerHTML = '';
            THEMES.forEach(function (t) {
                const isActive = t.name === selected;
                themeOptions.appendChild(UI.el('label', {
                    class: 'theme-option' + (isActive ? ' theme-option-active' : ''),
                    onclick: function () {
                        applyTheme(t.name);
                        saveTheme(t.name);
                        rebuildThemeRows(t.name);
                    },
                }, [
                    UI.el('input', { type: 'radio', name: 'oreohouse-theme', value: t.name, checked: isActive }),
                    UI.el('span', { class: 'theme-swatch theme-swatch-' + t.name }),
                    UI.el('span', { class: 'theme-meta' }, [
                        UI.el('span', { class: 'theme-label', text: t.label }),
                        UI.el('span', { class: 'theme-tagline', text: t.tagline }),
                    ]),
                ]));
            });
        }
        rebuildThemeRows(currentTheme);

        // Sound mute checkbox bound to state.soundsMuted.
        const soundsRow = UI.el('label', { class: 'prefs-toggle' }, [
            UI.el('input', {
                type: 'checkbox',
                checked: !state.soundsMuted,
                onchange: function (ev) {
                    state.soundsMuted = !ev.target.checked;
                    H.saveSoundsMuted(state.soundsMuted);
                    // Sync the topbar 🔊/🔇 button + title.
                    const btn = document.getElementById('topbar-sound');
                    if (btn) {
                        btn.textContent = state.soundsMuted ? '🔇' : '🔊';
                        btn.title = state.soundsMuted ? 'Sounds muted (click to unmute)' : 'Sounds on (click to mute)';
                    }
                },
            }),
            UI.el('span', {}, [
                UI.el('strong', { text: 'Sound effects' }),
                UI.el('br'),
                UI.el('span', { class: 'prefs-toggle-help', text: 'Message blips, nudges, sign-in chimes, reaction pops.' }),
            ]),
        ]);

        // Notification permission. Browsers gate this behind a user
        // gesture, so we trigger it from the button click.
        const notifLabel = ('Notification' in window)
            ? (Notification.permission === 'granted' ? 'Granted'
                : Notification.permission === 'denied' ? 'Blocked (change in browser settings)'
                : 'Not yet requested')
            : 'Not supported in this browser';
        const notifBtn = UI.el('button', {
            disabled: !('Notification' in window) || Notification.permission !== 'default',
            onclick: function () {
                if (!('Notification' in window)) return;
                Notification.requestPermission().then(function () { backdrop.remove(); openPreferencesModal(); });
            },
            text: ('Notification' in window) && Notification.permission === 'default' ? 'Enable' : 'OK',
        });
        const notifRow = UI.el('div', { class: 'prefs-toggle' }, [
            UI.el('span', {}, [
                UI.el('strong', { text: 'Desktop notifications' }),
                UI.el('br'),
                UI.el('span', { class: 'prefs-toggle-help', text: 'OS-level toast on incoming messages when the tab is unfocused. Status: ' + notifLabel + '.' }),
            ]),
            notifBtn,
        ]);

        const card = UI.el('div', { class: 'modal' }, [
            UI.el('h2', { text: 'Preferences' }),
            UI.el('fieldset', { class: 'theme-picker' }, [
                UI.el('legend', { text: 'Theme' }),
                themeOptions,
            ]),
            UI.el('fieldset', { class: 'theme-picker' }, [
                UI.el('legend', { text: 'Sounds & notifications' }),
                soundsRow,
                notifRow,
            ]),
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { class: 'primary', onclick: function () { backdrop.remove(); }, text: 'Close' }),
            ]),
        ]);
        const backdrop = makeBackdrop(card);
    }

    // ---- Conversation actions menu (3-dot in chat header) ----------

    function openConvActionsMenu(convID, anchor) {
        document.querySelectorAll('.settings-menu').forEach(function (n) { n.remove(); });
        const conv = state.conversations.get(convID);
        if (!conv) return;
        const menu = UI.el('div', { class: 'settings-menu' });
        function item(label, onclick) {
            return UI.el('button', { class: 'settings-menu-item', onclick: function () { menu.remove(); onclick(); } }, label);
        }
        if (conv.type !== 'dm') {
            menu.appendChild(item('✏️ Rename conversation', function () { openRenameModal(convID); }));
            menu.appendChild(item('💬 Change topic',         function () { openTopicModal(convID); }));
            menu.appendChild(item('👥 Manage members',       function () { openManageMembersModal(convID); }));
            menu.appendChild(UI.el('div', { class: 'settings-menu-sep' }));
        }
        menu.appendChild(item('💾 Export conversation', function () { exportConversation(convID); }));
        if (conv.type !== 'dm') {
            menu.appendChild(UI.el('div', { class: 'settings-menu-sep' }));
            menu.appendChild(UI.el('button', {
                class: 'settings-menu-item settings-menu-danger',
                onclick: function () {
                    menu.remove();
                    if (confirm('Leave ' + convDisplayName(conv) + '?')) leaveCurrentConversation(convID);
                },
            }, '🚪 Leave conversation'));
        }
        document.body.appendChild(menu);
        const r = anchor.getBoundingClientRect();
        menu.style.right = (window.innerWidth - r.right) + 'px';
        menu.style.top = (r.bottom + 4) + 'px';
        setTimeout(function () {
            document.addEventListener('click', function close(ev) {
                if (!menu.contains(ev.target) && ev.target !== anchor) {
                    menu.remove();
                    document.removeEventListener('click', close, true);
                }
            }, true);
        }, 0);
    }

    function openRenameModal(convID) {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const conv = state.conversations.get(convID);
        if (!conv) return;
        const input = UI.el('input', { type: 'text', value: conv.name || '', placeholder: 'Conversation name' });
        async function save() {
            try {
                const updated = await API.updateConversation(convID, { name: input.value.trim() });
                state.conversations.set(updated.id, updated);
                if (state.currentConvID === convID) renderMain();
                renderSidebar();
                backdrop.remove();
            } catch (e) { alert('Rename failed: ' + e.message); }
        }
        const card = UI.el('div', { class: 'modal' }, [
            UI.el('h2', { text: 'Rename conversation' }),
            UI.el('label', {}, [UI.el('span', { text: 'New name' }), input]),
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { onclick: function () { backdrop.remove(); }, text: 'Cancel' }),
                UI.el('button', { class: 'primary', onclick: save, text: 'Save' }),
            ]),
        ]);
        const backdrop = makeBackdrop(card);
        setTimeout(function () { input.focus(); input.select(); }, 0);
    }

    function openTopicModal(convID) {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const conv = state.conversations.get(convID);
        if (!conv) return;
        const input = UI.el('input', { type: 'text', value: conv.topic || '', placeholder: 'Topic (or leave empty to clear)' });
        async function save() {
            try {
                const updated = await API.updateConversation(convID, { topic: input.value.trim() });
                state.conversations.set(updated.id, updated);
                if (state.currentConvID === convID) renderMain();
                renderSidebar();
                backdrop.remove();
            } catch (e) { alert('Update failed: ' + e.message); }
        }
        const card = UI.el('div', { class: 'modal' }, [
            UI.el('h2', { text: 'Change topic' }),
            UI.el('label', {}, [UI.el('span', { text: 'Topic' }), input]),
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { onclick: function () { backdrop.remove(); }, text: 'Cancel' }),
                UI.el('button', { class: 'primary', onclick: save, text: 'Save' }),
            ]),
        ]);
        const backdrop = makeBackdrop(card);
        setTimeout(function () { input.focus(); }, 0);
    }

    function openManageMembersModal(convID) {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const conv = state.conversations.get(convID);
        if (!conv) return;
        const list = UI.el('ul', { class: 'manage-members-list' });
        conv.members.forEach(function (m) {
            const isMe = m.id === state.me.id;
            list.appendChild(UI.el('li', { class: 'manage-members-row' }, [
                UI.el('span', { class: 'manage-members-name', text: UI.displayLabel(m) + (isMe ? ' (you)' : '') }),
                isMe
                    ? null
                    : UI.el('button', {
                        class: 'danger',
                        onclick: async function () {
                            if (!confirm('Remove ' + UI.displayLabel(m) + ' from ' + convDisplayName(conv) + '?')) return;
                            try {
                                await API.kickMember(convID, m.id);
                                // Optimistic; conversation_members_changed will catch up.
                                backdrop.remove();
                            } catch (e) { alert('Remove failed: ' + e.message); }
                        },
                        text: 'Remove',
                    }),
            ]));
        });
        const card = UI.el('div', { class: 'modal' }, [
            UI.el('h2', { text: 'Members' }),
            list,
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { class: 'primary', onclick: function () { backdrop.remove(); }, text: 'Close' }),
            ]),
        ]);
        const backdrop = makeBackdrop(card);
    }

    // ---- Export conversation ---------------------------------------

    async function exportConversation(convID) {
        const conv = state.conversations.get(convID);
        if (!conv) return;
        // Fetch all messages by walking the same before-cursor used by
        // scroll-to-load-older.
        const all = [];
        let before = null;
        for (let page = 0; page < 200; page++) {
            try {
                const resp = await API.listMessages(convID, before, 100);
                const rows = resp.messages || [];
                if (rows.length === 0) break;
                all.push(...rows);
                before = rows[rows.length - 1].id;
                if (rows.length < 100) break;
            } catch (e) {
                alert('Export failed: ' + e.message);
                return;
            }
        }
        // Server returns newest-first; flip so the export reads top-to-bottom.
        all.reverse();

        // Build a plain-text + JSON export. Plain text is the friendly
        // download; JSON is for machine consumption.
        const label = convDisplayName(conv).replace(/[^\w\-]+/g, '_') || ('conv-' + convID);
        const now = new Date();
        const stamp = now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0');

        const lines = [];
        lines.push('# ' + convDisplayName(conv));
        if (conv.topic) lines.push('Topic: ' + conv.topic);
        lines.push('Exported: ' + now.toLocaleString());
        lines.push('Members: ' + conv.members.map(UI.displayLabel).join(', '));
        lines.push('');
        all.forEach(function (m) {
            const sender = state.users.get(m.sender.id) || m.sender;
            const ts = new Date(m.created_at);
            const head = '[' + ts.toLocaleString() + '] ' + UI.displayLabel(sender) + (m.edited_at ? ' (edited)' : '') + ':';
            if (m.deleted_at) {
                lines.push(head + ' (this message was deleted)');
            } else if (m.body) {
                lines.push(head + ' ' + m.body);
            }
            if (m.attachments && m.attachments.length > 0) {
                m.attachments.forEach(function (a) {
                    lines.push('    📎 ' + a.filename + ' (' + a.mime_type + ', ' + a.size_bytes + ' bytes)');
                });
            }
        });
        const txtBlob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        triggerDownload(txtBlob, 'oreohouse-' + label + '-' + stamp + '.txt');

        const jsonBlob = new Blob([JSON.stringify({
            conversation: conv,
            exported_at: now.toISOString(),
            messages: all,
        }, null, 2)], { type: 'application/json;charset=utf-8' });
        triggerDownload(jsonBlob, 'oreohouse-' + label + '-' + stamp + '.json');
    }

    function triggerDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    // ---- Ctrl/Cmd+F — search inside current conversation -----------

    document.addEventListener('keydown', function (ev) {
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f' && state.currentConvID) {
            ev.preventDefault();
            openSearchModal(state.currentConvID);
        }
    });

    // ---- boot ------------------------------------------------------

    async function boot() {
        renderShell();
        try {
            const list = await API.listConversations();
            (list.conversations || []).forEach(function (c) {
                state.conversations.set(c.id, c);
                (c.members || []).forEach(upsertUser);
            });
        } catch (e) {
            console.error('conversations load failed', e);
        }
        renderSidebar();
        connect();
    }

    boot();
})();
