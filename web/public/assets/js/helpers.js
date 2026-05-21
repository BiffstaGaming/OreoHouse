// Small reusable utilities for the OreoHouse web client.
//
// Mirrors the desktop client's lib/sounds.ts, lib/slashCommands.ts,
// lib/mutedConvs.ts, lib/emoji.ts (recent-emoji storage). Kept as
// plain functions so we can keep app.js focused on the UI/state
// machine and reuse these from anywhere.

(function (global) {
    'use strict';

    // ---- localStorage helpers --------------------------------------

    const RECENT_EMOJI_KEY = 'oreohouse-recent-emoji';
    const RECENT_EMOJI_MAX = 16;
    const MUTED_CONVS_KEY  = 'oreohouse-muted-convs';
    const SOUNDS_MUTED_KEY = 'oreohouse-sounds-muted';

    function safeGet(key) {
        try { return localStorage.getItem(key); } catch (_) { return null; }
    }
    function safeSet(key, value) {
        try { localStorage.setItem(key, value); } catch (_) { /* private mode etc */ }
    }

    function loadRecentEmoji() {
        const raw = safeGet(RECENT_EMOJI_KEY);
        if (!raw) return [];
        try {
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr.filter(function (s) { return typeof s === 'string'; }) : [];
        } catch (_) { return []; }
    }
    function pushRecentEmoji(emoji) {
        if (typeof emoji !== 'string' || emoji.length === 0) return;
        const current = loadRecentEmoji().filter(function (e) { return e !== emoji; });
        current.unshift(emoji);
        safeSet(RECENT_EMOJI_KEY, JSON.stringify(current.slice(0, RECENT_EMOJI_MAX)));
    }

    function loadMutedConvs() {
        const raw = safeGet(MUTED_CONVS_KEY);
        if (!raw) return new Set();
        try {
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? new Set(arr) : new Set();
        } catch (_) { return new Set(); }
    }
    function saveMutedConvs(set) {
        safeSet(MUTED_CONVS_KEY, JSON.stringify(Array.from(set)));
    }

    function loadSoundsMuted() {
        return safeGet(SOUNDS_MUTED_KEY) === '1';
    }
    function saveSoundsMuted(muted) {
        safeSet(SOUNDS_MUTED_KEY, muted ? '1' : '0');
    }

    // ---- Web Audio sounds ------------------------------------------
    //
    // One shared AudioContext, lazily created on first use (browsers
    // require a user gesture before allowing audio, which the very
    // first sign-in click satisfies). Mute gate consulted by every
    // play* function — when true, no oscillator is created.

    let audioCtx = null;
    function ctx() {
        if (audioCtx) return audioCtx;
        try { audioCtx = new (global.AudioContext || global.webkitAudioContext)(); }
        catch (_) { audioCtx = null; }
        return audioCtx;
    }

    let mutedGetter = function () { return loadSoundsMuted(); };
    function setMutedGetter(fn) { mutedGetter = fn; }

    function tone(opts) {
        if (mutedGetter()) return;
        const ac = ctx();
        if (!ac) return;
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = opts.type || 'sine';
        if (Array.isArray(opts.freq)) {
            o.frequency.setValueAtTime(opts.freq[0], ac.currentTime);
            o.frequency.linearRampToValueAtTime(opts.freq[1], ac.currentTime + opts.dur);
        } else {
            o.frequency.value = opts.freq;
        }
        g.gain.setValueAtTime(0.0001, ac.currentTime);
        g.gain.exponentialRampToValueAtTime(opts.peak || 0.12, ac.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + opts.dur);
        o.connect(g).connect(ac.destination);
        o.start();
        o.stop(ac.currentTime + opts.dur + 0.02);
    }

    function playMessageBlip() {
        tone({ freq: 880, type: 'sine', peak: 0.12, dur: 0.18 });
    }
    function playNudge() {
        tone({ freq: [160, 110], type: 'sawtooth', peak: 0.18, dur: 0.32 });
    }
    function playReactionPop() {
        // Soft 1200 → 1600 Hz blip — slightly different from the
        // message blip so reactions don't sound identical to messages.
        tone({ freq: [1200, 1600], type: 'sine', peak: 0.08, dur: 0.08 });
    }
    function playSignIn() {
        // Two-note ascending. Mimics MSN's nudge-y sign-in chime.
        tone({ freq: 523, type: 'sine', peak: 0.08, dur: 0.12 });
        setTimeout(function () { tone({ freq: 784, type: 'sine', peak: 0.08, dur: 0.16 }); }, 110);
    }
    function playSignOut() {
        // Two-note descending. Bookend to playSignIn.
        tone({ freq: 784, type: 'sine', peak: 0.07, dur: 0.10 });
        setTimeout(function () { tone({ freq: 523, type: 'sine', peak: 0.07, dur: 0.14 }); }, 100);
    }

    // ---- Slash commands --------------------------------------------
    //
    // Pure text expansion before send. Identical command set + output
    // format to the desktop client's lib/slashCommands.ts.

    const EIGHT_BALL = [
        'It is certain.', 'It is decidedly so.', 'Without a doubt.',
        'Yes — definitely.', 'You may rely on it.', 'As I see it, yes.',
        'Most likely.', 'Outlook good.', 'Yes.', 'Signs point to yes.',
        'Reply hazy, try again.', 'Ask again later.',
        'Better not tell you now.', 'Cannot predict now.',
        'Concentrate and ask again.', 'Don’t count on it.',
        'My reply is no.', 'My sources say no.',
        'Outlook not so good.', 'Very doubtful.',
    ];
    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    function expandSlashCommand(raw) {
        const text = (raw || '').trim();
        if (!text.startsWith('/')) return raw;
        const space = text.indexOf(' ');
        const cmd = (space === -1 ? text.slice(1) : text.slice(1, space)).toLowerCase();
        const rest = space === -1 ? '' : text.slice(space + 1).trim();

        switch (cmd) {
            case 'me':
                return rest ? ('* ' + rest) : raw;
            case 'shrug':
                return rest ? (rest + ' ¯\\_(ツ)_/¯') : '¯\\_(ツ)_/¯';
            case 'tableflip':
                return '(╯°□°)╯︵ ┻━┻';
            case 'unflip':
                return '┬─┬ノ( ゜-゜ノ)';
            case 'time':
                return '🕒 ' + new Date().toLocaleString();
            case 'coin':
            case 'flip':
                return '🪙 flipped a coin: **' + (Math.random() < 0.5 ? 'heads' : 'tails') + '**';
            case '8ball':
                return rest
                    ? ('🎱 ' + rest + ' — ' + pick(EIGHT_BALL))
                    : ('🎱 ' + pick(EIGHT_BALL));
            case 'dice':
            case 'roll': {
                // /dice 2d6   /roll 1d20   /dice (default 1d6)
                const m = rest.match(/^(\d+)d(\d+)$/);
                let n = 1, sides = 6;
                if (m) { n = Math.min(20, Math.max(1, Number(m[1]))); sides = Math.min(100, Math.max(2, Number(m[2]))); }
                const rolls = [];
                let total = 0;
                for (let i = 0; i < n; i++) { const r = 1 + Math.floor(Math.random() * sides); rolls.push(r); total += r; }
                return '🎲 rolled ' + n + 'd' + sides + ': **' + total + '** (' + rolls.join(', ') + ')';
            }
            default:
                return raw;
        }
    }

    global.OreoHelpers = {
        loadRecentEmoji: loadRecentEmoji,
        pushRecentEmoji: pushRecentEmoji,
        loadMutedConvs: loadMutedConvs,
        saveMutedConvs: saveMutedConvs,
        loadSoundsMuted: loadSoundsMuted,
        saveSoundsMuted: saveSoundsMuted,
        setMutedGetter: setMutedGetter,
        playMessageBlip: playMessageBlip,
        playNudge: playNudge,
        playReactionPop: playReactionPop,
        playSignIn: playSignIn,
        playSignOut: playSignOut,
        expandSlashCommand: expandSlashCommand,
    };
})(window);
