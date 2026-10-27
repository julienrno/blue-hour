// Tracks are streamed from the artists' own SoundCloud uploads through the official, visible widget,
// so nothing is rehosted; the Widget API only starts them, moves through the list and sets the volume.
export const PLAYLIST = [
  "https://soundcloud.com/myabandonedhome/snowfall-w-oneheart",
  "https://soundcloud.com/scizzie/aquatic-ambience",
  "https://soundcloud.com/hisohkah/school-rooftop",
  "https://soundcloud.com/j0wdrixcikus/molchat-doma-sudno-boris-rizhiyslowed",
];
const API_SRC = "https://w.soundcloud.com/player/api.js";

const WIDGET_OPTIONS = {
  color: "#a8c4ff",
  hide_related: "true",
  show_comments: "false",
  show_user: "true",
  show_reposts: "false",
  show_teaser: "false",
  visual: "false",
};

// Widget.load() takes real booleans: the string "false" would count as true and switch to the big visual player
const LOAD_OPTIONS = {
  auto_play: true,
  color: WIDGET_OPTIONS.color,
  hide_related: true,
  show_comments: false,
  show_user: true,
  show_reposts: false,
  show_teaser: false,
  visual: false,
};

// Every start (a new track, a resume, the first click) fades in from silence over this long
const FADE_MS = 800;
// and the volume keeps being pushed to the widget for a while after, since it resets to full on its own when a
// track loads, and a single setVolume sent before the new sound exists is simply lost
const GUARD_MS = 2500;
// How often the volume is pushed while fading or guarding
const PUSH_EVERY = 50;
// Gives up holding silence if a held track never actually starts (the next start holds again)
const HOLD_LIMIT = 15000;

export function widgetSrc(autoPlay = false, url = PLAYLIST[0]) {
  const params = new URLSearchParams({ url, auto_play: String(autoPlay), ...WIDGET_OPTIONS });
  return `https://w.soundcloud.com/player/?${params}`;
}

type Sound = { title?: string; duration?: number; artwork_url?: string | null; user?: { username?: string; avatar_url?: string } };
type Widget = {
  bind(event: string, cb: (e?: { currentPosition?: number }) => void): void;
  play(): void;
  pause(): void;
  toggle(): void;
  seekTo(ms: number): void;
  setVolume(v: number): void;
  isPaused(cb: (paused: boolean) => void): void;
  getCurrentSound(cb: (s: Sound | null) => void): void;
  getVolume(cb: (v: number) => void): void;
  load(url: string, options: Record<string, unknown>): void;
};
type SCGlobal = { Widget: ((el: HTMLIFrameElement) => Widget) & { Events: Record<string, string> } };

/** What the iPod shows: mirrors the widget's current sound and position. */
export type NowPlaying = {
  title: string;
  artist: string;
  artwork: string | null;
  position: number;
  duration: number;
  playing: boolean;
  index: number;
  count: number;
};

let apiLoading: Promise<SCGlobal> | null = null;
function loadApi() {
  apiLoading ??= new Promise((resolve, reject) => {
    const existing = (window as unknown as { SC?: SCGlobal }).SC;
    if (existing) return resolve(existing);
    const s = document.createElement("script");
    s.src = API_SRC;
    s.async = true;
    s.onload = () => resolve((window as unknown as { SC: SCGlobal }).SC);
    s.onerror = () => reject(new Error("SoundCloud widget API failed to load"));
    document.head.appendChild(s);
  });
  return apiLoading;
}

export class SoundCloudMusic {
  private widget?: Widget;
  // The level asked for (the mix, ducking and mute included) and the fade-in multiplier on top of it
  private volume = 0.54;
  private fade = 1;
  private fadeFrom = 1;
  private rampFrom: number | null = null;
  private heldAt = 0;
  private pushTimer?: number;
  private lastCheck = 0;
  private bound = false;
  private index = 0;
  ready: Promise<boolean>;
  state: NowPlaying = { title: "snowfall", artist: "reidenshi", artwork: null, position: 0, duration: 0, playing: false, index: 0, count: PLAYLIST.length };

  // What each track is called (and its artwork), known ahead so the iPod can switch the moment you skip instead of
  // waiting for SoundCloud to load the next one and report back
  private meta: ({ title: string; artist: string; artwork: string | null; duration?: number } | undefined)[] = [];

  constructor(private frame: HTMLIFrameElement) {
    this.ready = this.connect();
    this.bindMediaKeys();
    this.prefetch();
  }

  private prefetch() {
    PLAYLIST.forEach((url, i) => {
      fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { title?: string; author_name?: string; thumbnail_url?: string } | null) => {
          if (!j || this.meta[i]) return;
          const artist = j.author_name ?? "";
          // oEmbed titles read "track by artist"
          const full = j.title ?? "";
          const suffix = ` by ${artist}`;
          const title = full.endsWith(suffix) ? full.slice(0, -suffix.length) : full;
          this.meta[i] = { title, artist, artwork: j.thumbnail_url ?? null };
        })
        .catch(() => undefined);
    });
  }

  private connect() {
    return loadApi()
      .then(
        (SC) =>
          new Promise<boolean>((resolve) => {
            const w = SC.Widget(this.frame);
            const timeout = window.setTimeout(() => resolve(false), 8000);
            w.bind(SC.Widget.Events.READY, () => {
              window.clearTimeout(timeout);
              this.widget = w;
              this.push();
              this.refreshSound();
              // Bindings survive load(), so they are attached once
              if (!this.bound) {
                this.bound = true;
                w.bind(SC.Widget.Events.FINISH, () => this.skip(1));
                w.bind(SC.Widget.Events.PLAY, () => {
                  this.state.playing = true;
                  if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing";
                  // A new track starting in the iframe would take the keys back to it
                  window.setTimeout(() => this.holdMediaKeys(), 300);
                  this.rampIn();
                  this.refreshSound();
                });
                w.bind(SC.Widget.Events.PAUSE, () => {
                  this.state.playing = false;
                  if (navigator.mediaSession) navigator.mediaSession.playbackState = "paused";
                });
                w.bind(SC.Widget.Events.PLAY_PROGRESS, (e) => {
                  if (e?.currentPosition !== undefined) this.state.position = e.currentPosition;
                  this.watch();
                });
              }
              resolve(true);
            });
          })
      )
      .catch(() => false);
  }

  private level() {
    return Math.round(this.volume * this.fade * 100);
  }

  private push() {
    this.widget?.setVolume(this.level());
  }

  /** About to start something: silence it until it is actually playing, then rampIn() brings it up. */
  private hold() {
    this.fade = 0;
    this.fadeFrom = 0;
    this.rampFrom = null;
    this.heldAt = performance.now();
    this.push();
    this.keepPushing();
  }

  /** It is playing: fade up from wherever the hold left it, and keep the level pinned while the widget settles. */
  private rampIn() {
    if (this.rampFrom === null) {
      this.fadeFrom = this.fade;
      this.rampFrom = performance.now();
    }
    this.push();
    this.keepPushing();
  }

  private keepPushing() {
    if (this.pushTimer !== undefined) return;
    this.pushTimer = window.setInterval(() => {
      const now = performance.now();
      if (this.rampFrom === null) {
        // Still loading: hold it at silence, so the first sample out of the new track is not at full volume
        this.fade = 0;
        this.push();
        if (now - this.heldAt > HOLD_LIMIT) this.stopPushing();
        return;
      }
      const t = Math.min(1, (now - this.rampFrom) / FADE_MS);
      this.fade = this.fadeFrom + (1 - this.fadeFrom) * t * t;
      this.push();
      if (now - this.rampFrom > FADE_MS + GUARD_MS) {
        this.fade = 1;
        this.fadeFrom = 1;
        this.rampFrom = null;
        this.push();
        this.stopPushing();
      }
    }, PUSH_EVERY);
  }

  private stopPushing() {
    if (this.pushTimer !== undefined) window.clearInterval(this.pushTimer);
    this.pushTimer = undefined;
  }

  /** While playing, every second or so, check the widget still has the level it was given and put it back if not. */
  private watch() {
    const now = performance.now();
    if (this.pushTimer !== undefined || now - this.lastCheck < 1000) return;
    this.lastCheck = now;
    const want = this.level();
    this.widget?.getVolume((v) => {
      if (typeof v === "number" && Math.abs(v - want) > 1 && this.pushTimer === undefined) this.push();
    });
  }

  private refreshSound() {
    this.widget?.getCurrentSound((s) => {
      if (!s) return;
      const art = s.artwork_url ?? s.user?.avatar_url ?? null;
      this.state = {
        ...this.state,
        title: s.title ?? this.state.title,
        artist: s.user?.username ?? this.state.artist,
        // Ask for the larger artwork variant; the default is tiny
        artwork: art ? art.replace("-large.", "-t300x300.") : null,
        duration: s.duration ?? 0,
        index: this.index,
      };
      this.meta[this.index] = { title: this.state.title, artist: this.state.artist, artwork: this.state.artwork, duration: this.state.duration };
      this.updateMediaSession();
    });
  }

  /**
   * The keyboard's previous / next / play keys, through the browser's media session (they also drive the OS
   * now-playing panel, which shows the track and its artwork). The music itself plays inside SoundCloud's iframe,
   * and the browser sends the keys to the frame that is playing, where nothing listens for next / previous. A
   * silent loop playing in the page itself makes this page the one the keys go to.
   */
  private anchor?: HTMLAudioElement;

  private holdMediaKeys() {
    if (typeof document === "undefined") return;
    if (!this.anchor) {
      this.anchor = new Audio(silentWav());
      this.anchor.loop = true;
      this.anchor.volume = 0.01;
    }
    void this.anchor.play().catch(() => undefined);
    this.updateMediaSession();
  }

  bindMediaKeys() {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!ms) return;
    const set = (action: MediaSessionAction, fn: () => void) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        // Not every browser knows every action
      }
    };
    set("nexttrack", () => this.skip(1));
    set("previoustrack", () => this.skip(-1));
    set("play", () => this.play());
    set("pause", () => this.pause());
  }

  private updateMediaSession() {
    if (typeof navigator === "undefined" || !navigator.mediaSession || typeof MediaMetadata === "undefined") return;
    const { title, artist, artwork } = this.state;
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album: "blue hour",
      artwork: artwork ? [{ src: artwork, sizes: "300x300", type: "image/jpeg" }] : [],
    });
  }

  /**
   * Call from the click itself. Plays through the widget API; if the browser still kept it paused, the player is
   * reloaded with autoplay on, which the browser allows now that the page has been clicked.
   */
  start() {
    this.holdMediaKeys();
    // Only something that is not already playing is held, or it would sit silent waiting for a start that never comes
    if (!this.state.playing) this.hold();
    this.widget?.play();
    window.setTimeout(() => {
      if (!this.widget) return this.reloadPlaying();
      this.widget.isPaused((paused) => {
        if (paused) this.reloadPlaying();
      });
    }, 1500);
  }

  private reloadPlaying() {
    this.hold();
    this.widget = undefined;
    this.bound = false;
    this.frame.src = widgetSrc(true, PLAYLIST[this.index]);
    this.ready = this.connect();
  }

  /** Next (1) or previous (-1) track, wrapping around the list. */
  skip(step: number) {
    this.index = (this.index + step + PLAYLIST.length) % PLAYLIST.length;
    const known = this.meta[this.index];
    this.state = {
      ...this.state,
      title: known?.title ?? "…",
      artist: known?.artist ?? "",
      artwork: known?.artwork ?? null,
      position: 0,
      duration: known?.duration ?? 0,
      playing: true,
      index: this.index,
    };
    this.updateMediaSession();
    this.hold();
    this.widget?.load(PLAYLIST[this.index], { ...LOAD_OPTIONS, callback: () => this.push() });
  }

  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  pause() {
    this.widget?.pause();
    if (navigator.mediaSession) navigator.mediaSession.playbackState = "paused";
  }

  play() {
    if (!this.state.playing) this.hold();
    this.widget?.play();
    this.holdMediaKeys();
  }

  /** 0-1 */
  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.push();
  }
}

/** Half a second of silence as a WAV, for the page's own media-key anchor. */
function silentWav() {
  const rate = 8000;
  const samples = rate / 2;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const text = (o: number, t: string) => [...t].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
