// The sound layer, and the reason a mute button can be honest about itself.
//
// Muting here is not `gain.value = 0`: a zeroed gain still leaves the AudioContext running and
// still allocates an oscillator for every event, which is measurable (and audible to a profiler)
// while sounding like nothing. `setMuted(true)` suspends the context and `voice()` refuses to
// create a single node while muted, so the graph stays empty. `state()` reports both facts so a
// test can fail a fake mute instead of reading a boolean.
//
// Everything is synthesised — one oscillator plus one envelope per event — because the game
// ships no audio files and a pentomino click does not need one. The context is created lazily
// inside the first user gesture (browsers refuse audio before one) and every entry point is a
// no-op when the platform has no Web Audio at all (node, a webview without it).

const VOICES = {
  place: { freq: 392, type: 'triangle', dur: 0.11, gain: 0.16 },
  take: { freq: 262, type: 'sine', dur: 0.09, gain: 0.12 },
  turn: { freq: 588, type: 'square', dur: 0.045, gain: 0.07 },
  refuse: { freq: 138, type: 'sawtooth', dur: 0.16, gain: 0.13 },
  win: { freq: 523, type: 'triangle', dur: 0.34, gain: 0.2 },
};

export function createAudio() {
  const Ctor = typeof AudioContext !== 'undefined' ? AudioContext
    : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
  let ctx = null;
  let master = null;
  let muted = false;
  let voices = 0; // oscillators ever allocated, so "no nodes while muted" is checkable
  let blocked = 0; // voice() calls that found no context (before the first gesture, or muted)

  function ensure() {
    if (muted || !Ctor) return null;
    if (!ctx) {
      try {
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = 0.9;
        master.connect(ctx.destination);
      } catch (err) {
        ctx = null; // audio is decoration: a platform that refuses it just plays silently
        return null;
      }
    }
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
    return ctx;
  }

  function voice(name, step) {
    const spec = VOICES[name];
    const live = ensure();
    if (!spec) return false;
    if (!live) {
      blocked++;
      return false;
    }
    const t = live.currentTime;
    const osc = live.createOscillator();
    const gain = live.createGain();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.freq * Math.pow(2, (step || 0) / 12), t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(spec.gain, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + spec.dur + 0.02);
    voices++;
    return true;
  }

  return {
    place: () => voice('place'),
    take: () => voice('take'),
    turn: () => voice('turn'),
    refuse: () => voice('refuse'),
    // The completion cue is the arpeggio the player earns for a full 匣; the step is the number
    // of stars minus one, so 一次到位 sounds brighter than a sloppy fill.
    win: (step) => {
      if (!voice('win', 0)) return false;
      voice('win', 4 + (step || 0) * 3);
      voice('win', 7 + (step || 0) * 3);
      return true;
    },
    setMuted(v) {
      muted = !!v;
      if (muted && ctx && ctx.suspend) ctx.suspend().catch(() => {});
      if (!muted) ensure();
      return muted;
    },
    toggleMute() {
      return this.setMuted(!muted);
    },
    isMuted() {
      return muted;
    },
    // Called when the game is paused or the tab is hidden: the context stops, so a held
    // envelope cannot keep running behind the veil.
    halt() {
      if (ctx && ctx.suspend) ctx.suspend().catch(() => {});
    },
    release() {
      if (!muted) ensure();
    },
    state() {
      return {
        muted,
        supported: !!Ctor,
        context: ctx ? ctx.state : 'none',
        nodes: voices,
        blocked,
      };
    },
  };
}
