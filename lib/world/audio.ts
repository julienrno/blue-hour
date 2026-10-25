import gsap from "gsap";
import type { SoundCloudMusic } from "./soundcloud";


// Wind, steps and the street's small sounds sit well below full level so the music stays in front
const ENV_LEVEL = 0.6325;
const MUSIC_LEVEL = 0.6;

export class Soundscape {
  ctx: AudioContext;
  private master: GainNode;
  private windGain: GainNode;
  private gustGain: GainNode;
  private windFilter?: BiquadFilterNode;
  private stepBuffers: AudioBuffer[] = [];
  private tapBuffers: AudioBuffer[] = [];
  /** Everything happening out in the street: muffled behind the glass when you are in the shop. */
  private outdoor: GainNode;
  private outdoorFilter: BiquadFilterNode;
  private indoor = false;
  music?: SoundCloudMusic;
  musicAvailable = false;
  private musicLevel = { v: 0 };
  muted = false;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = ENV_LEVEL;
    this.master.connect(this.ctx.destination);

    this.outdoorFilter = this.ctx.createBiquadFilter();
    this.outdoorFilter.type = "lowpass";
    this.outdoorFilter.frequency.value = 18000;
    this.outdoorFilter.Q.value = 0.5;
    this.outdoor = this.ctx.createGain();
    this.outdoorFilter.connect(this.outdoor).connect(this.master);

    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0;
    this.gustGain = this.ctx.createGain();
    this.windGain.connect(this.gustGain).connect(this.outdoorFilter);
    this.startWind();
    this.stepBuffers = Array.from({ length: 5 }, () => this.crunchBuffer());
    this.tapBuffers = Array.from({ length: 4 }, () => this.tapBuffer());
  }

  private noise(seconds: number, brown: boolean) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
    return buf;
  }

  private startWind() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise(8, true);
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 520;
    filter.Q.value = 0.7;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 280;
    lfo.connect(lfoGain).connect(filter.frequency);
    src.connect(filter).connect(this.windGain);
    this.windFilter = filter;
    src.start();
    lfo.start();
  }

  /** A soft packed-snow step: a muffled heel press followed by a gentle compression, no sharp grains. */
  private crunchBuffer() {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * 0.38);
    const buf = this.ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    let brown = 0;
    let soft = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const w = Math.random() * 2 - 1;
      brown = (brown + 0.04 * w) / 1.04;
      // Grains are rare, small and smoothed, so they read as snow settling rather than sand
      const grain = Math.random() < 0.02 ? w * 0.5 : 0;
      soft += (grain - soft) * 0.08;
      const press = Math.pow(Math.sin(Math.PI * Math.min(t * 3.2, 1)), 2) * Math.exp(-t * 5);
      const settle = Math.min(t * 6, 1) * Math.exp(-t * 7);
      d[i] = brown * 1.6 * press + soft * settle * 0.9;
    }
    return buf;
  }

  /** A boot on shop tiles: a short, dry heel knock with a little squeak of wet rubber. */
  private tapBuffer() {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * 0.12);
    const buf = this.ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const f = 150 + Math.random() * 40;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const knock = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 60);
      const click = (Math.random() * 2 - 1) * Math.exp(-t * 300) * 0.5;
      d[i] = knock * 0.8 + click;
    }
    return buf;
  }

  /** 0 out in the street, 1 shut inside the shop: the street fades behind the glass. */
  setInside(level: number) {
    if (this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    this.indoor = level > 0.5;
    this.outdoorFilter.frequency.setTargetAtTime(18000 * Math.pow(420 / 18000, level), now, 0.15);
    this.outdoor.gain.setTargetAtTime(1 - 0.6 * level, now, 0.15);
  }

  private humGain?: GainNode;
  /** The shop's own sound: fridge compressors, the fans behind them and the faint buzz of the tubes. */
  shopHum(level: number) {
    if (this.ctx.state !== "running") return;
    this.humGain ??= this.loopNode((out) => {
      const fan = this.ctx.createBufferSource();
      fan.buffer = this.noise(6, true);
      fan.loop = true;
      const fanLp = this.ctx.createBiquadFilter();
      fanLp.type = "lowpass";
      fanLp.frequency.value = 900;
      const fanG = this.ctx.createGain();
      fanG.gain.value = 0.5;
      fan.connect(fanLp).connect(fanG).connect(out);
      fan.start();
      const comp = this.ctx.createOscillator();
      comp.frequency.value = 50;
      const compG = this.ctx.createGain();
      compG.gain.value = 0.35;
      comp.connect(compG).connect(out);
      comp.start();
      const tubes = this.ctx.createOscillator();
      tubes.type = "sawtooth";
      tubes.frequency.value = 100;
      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 2400;
      bp.Q.value = 3;
      const tubeG = this.ctx.createGain();
      tubeG.gain.value = 0.05;
      tubes.connect(bp).connect(tubeG).connect(out);
      tubes.start();
    });
    this.humGain.gain.setTargetAtTime(level * 0.06, this.ctx.currentTime, 0.2);
  }

  /** The automatic doors: a motor whir and the rubber seals sliding. */
  doorSlide() {
    if (this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise(1, false);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(700, now);
    bp.frequency.linearRampToValueAtTime(1100, now + 0.7);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.05, now + 0.15);
    g.gain.linearRampToValueAtTime(0.0001, now + 0.9);
    src.connect(bp).connect(g).connect(this.master);
    src.start(now);
    const motor = this.ctx.createOscillator();
    motor.type = "triangle";
    motor.frequency.setValueAtTime(170, now);
    motor.frequency.linearRampToValueAtTime(210, now + 0.5);
    motor.frequency.linearRampToValueAtTime(160, now + 0.85);
    const mg = this.ctx.createGain();
    mg.gain.setValueAtTime(0, now);
    mg.gain.linearRampToValueAtTime(0.02, now + 0.1);
    mg.gain.linearRampToValueAtTime(0.0001, now + 0.9);
    motor.connect(mg).connect(this.master);
    motor.start(now);
    motor.stop(now + 1);
  }

  /** The two-note chime over the door. */
  doorChime() {
    if (this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    [
      [1318.5, 0],
      [1046.5, 0.32],
    ].forEach(([f, at]) => {
      for (const [mult, amp] of [
        [1, 1],
        [2.76, 0.18],
      ]) {
        const o = this.ctx.createOscillator();
        o.frequency.value = f * mult;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, now + at);
        g.gain.linearRampToValueAtTime(0.05 * amp, now + at + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, now + at + 1.6);
        o.connect(g).connect(this.master);
        o.start(now + at);
        o.stop(now + at + 1.7);
      }
    });
  }

  /** Gusts (0..1) swell the wind and open its filter a little, so you hear them as the snow sweeps sideways. */
  gust(g: number) {
    if (this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    this.gustGain.gain.setTargetAtTime(0.85 + g * 0.9, now, 0.4);
    this.windFilter?.frequency.setTargetAtTime(480 + g * 380, now, 0.4);
  }

  step(intensity: number) {
    if (this.ctx.state !== "running") return;
    const src = this.ctx.createBufferSource();
    if (this.indoor) {
      src.buffer = this.tapBuffers[Math.floor(Math.random() * this.tapBuffers.length)];
      src.playbackRate.value = 0.9 + Math.random() * 0.2;
      const g = this.ctx.createGain();
      g.gain.value = 0.1 + intensity * 0.12;
      src.connect(g).connect(this.master);
      src.start();
      return;
    }
    src.buffer = this.stepBuffers[Math.floor(Math.random() * this.stepBuffers.length)];
    src.playbackRate.value = 0.8 + Math.random() * 0.2;
    // Low-passed instead of band-passed: snow muffles, it doesn't hiss
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 650 + Math.random() * 300 + intensity * 250;
    lp.Q.value = 0.4;
    const g = this.ctx.createGain();
    g.gain.value = (0.18 + intensity * 0.22) * 0.9;
    src.connect(lp).connect(g).connect(this.master);
    src.start();
  }

  /** A lamp switching on somewhere nearby: a relay click and a short swell of mains hum, quieter with distance. */
  lampOn(distance: number) {
    if (this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    const v = 1 / (1 + distance * 0.12);
    const click = this.ctx.createBufferSource();
    click.buffer = this.noise(0.03, false);
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1800;
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(0.12 * v, now);
    cg.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    click.connect(hp).connect(cg).connect(this.master);
    click.start(now);
    const hum = this.ctx.createOscillator();
    hum.type = "sawtooth";
    hum.frequency.value = 100;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 380;
    const hg = this.ctx.createGain();
    hg.gain.setValueAtTime(0, now);
    hg.gain.linearRampToValueAtTime(0.035 * v, now + 0.35);
    hg.gain.exponentialRampToValueAtTime(0.0005, now + 2.6);
    hum.connect(lp).connect(hg).connect(this.master);
    hum.start(now);
    hum.stop(now + 2.7);
  }

  private loopNode(build: (out: GainNode) => void) {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.connect(this.master);
    build(g);
    return g;
  }

  private buzzGain?: GainNode;
  /** The failing lamp's electrical buzz, 0-1. */
  buzz(level: number) {
    if (this.ctx.state !== "running") return;
    this.buzzGain ??= this.loopNode((out) => {
      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1200;
      bp.Q.value = 1.5;
      for (const f of [100, 200]) {
        const o = this.ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        o.connect(bp);
        o.start();
      }
      bp.connect(out);
    });
    this.buzzGain.gain.setTargetAtTime(level * 0.025, this.ctx.currentTime, 0.03);
  }

  /** A snowball leaving your hand: a short airy whoosh. */
  throwSound() {
    if (this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise(0.3, false);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(500, now);
    bp.frequency.exponentialRampToValueAtTime(1600, now + 0.22);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.18, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    src.connect(bp).connect(g).connect(this.master);
    src.start(now);
  }

  /** A snowball bursting: a soft, muffled thump, quieter with distance and on hard surfaces a touch brighter. */
  splatSound(distance: number, hard: boolean) {
    if (this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    const v = 1 / (1 + distance * 0.15);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise(0.2, false);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = (hard ? 1400 : 700) / (1 + distance * 0.03);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5 * v, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    src.connect(lp).connect(g).connect(this.outdoorFilter);
    src.start(now);
  }

  /** Starts the ambience; `music` is the SoundCloud widget, already started by the page's click. */
  async begin(music?: SoundCloudMusic) {
    // The page has already started the music in the click handler; this only takes over its volume
    this.music = music;
    this.musicLevel.v = MUSIC_LEVEL;
    await this.ctx.resume();
    gsap.to(this.windGain.gain, { value: 0.22, duration: 6, ease: "sine.inOut" });
    if (music) this.musicAvailable = await music.ready;
  }

  private applyMusic = () => {
    this.music?.setVolume(this.muted ? 0 : this.musicLevel.v);
  };

  duck(on: boolean) {
    gsap.to(this.master.gain, { value: (on ? 0.35 : 1) * ENV_LEVEL, duration: 1.2, ease: "sine.out" });
    gsap.to(this.musicLevel, { v: on ? MUSIC_LEVEL * 0.4 : MUSIC_LEVEL, duration: 1.2, onUpdate: this.applyMusic });
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyMusic();
    return this.muted;
  }

  dispose() {
    this.music?.pause();
    this.ctx.close();
  }
}
