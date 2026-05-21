// WebSocket client.
//
// Connects to ws[s]://serverUrl/ws?token=..., dispatches incoming
// frames to handlers registered with on(type, fn), and exposes send
// helpers that mirror server/internal/proto/ws.go.
//
// Reconnects automatically with a small backoff; the server replays
// missed messages using the per-member delivery cursor so the UI just
// gets a fresh batch of "message" frames on reconnect.

(function (global) {
    'use strict';

    function OreoWS() {
        this._handlers = Object.create(null);
        this._sock = null;
        this._connected = false;
        this._closed = false;
        this._reconnectDelay = 1000;
        this._typingThrottle = Object.create(null);
        this._nudgeCooldown = 0;
    }

    OreoWS.prototype.on = function (type, fn) {
        (this._handlers[type] || (this._handlers[type] = [])).push(fn);
    };

    OreoWS.prototype._emit = function (type, msg) {
        const hs = this._handlers[type];
        if (hs) hs.forEach(function (h) { try { h(msg); } catch (e) { console.error(e); } });
        const ws = this._handlers['*'];
        if (ws) ws.forEach(function (h) { try { h(msg); } catch (e) { console.error(e); } });
    };

    OreoWS.prototype.connect = function () {
        if (this._closed) return;
        const base = global.OREO.serverUrl.replace(/^http/, 'ws');
        const url = base + '/ws?token=' + encodeURIComponent(global.OREO.token);
        const sock = new WebSocket(url);
        const self = this;

        sock.addEventListener('open', function () {
            self._connected = true;
            self._reconnectDelay = 1000;
            self._emit('_open', null);
        });
        sock.addEventListener('message', function (ev) {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) { console.warn('bad WS frame', ev.data); return; }
            if (msg && msg.type) self._emit(msg.type, msg);
        });
        sock.addEventListener('close', function () {
            self._connected = false;
            self._emit('_close', null);
            if (self._closed) return;
            const delay = Math.min(self._reconnectDelay, 10000);
            self._reconnectDelay = Math.min(delay * 2, 10000);
            setTimeout(function () { self.connect(); }, delay);
        });
        sock.addEventListener('error', function () { /* close will fire */ });
        this._sock = sock;
    };

    OreoWS.prototype.close = function () {
        this._closed = true;
        if (this._sock) this._sock.close();
    };

    OreoWS.prototype._send = function (obj) {
        if (!this._sock || this._sock.readyState !== WebSocket.OPEN) return false;
        try { this._sock.send(JSON.stringify(obj)); return true; }
        catch (e) { console.warn('WS send failed', e); return false; }
    };

    OreoWS.prototype.sendMessage = function (conversation_id, body, attachment_ids, reply_to_id) {
        return this._send({
            type: 'message',
            conversation_id: conversation_id,
            body: body,
            attachment_ids: attachment_ids || [],
            reply_to_id: reply_to_id || 0,
        });
    };

    OreoWS.prototype.sendTyping = function (conversation_id) {
        const now = Date.now();
        if ((this._typingThrottle[conversation_id] || 0) > now - 2000) return false;
        this._typingThrottle[conversation_id] = now;
        return this._send({ type: 'typing', conversation_id: conversation_id });
    };

    OreoWS.prototype.sendNudge = function (conversation_id) {
        const now = Date.now();
        if (this._nudgeCooldown > now - 3000) return false;
        this._nudgeCooldown = now;
        return this._send({ type: 'nudge', conversation_id: conversation_id });
    };

    OreoWS.prototype.sendRead = function (conversation_id, last_read_message_id) {
        return this._send({
            type: 'read',
            conversation_id: conversation_id,
            last_read_message_id: last_read_message_id,
        });
    };

    OreoWS.prototype.sendStatus = function (state, custom_text) {
        return this._send({ type: 'status', state: state, custom_text: custom_text || '' });
    };

    OreoWS.prototype.sendReact = function (message_id, emoji) {
        return this._send({ type: 'react', message_id: message_id, emoji: emoji });
    };

    OreoWS.prototype.sendEdit = function (message_id, body) {
        return this._send({ type: 'edit', message_id: message_id, body: body });
    };

    OreoWS.prototype.sendDelete = function (message_id) {
        return this._send({ type: 'delete', message_id: message_id });
    };

    OreoWS.prototype.sendPin = function (message_id) {
        return this._send({ type: 'pin', message_id: message_id });
    };

    OreoWS.prototype.sendUnpin = function (message_id) {
        return this._send({ type: 'unpin', message_id: message_id });
    };

    OreoWS.prototype.isConnected = function () { return this._connected; };

    global.OreoWS = OreoWS;
})(window);
