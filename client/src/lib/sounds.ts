// Tiny Web Audio API helpers for the two notification sounds Phase 7
// ships: a short blip on incoming chat messages and a low rumble on
// nudges. No bundled audio files yet — Phase 10 polish can swap in
// real MSN-flavored samples without touching call sites.
//
// Every play call short-circuits when the user has muted (persisted
// to localStorage), and is a silent no-op when an AudioContext can't
// be created (e.g. running headless in tests).

const MUTE_KEY = "oreohouse-muted";

let cached: AudioContext | null = null;

function ctx(): AudioContext | null {
  if (cached) return cached;
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    cached = new Ctor();
    return cached;
  } catch {
    return null;
  }
}

// isMuted / setMuted read/write the persisted mute preference.
export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    if (muted) localStorage.setItem(MUTE_KEY, "1");
    else localStorage.removeItem(MUTE_KEY);
  } catch {
    /* localStorage unavailable — ignore */
  }
}

// playMessageBlip — short, soft ding for incoming chat messages
// (~80 ms sine sweep). Mute-respecting.
export function playMessageBlip(): void {
  if (isMuted()) return;
  const ac = ctx();
  if (!ac) return;
  try {
    if (ac.state === "suspended") void ac.resume();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(950, ac.currentTime);
    osc.frequency.exponentialRampToValueAtTime(700, ac.currentTime + 0.08);
    gain.gain.setValueAtTime(0.28, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.09);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.1);
  } catch {
    /* audio glitch — never let sound failures break the UI */
  }
}

// playNudge — low rumbly square-wave thud, ~250 ms. Mute-respecting.
export function playNudge(): void {
  if (isMuted()) return;
  const ac = ctx();
  if (!ac) return;
  try {
    if (ac.state === "suspended") void ac.resume();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(85, ac.currentTime);
    osc.frequency.exponentialRampToValueAtTime(55, ac.currentTime + 0.22);
    gain.gain.setValueAtTime(0.22, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.27);
  } catch {
    /* audio glitch — ignore */
  }
}
