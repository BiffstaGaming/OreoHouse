// Thin REST wrapper around the Go server.
//
// All methods read the auth token from window.OREO.token, set by PHP
// when chat.php loaded. Endpoints match server/internal/api/*.go.

(function (global) {
    'use strict';

    function authHeader() {
        return { Authorization: 'Bearer ' + global.OREO.token };
    }

    function jsonHeaders() {
        return Object.assign({ 'Content-Type': 'application/json' }, authHeader());
    }

    async function request(method, path, body) {
        const init = { method, headers: body !== undefined ? jsonHeaders() : authHeader() };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await fetch(global.OREO.serverUrl + path, init);
        if (res.status === 401) {
            // Server says our token is dead. Force a fresh login.
            window.location.href = '/logout.php';
            throw new Error('session expired');
        }
        if (!res.ok) {
            let msg = res.status + ' ' + res.statusText;
            try {
                const j = await res.json();
                if (j && j.error) msg = j.error;
            } catch (_) { /* not JSON */ }
            throw new Error(msg);
        }
        if (res.status === 204) return null;
        const ct = res.headers.get('content-type') || '';
        if (ct.indexOf('application/json') === 0) return res.json();
        return res.blob();
    }

    // --- conversations --------------------------------------------------

    function listConversations() {
        return request('GET', '/api/conversations');
    }

    function listMessages(convID, before, limit) {
        const params = new URLSearchParams();
        if (before) params.set('before', String(before));
        if (limit) params.set('limit', String(limit));
        const qs = params.toString();
        return request('GET', '/api/conversations/' + convID + '/messages' + (qs ? '?' + qs : ''));
    }

    function createDM(userID) {
        return request('POST', '/api/conversations/dm', { user_id: userID });
    }

    function createGroup(name, memberIDs) {
        return request('POST', '/api/conversations/group', { name: name, member_ids: memberIDs });
    }

    function createRoom(name, topic) {
        return request('POST', '/api/conversations/room', { name: name, topic: topic });
    }

    function listRooms() {
        return request('GET', '/api/rooms');
    }

    function joinRoom(roomID) {
        return request('POST', '/api/rooms/' + roomID + '/join');
    }

    function leaveConversation(convID) {
        return request('POST', '/api/conversations/' + convID + '/leave');
    }

    function addMembers(convID, userIDs) {
        return request('POST', '/api/conversations/' + convID + '/members', { user_ids: userIDs });
    }

    // --- profile + avatars ---------------------------------------------

    function setProfile(displayName) {
        return request('PUT', '/api/me/profile', { display_name: displayName });
    }

    async function uploadAvatar(file) {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(global.OREO.serverUrl + '/api/me/avatar', {
            method: 'POST',
            headers: authHeader(),
            body: fd,
        });
        if (!res.ok) throw new Error('upload failed: ' + res.status);
        return res.json();
    }

    function deleteAvatar() {
        return request('DELETE', '/api/me/avatar');
    }

    function avatarURL(userID, version) {
        const v = version || 0;
        const t = encodeURIComponent(global.OREO.token);
        return global.OREO.serverUrl + '/api/users/' + userID + '/avatar?token=' + t + '&v=' + v;
    }

    // --- uploads -------------------------------------------------------

    async function uploadFile(file, conversationID) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('conversation_id', String(conversationID));
        const res = await fetch(global.OREO.serverUrl + '/api/uploads', {
            method: 'POST',
            headers: authHeader(),
            body: fd,
        });
        if (!res.ok) {
            let msg = 'upload failed: ' + res.status;
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
            throw new Error(msg);
        }
        return res.json();
    }

    function fileURL(attachmentID) {
        const t = encodeURIComponent(global.OREO.token);
        return global.OREO.serverUrl + '/api/files/' + attachmentID + '?token=' + t;
    }

    // URL for /api/messages/{id}/attachments.zip — the "Save all"
    // bundle. Browser triggers a single download; the server streams.
    function messageAttachmentsZipURL(messageID) {
        const t = encodeURIComponent(global.OREO.token);
        return global.OREO.serverUrl + '/api/messages/' + messageID + '/attachments.zip?token=' + t;
    }

    // --- search + media/links ------------------------------------------

    async function searchMessages(query) {
        const url = new URL('/api/search', global.OREO.serverUrl);
        url.searchParams.set('q', query);
        const res = await fetch(url.toString(), { headers: authHeader() });
        if (res.status === 401) {
            window.location.href = '/logout.php';
            throw new Error('session expired');
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const body = await res.json();
        return body.results || [];
    }

    async function listConversationMedia(conversationID) {
        const r = await request('GET', '/api/conversations/' + conversationID + '/media');
        return (r && r.items) || [];
    }

    async function listConversationLinks(conversationID) {
        const r = await request('GET', '/api/conversations/' + conversationID + '/links');
        return (r && r.items) || [];
    }

    async function listPins(conversationID) {
        const r = await request('GET', '/api/conversations/' + conversationID + '/pins');
        return (r && r.pins) || [];
    }

    // PUT /api/conversations/{id} — rename or change-topic. Pass nullable
    // strings: undefined leaves the field untouched, empty string clears.
    async function updateConversation(conversationID, body) {
        return request('PUT', '/api/conversations/' + conversationID, body);
    }

    // DELETE /api/conversations/{id}/members/{userID} — kick another user.
    async function kickMember(conversationID, userID) {
        const res = await fetch(global.OREO.serverUrl + '/api/conversations/' + conversationID + '/members/' + userID, {
            method: 'DELETE',
            headers: authHeader(),
        });
        if (res.status === 401) { window.location.href = '/logout.php'; throw new Error('session expired'); }
        if (res.status !== 204 && !res.ok) {
            let msg = 'kick failed: ' + res.status;
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
            throw new Error(msg);
        }
    }

    // GET /api/search?q=...&conversation_id={id} — search inside one
    // conversation only. Used by Ctrl+F.
    async function searchInConversation(conversationID, query) {
        const url = new URL('/api/search', global.OREO.serverUrl);
        url.searchParams.set('q', query);
        url.searchParams.set('conversation_id', String(conversationID));
        const res = await fetch(url.toString(), { headers: authHeader() });
        if (res.status === 401) { window.location.href = '/logout.php'; throw new Error('session expired'); }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const body = await res.json();
        return body.results || [];
    }

    global.OreoAPI = {
        listConversations: listConversations,
        listMessages: listMessages,
        createDM: createDM,
        createGroup: createGroup,
        createRoom: createRoom,
        listRooms: listRooms,
        joinRoom: joinRoom,
        leaveConversation: leaveConversation,
        addMembers: addMembers,
        setProfile: setProfile,
        uploadAvatar: uploadAvatar,
        deleteAvatar: deleteAvatar,
        avatarURL: avatarURL,
        uploadFile: uploadFile,
        fileURL: fileURL,
        messageAttachmentsZipURL: messageAttachmentsZipURL,
        searchMessages: searchMessages,
        listConversationMedia: listConversationMedia,
        listConversationLinks: listConversationLinks,
        listPins: listPins,
        updateConversation: updateConversation,
        kickMember: kickMember,
        searchInConversation: searchInConversation,
    };
})(window);
