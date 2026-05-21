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
        unread: new Map(),                 // convID -> count
        typers: new Map(),                 // convID -> Map<userID, expiresAt>
        currentConvID: null,
        ws: null,
    };

    state.users.set(state.me.id, state.me);

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
            UI.el('div', { class: 'topbar-brand' }, '🍪 OreoHouse'),
            UI.el('div', { class: 'topbar-spacer' }),
            UI.el('button', { class: 'topbar-self', onclick: openProfileModal }, [
                wrapAvatar(state.me, 28),
                UI.el('span', { class: 'self-label', text: UI.displayLabel(state.me) }),
            ]),
            UI.el('a', { class: 'topbar-link', href: '/logout.php', text: 'Sign out' }),
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

        const header = UI.el('div', { class: 'chat-header' }, [
            UI.el('div', { class: 'chat-title' }, [
                UI.el('span', { class: 'chat-name', text: convDisplayName(conv) }),
                conv.topic ? UI.el('span', { class: 'chat-topic', text: conv.topic }) : null,
            ]),
            UI.el('div', { class: 'chat-meta', text: memberSummary(conv) }),
        ]);

        const log = UI.el('div', { class: 'message-log', id: 'message-log' });
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
        if (!groupWithPrev) {
            bubble.appendChild(UI.el('div', { class: 'msg-meta' }, [
                UI.el('span', { class: 'msg-author', text: UI.displayLabel(sender) }),
                UI.el('span', { class: 'msg-time', text: UI.formatTime(m.created_at) }),
            ]));
        }

        if (m.body && m.body.length > 0) {
            bubble.appendChild(UI.el('div', { class: 'msg-body', html: UI.linkify(m.body) }));
        }

        if (m.attachments && m.attachments.length > 0) {
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

        // Hover toolbar for adding reactions.
        bubble.appendChild(buildReactionToolbar(m));

        row.appendChild(bubble);
        return row;
    }

    function buildReactionToolbar(m) {
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
            title: 'More…',
            onclick: function () { openEmojiPicker(function (emoji) { state.ws.sendReact(m.id, emoji); }); },
        }, '⊕'));
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

        const pendingBar = UI.el('div', { class: 'composer-pending', id: 'composer-pending' });
        const textArea = UI.el('textarea', {
            class: 'composer-input',
            rows: '2',
            placeholder: 'Write a message…',
            oninput: function () {
                state.ws.sendTyping(conv.id);
            },
            onkeydown: function (ev) {
                if (ev.key === 'Enter' && !ev.shiftKey) {
                    ev.preventDefault();
                    submit();
                }
            },
            onpaste: function (ev) {
                handlePaste(ev, pending, pendingBar);
            },
        });

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
            const body = textArea.value.trim();
            if (body.length === 0 && pending.length === 0) return;
            const ids = pending.map(function (a) { return a.id; });
            state.ws.sendMessage(conv.id, body, ids, 0);
            textArea.value = '';
            pending.length = 0;
            repaintPending();
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
            UI.el('button', {
                class: 'composer-send',
                onclick: submit,
                text: 'Send',
            }),
        ]);

        const wrap = UI.el('div', { class: 'composer', ondragover: function (ev) {
            ev.preventDefault();
            wrap.classList.add('dragover');
        }, ondragleave: function () { wrap.classList.remove('dragover'); },
           ondrop: function (ev) {
            ev.preventDefault();
            wrap.classList.remove('dragover');
            const files = ev.dataTransfer && ev.dataTransfer.files;
            if (files && files.length) handleFiles(files);
        }}, [pendingBar, textArea, buttons, fileInput]);

        return wrap;
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
        const categories = [
            { name: 'Smileys', emojis: ['😀','😁','😂','🤣','😅','😊','😇','🙂','🙃','😉','😍','😘','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','🥱','😴','😌','😛','😜','😝','🤤'] },
            { name: 'Hands', emojis: ['👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👋','🙌','👏','🙏','💪','🤝','✊','👊'] },
            { name: 'Hearts', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💖','💗','💘','💝'] },
            { name: 'Things', emojis: ['🎉','🎊','🎁','🎂','🎈','🍕','🍔','🍟','☕','🍺','🍷','🍻','🍩','🍪','🎮','🎵'] },
            { name: 'Animals', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔'] },
            { name: 'Nature', emojis: ['🌳','🌲','🌴','🌵','🌷','🌸','🌹','🌻','🌼','☀️','⛅','🌧️','⛈️','🌈','⭐','🌙'] },
        ];

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

    // ---- profile modal ---------------------------------------------

    function openProfileModal() {
        document.querySelectorAll('.modal-backdrop').forEach(function (n) { n.remove(); });
        const me = state.users.get(state.me.id) || state.me;

        const displayInput = UI.el('input', {
            type: 'text',
            value: me.display_name || '',
            placeholder: me.username,
        });

        const avatarUpload = UI.el('input', {
            type: 'file',
            accept: 'image/*',
        });

        async function save() {
            try {
                await API.setProfile(displayInput.value.trim());
                if (avatarUpload.files && avatarUpload.files[0]) {
                    await API.uploadAvatar(avatarUpload.files[0]);
                }
                backdrop.remove();
            } catch (e) {
                alert('Save failed: ' + e.message);
            }
        }

        async function removeAvatar() {
            try {
                await API.deleteAvatar();
                backdrop.remove();
            } catch (e) {
                alert('Remove failed: ' + e.message);
            }
        }

        const card = UI.el('div', { class: 'modal' }, [
            UI.el('h2', { text: 'Your profile' }),
            UI.el('label', {}, [UI.el('span', { text: 'Display name' }), displayInput]),
            UI.el('label', {}, [UI.el('span', { text: 'Avatar' }), avatarUpload]),
            UI.el('div', { class: 'modal-actions' }, [
                UI.el('button', { class: 'danger', onclick: removeAvatar, text: 'Remove avatar' }),
                UI.el('div', { class: 'composer-spacer' }),
                UI.el('button', { onclick: function () { backdrop.remove(); }, text: 'Cancel' }),
                UI.el('button', { class: 'primary', onclick: save, text: 'Save' }),
            ]),
        ]);
        const backdrop = UI.el('div', {
            class: 'modal-backdrop',
            onclick: function (ev) { if (ev.target === backdrop) backdrop.remove(); },
        }, [card]);
        document.body.appendChild(backdrop);
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
            upsertUser(msg.user);
            if (msg.state === 'offline') {
                state.online.delete(msg.user.id);
            } else {
                state.online.set(msg.user.id, { state: msg.state, custom_text: msg.custom_text || '' });
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

            if (m.conversation_id === state.currentConvID && document.visibilityState === 'visible') {
                const log = document.getElementById('message-log');
                if (log) {
                    const prev = bucket.length >= 2 ? bucket[bucket.length - 2] : null;
                    log.appendChild(messageRow(m, prev));
                    log.scrollTop = log.scrollHeight;
                }
                markCurrentRead();
            } else if (m.sender.id !== state.me.id) {
                state.unread.set(m.conversation_id, (state.unread.get(m.conversation_id) || 0) + 1);
                playBlip();
                updateTitleBadge();
                renderSidebar();
            }
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
            if (msg.conversation_id !== state.currentConvID) {
                state.unread.set(msg.conversation_id, (state.unread.get(msg.conversation_id) || 0) + 1);
                renderSidebar();
            } else {
                flashChat();
            }
            playNudge();
        });

        ws.on('read_receipt', function (msg) {
            let m = state.reads.get(msg.conversation_id);
            if (!m) { m = new Map(); state.reads.set(msg.conversation_id, m); }
            m.set(msg.user.id, msg.last_read_message_id);
            // We don't render explicit tick marks in the web client yet
            // (the data is in state.reads for future use).
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
            // Repaint just this message.
            const row = document.querySelector('[data-message-id="' + msg.message_id + '"]');
            if (row && msg.conversation_id === state.currentConvID) {
                const bucket = state.messages.get(msg.conversation_id) || [];
                const m = bucket.find(function (x) { return x.id === msg.message_id; });
                const prev = bucket.indexOf(m) > 0 ? bucket[bucket.indexOf(m) - 1] : null;
                if (m) row.replaceWith(messageRow(m, prev));
            }
        });

        ws.on('error', function (msg) {
            console.warn('server error', msg);
        });

        ws.connect();
    }

    // ---- audio -----------------------------------------------------

    let audioCtx = null;
    function ensureAudio() {
        if (audioCtx) return audioCtx;
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch (_) { audioCtx = null; }
        return audioCtx;
    }
    function playBlip() {
        const ctx = ensureAudio();
        if (!ctx) return;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 880;
        o.type = 'sine';
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
        o.connect(g).connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.2);
    }
    function playNudge() {
        const ctx = ensureAudio();
        if (!ctx) return;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.setValueAtTime(160, ctx.currentTime);
        o.frequency.linearRampToValueAtTime(110, ctx.currentTime + 0.3);
        o.type = 'sawtooth';
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
        o.connect(g).connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.4);
    }

    // ---- title bar unread badge ------------------------------------

    function updateTitleBadge() {
        let total = 0;
        state.unread.forEach(function (n) { total += n; });
        document.title = (total > 0 ? '(' + total + ') ' : '') + 'OreoHouse';
    }

    setInterval(updateTitleBadge, 1000);

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
