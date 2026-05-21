// UI helpers: tiny DOM builders + small components (Avatar, message
// row, contact row, presence dot). Keeps app.js focused on
// state/event glue rather than HTML strings.

(function (global) {
    'use strict';

    function el(tag, attrs, children) {
        const e = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (k) {
                if (k === 'class') e.className = attrs[k];
                else if (k === 'text') e.textContent = attrs[k];
                else if (k === 'html') e.innerHTML = attrs[k];
                else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
                    e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
                }
                else if (attrs[k] === false || attrs[k] === null || attrs[k] === undefined) { /* skip */ }
                else if (attrs[k] === true) e.setAttribute(k, '');
                else e.setAttribute(k, attrs[k]);
            });
        }
        if (children) {
            (Array.isArray(children) ? children : [children]).forEach(function (c) {
                if (c === null || c === undefined || c === false) return;
                if (typeof c === 'string' || typeof c === 'number') {
                    e.appendChild(document.createTextNode(String(c)));
                } else {
                    e.appendChild(c);
                }
            });
        }
        return e;
    }

    function escapeHTML(s) {
        return String(s).replace(/[&<>"']/g, function (ch) {
            switch (ch) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                default: return '&#39;';
            }
        });
    }

    // Deterministic colour per user — same hue every time for the
    // same id, matches the desktop client's flavour.
    function avatarHue(id) {
        const n = (Number(id) || 0) * 137;
        return n % 360;
    }

    function displayLabel(user) {
        if (!user) return '?';
        if (user.display_name && user.display_name.trim().length > 0) return user.display_name;
        return user.username || ('user#' + user.id);
    }

    function initialsFor(user) {
        const label = displayLabel(user) || '?';
        const parts = label.split(/\s+/).filter(Boolean);
        if (parts.length === 0) return '?';
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    function avatar(user, size) {
        size = size || 32;
        const wrapper = el('span', {
            class: 'avatar',
            style: 'width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.4) + 'px;background:hsl(' + avatarHue(user.id) + ',55%,72%);',
        });
        if (user.has_avatar) {
            const img = el('img', {
                src: global.OreoAPI.avatarURL(user.id, user.avatar_version || 0),
                alt: '',
                loading: 'lazy',
            });
            img.addEventListener('error', function () {
                // Fallback to initials if the avatar fetch dies.
                wrapper.innerHTML = '';
                wrapper.appendChild(document.createTextNode(initialsFor(user)));
            });
            wrapper.appendChild(img);
        } else {
            wrapper.appendChild(document.createTextNode(initialsFor(user)));
        }
        return wrapper;
    }

    function presenceDot(state) {
        const cls = 'dot dot-' + (state || 'offline');
        return el('span', { class: cls });
    }

    function formatTime(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const today = new Date();
        const sameDay = d.toDateString() === today.toDateString();
        if (sameDay) return hh + ':' + mm;
        return d.toLocaleDateString() + ' ' + hh + ':' + mm;
    }

    function linkify(text) {
        // Very simple URL linkification with no attempt at parsing
        // markdown / mentions / etc. Family chat, not a code editor.
        const safe = escapeHTML(text);
        return safe.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
            return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
        });
    }

    function isImageMime(m) {
        return typeof m === 'string' && m.indexOf('image/') === 0;
    }

    global.OreoUI = {
        el: el,
        escapeHTML: escapeHTML,
        avatar: avatar,
        avatarHue: avatarHue,
        displayLabel: displayLabel,
        initialsFor: initialsFor,
        presenceDot: presenceDot,
        formatTime: formatTime,
        linkify: linkify,
        isImageMime: isImageMime,
    };
})(window);
