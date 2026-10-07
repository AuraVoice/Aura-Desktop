// Bolt, Buddy's face: a compact chibi robot drawn in code. This is a port of
// architectures/buddy-avatar-reference.html in the aura repo (drawBolt,
// drawHead, drawEye, the spring constants, pose targets and gaze rules) with
// the page's globals folded into one BoltRig so two Bolts never share springs.
// When this file and the reference disagree, the reference wins.

export type BoltMove =
  | "idle"
  | "rest"
  | "wave"
  | "listening"
  | "thinking"
  | "speaking"
  | "cheer"
  | "hold";

/** Shell colour. "light" is the reference's white metal, for dark surfaces;
 * "dark" is a graphite shell that reads against the light theme. */
export type BoltTone = "light" | "dark";

interface Palette {
  out: string;
  metal: [string, string, string];
  shellHighlight: string;
  earDisc: string;
}
const PALETTES: Record<BoltTone, Palette> = {
  light: {
    out: "#1E2326",
    metal: ["#FFFFFF", "#E6E9EA", "#BAC2C6"],
    shellHighlight: "rgba(255,255,255,0.85)",
    earDisc: "#4A5459",
  },
  dark: {
    out: "#0B0F10",
    metal: ["#6B767B", "#4A5459", "#2E3639"],
    shellHighlight: "rgba(255,255,255,0.3)",
    earDisc: "#8A969B",
  },
};
// The head is scaled around the neck; 0.88 is the approved size.
const HEAD_SCALE = 0.88;

// Springs: quick, with a little overshoot, so nothing glides robotically.
const KEYS = {
  hop: 520, squash: 650, tilt: 380, lean: 380, armL: 560, armR: 560, legL: 700, legR: 700,
  upper: 900, lower: 700, pupil: 600, brow: 500, mouth: 1200, smile: 500, oMouth: 500,
  glow: 300, ear: 300, bulb: 300, dots: 300,
} as const;
type SpringKey = keyof typeof KEYS;
const SPRING_KEYS = Object.keys(KEYS) as SpringKey[];
type Targets = Record<SpringKey, number>;

/** One-shot lengths in seconds: a wave, and two cheer hops of 0.85 s. */
const ONE_SHOT_SECONDS: Record<"wave" | "cheer", number> = { wave: 1.6, cheer: 1.7 };

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ink(ctx: CanvasRenderingContext2D, out: string, w?: number) {
  ctx.lineWidth = w || 3;
  ctx.strokeStyle = out;
  ctx.lineJoin = "round";
  ctx.stroke();
}

export class BoltRig {
  /** Seconds, the reference page's `now`. */
  now = 0;
  private readonly reduced: boolean;
  private readonly motion: 0 | 1;

  private move: BoltMove = "idle";
  private moveStart = 0;
  private oneShot: { move: "wave" | "cheer"; until: number } | null = null;

  private readonly springs = {} as Record<SpringKey, { x: number; v: number }>;
  private level = 0;
  private prevLevel = 0;
  private readonly gaze = { x: 0, y: 0, tx: 0, ty: 0, next: 0, flick: 0 };
  private readonly blink = { next: 1.5, t: -1 };
  private blinkAmt = 0;
  private readonly idleHop: { next: number; at?: number } = { next: 3 };
  private readonly pointer = { x: 0, y: 0, at: -10 };

  // Gradients live in the 120 unit design space, which the ctx scale maps to
  // every size, so one cache per context serves every frame at every size.
  private gradientCtx: CanvasRenderingContext2D | null = null;
  private readonly gradients = new Map<string, CanvasGradient>();
  private palette: Palette = PALETTES.light;

  constructor(reduced: boolean) {
    this.reduced = reduced;
    this.motion = reduced ? 0 : 1;
    SPRING_KEYS.forEach((k) => {
      this.springs[k] = { x: 0, v: 0 };
    });
    this.springs.pupil.x = 0.5;
    this.springs.smile.x = 0.5;
  }

  private p(k: SpringKey): number {
    return this.springs[k].x;
  }

  /** The base move. Only a real change restarts the pose clock. */
  setMove(move: BoltMove) {
    if (move === this.move) return;
    this.move = move;
    this.moveStart = this.now;
  }

  /** Plays a wave or a cheer over the current move, then hands back. */
  playOneShot(move: "wave" | "cheer") {
    this.oneShot = { move, until: this.now + ONE_SHOT_SECONDS[move] };
    this.moveStart = this.now;
  }

  /** Pointer position in the avatar's frame, both axes clamped to -1..1. */
  setPointer(x: number, y: number) {
    this.pointer.x = Math.max(-1, Math.min(1, x));
    this.pointer.y = Math.max(-1, Math.min(1, y));
    this.pointer.at = this.now;
  }

  private currentMove(): BoltMove {
    if (this.oneShot && this.now >= this.oneShot.until) {
      this.oneShot = null;
      this.moveStart = this.now;
    }
    return this.oneShot ? this.oneShot.move : this.move;
  }

  /** Advances the model by `dt` seconds with the raw voice level 0..1. */
  step(dt: number, rawLevel: number) {
    const m = this.currentMove();
    const raw = m === "speaking" || m === "listening" ? rawLevel : 0;
    this.prevLevel = this.level;
    this.level += (raw - this.level) * (1 - Math.exp((-dt * 1000) / 45));
    this.updateGaze(m, dt, this.level);
    this.stepSprings(this.targets(m, this.now, this.level), dt);

    if (this.blink.t < 0 && this.now > this.blink.next && this.motion) this.blink.t = 0;
    this.blinkAmt = 0;
    if (this.blink.t >= 0) {
      this.blink.t += dt;
      const b = this.blink.t / 0.12;
      this.blinkAmt = b < 0.5 ? b * 2 : 2 - b * 2;
      if (b >= 1) {
        this.blink.t = -1;
        this.blink.next = this.now + 2 + Math.random() * 3.5;
        this.blinkAmt = 0;
      }
    }
  }

  private stepSprings(target: Targets, dt: number) {
    const steps = 4;
    const h = dt / steps;
    SPRING_KEYS.forEach((k) => {
      const K = KEYS[k];
      const D = 2 * Math.sqrt(K) * 0.5; // damping ratio 0.5: lively
      const s = this.springs[k];
      const tgt = target[k];
      if (this.reduced) {
        s.x = tgt;
        s.v = 0;
        return;
      }
      for (let i = 0; i < steps; i++) {
        s.v += (K * (tgt - s.x) - D * s.v) * h;
        s.x += s.v * h;
      }
    });
  }

  private targets(m: BoltMove, t: number, lv: number): Targets {
    const motion = this.motion;
    const now = this.now;
    const since = now - this.moveStart;
    const o: Targets = {
      hop: 0, squash: 0.06 * Math.sin((t * Math.PI * 2) / 1.6) * motion, tilt: 0, lean: 0,
      armL: 0.25 + 0.08 * Math.sin(t * 3.2) * motion, armR: 0.25 + 0.08 * Math.sin(t * 3.2 + 1.5) * motion,
      legL: 0, legR: 0, upper: 0.06, lower: 0.05, pupil: 0.5, brow: 0, mouth: 0, smile: 0.5, oMouth: 0,
      glow: 0.25, ear: 0, bulb: 0.25, dots: 0,
    };
    if (m === "idle") {
      o.tilt = this.gaze.x * 0.08;
      if (now > this.idleHop.next) {
        this.idleHop.next = now + 3 + Math.random() * 3;
        this.idleHop.at = now;
      }
      const hs = now - (this.idleHop.at ?? -9);
      if (hs < 0.35) {
        o.hop = Math.sin((hs / 0.35) * Math.PI) * 7;
        o.squash = 0.25;
      } else if (hs < 0.5) o.squash = -0.3;
    } else if (m === "wave") {
      o.armR = 2.55 + 0.55 * Math.sin(t * 15) * motion;
      o.tilt = -0.1 + 0.05 * Math.sin(t * 7.5) * motion;
      o.lean = 2 * Math.sin(t * 7.5) * motion;
      o.lower = 0.45; o.upper = 0.02; o.brow = 1; o.smile = 1; o.glow = 0.5;
      o.squash = 0.06 * Math.sin(t * 15) * motion;
    } else if (m === "listening") {
      o.armR = 2.75; o.tilt = 0.2; o.lean = 4;
      o.ear = 0.5 + 0.5 * lv; o.glow = 0.4 + 0.5 * lv; o.pupil = 0.62 + 0.33 * lv;
      o.upper = 0; o.brow = 0.7; o.smile = 0.3;
      o.squash = 0.05 * lv;
    } else if (m === "thinking") {
      o.armR = -1.9; o.armL = 0.55;
      o.tilt = -0.14 + 0.06 * Math.sin(t * 2.2) * motion; o.lean = -2;
      o.upper = 0.36; o.lower = 0.1; o.pupil = 0.3; o.brow = -0.6; o.oMouth = 1; o.smile = 0;
      o.legR = Math.max(0, Math.sin(t * 9)) * 4 * motion; o.dots = 1; o.bulb = 0.7 + 0.3 * Math.sin(t * 8);
    } else if (m === "speaking") {
      const beat = Math.sin(t * 6.2) * motion;
      o.armL = 0.7 + 0.9 * lv * (0.5 + 0.5 * beat); o.armR = 0.7 + 0.9 * lv * (0.5 - 0.5 * beat);
      o.mouth = 0.1 + 0.9 * lv; o.smile = 0.55; o.squash = 0.22 * lv; o.hop = 2.5 * lv;
      o.tilt = 0.07 * Math.sin(t * 3.4) * motion; o.glow = 0.3 + 0.7 * lv; o.pupil = 0.55 + 0.1 * lv; o.brow = 0.3 + 0.6 * lv;
    } else if (m === "cheer") {
      const ph = (since % 0.85) / 0.85;
      const air = ph < 0.62 ? Math.sin((ph / 0.62) * Math.PI) : 0;
      o.hop = air * 16; o.squash = ph < 0.1 ? -0.35 : ph < 0.62 ? 0.3 : ph < 0.8 ? -0.4 : 0;
      o.armL = 2.85 + 0.25 * Math.sin(t * 18) * motion; o.armR = 2.85 - 0.25 * Math.sin(t * 18) * motion;
      o.legL = air * 4; o.legR = air * 4;
      const shut = air > 0.45;
      o.upper = shut ? 0.62 : 0; o.lower = shut ? 0.42 : 0; o.pupil = shut ? 0.5 : 0.85;
      o.smile = 1.1; o.mouth = shut ? 0 : 0.6; o.brow = 1.2; o.glow = 0.9; o.bulb = 1;
      o.tilt = 0.1 * Math.sin(t * 9) * motion;
    } else if (m === "hold") {
      // Both arms straight up, holding a card over his head. Sustained, so no
      // hop: the card must not bob while someone reads it.
      o.armL = 2.95; o.armR = 2.95;
      o.tilt = 0.03 * Math.sin(t * 1.4) * motion; o.lean = 1.2 * Math.sin(t * 1.4) * motion;
      o.upper = 0.02; o.brow = 0.6; o.smile = 0.8; o.glow = 0.4; o.bulb = 0.5;
    } else if (m === "rest") {
      // Idle for a corner of the desktop: he is in the user's peripheral
      // vision all day, so nothing hops, sways or wanders. Breathing is
      // halved, the arms hang still, and only the eyes follow the pointer.
      o.squash = 0.03 * Math.sin((t * Math.PI * 2) / 2.4) * motion;
      o.armL = 0.25; o.armR = 0.25;
    }
    return o;
  }

  private updateGaze(m: BoltMove, dt: number, lv: number) {
    const gaze = this.gaze;
    const now = this.now;
    const motion = this.motion;
    const since = now - this.moveStart;
    if (m === "idle") {
      if (now - this.pointer.at < 2.5) {
        gaze.tx = this.pointer.x;
        gaze.ty = this.pointer.y;
      } else if (now > gaze.next) {
        if (Math.random() < 0.35) {
          gaze.tx = 0;
          gaze.ty = 0;
        } else {
          gaze.tx = (Math.random() * 2 - 1) * 0.9;
          gaze.ty = (Math.random() * 2 - 1) * 0.6;
        }
        gaze.next = now + 0.45 + Math.random() * 1.2;
      }
    } else if (m === "rest") {
      // Eyes straight ahead, always. Even following the pointer reads as
      // eye-rolling from the corner of the screen, and a glance in the corner
      // of the eye is what pulls a reader off their page.
      gaze.tx = 0;
      gaze.ty = 0;
    } else if (m === "wave") {
      gaze.tx = 0;
      gaze.ty = 0;
    } else if (m === "listening") {
      if (since < 0.6) {
        gaze.tx = 0.9;
        gaze.ty = -0.1;
      } else {
        gaze.tx = 0.05 * Math.sin(now * 1.3);
        gaze.ty = 0;
      }
    } else if (m === "thinking") {
      const sweep = since % 2.6 > 2.1;
      gaze.tx = (sweep ? -0.65 : 0.68) + Math.cos(now * 1.6) * 0.1 * motion;
      gaze.ty = -0.75 + Math.sin(now * 1.6) * 0.07 * motion;
    } else if (m === "speaking") {
      if (lv > 0.7 && this.prevLevel <= 0.7 && now > gaze.flick) {
        gaze.tx = (Math.random() * 2 - 1) * 0.3;
        gaze.ty = (Math.random() * 2 - 1) * 0.15;
        gaze.flick = now + 0.3;
      } else if (now > gaze.flick + 0.2) {
        gaze.tx *= 0.85;
        gaze.ty *= 0.85;
      }
    } else {
      gaze.tx = 0;
      gaze.ty = -0.1;
    }
    const k = this.reduced ? 1 : 1 - Math.exp((-dt * 1000) / 30); // saccade: very fast
    gaze.x += (gaze.tx - gaze.x) * k;
    gaze.y += (gaze.ty - gaze.y) * k;
  }

  // ---- Drawing, in a 120 x 120 design space ----

  /**
   * Draws the current pose onto a square canvas. `cssSize` picks the framing
   * the reference uses: at 24 px and below only the head is drawn, zoomed in;
   * the hero stage (200 px and up) is the full unzoomed figure with the
   * thinking dots; everything between gets the 1.18 zoom.
   */
  render(ctx: CanvasRenderingContext2D, cssSize: number, tone: BoltTone = "light") {
    if (this.gradientCtx !== ctx) {
      this.gradientCtx = ctx;
      this.gradients.clear();
    }
    this.palette = PALETTES[tone];
    const W = ctx.canvas.width;
    const isHero = cssSize >= 200;
    const headOnly = cssSize <= 24;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    ctx.imageSmoothingEnabled = true;
    const k = W / 120;
    ctx.scale(k, k);
    // Below 30 px the body stops reading, so tiny sizes zoom onto the head.
    if (headOnly) {
      ctx.translate(60, 52);
      ctx.scale(1.55, 1.55);
      ctx.translate(-60, -46);
    } else if (!isHero) {
      ctx.translate(60, 62);
      ctx.scale(1.18, 1.18);
      ctx.translate(-60, -62);
    }
    this.drawBolt(ctx, isHero, headOnly);
  }

  private metal(ctx: CanvasRenderingContext2D, y0: number, y1: number): CanvasGradient {
    const stops = this.palette.metal;
    const key = `metal:${stops[0]}:${y0}:${y1}`;
    let g = this.gradients.get(key);
    if (!g) {
      g = ctx.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, stops[0]);
      g.addColorStop(0.5, stops[1]);
      g.addColorStop(1, stops[2]);
      this.gradients.set(key, g);
    }
    return g;
  }

  private visorGradient(ctx: CanvasRenderingContext2D): CanvasGradient {
    let g = this.gradients.get("visor");
    if (!g) {
      g = ctx.createLinearGradient(0, 28, 0, 65);
      g.addColorStop(0, "#1E292C");
      g.addColorStop(1, "#0B1112");
      this.gradients.set("visor", g);
    }
    return g;
  }

  private irisGradient(ctx: CanvasRenderingContext2D, irisR: number): CanvasGradient {
    let g = this.gradients.get("iris");
    if (!g) {
      g = ctx.createRadialGradient(0, 0, 0.5, 0, 0, irisR);
      g.addColorStop(0, "#D2FFF8");
      g.addColorStop(0.35, "#34E3CB");
      g.addColorStop(0.85, "#0E8C7B");
      g.addColorStop(1, "#06403A");
      this.gradients.set("iris", g);
    }
    return g;
  }

  private nub(ctx: CanvasRenderingContext2D, px: number, py: number, s: number, ang: number, len: number, wid: number) {
    // A soft capsule limb pivoting at (px, py); no elbow, no joint.
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-s * ang);
    rr(ctx, -wid / 2, -wid / 2, wid, len + wid / 2, wid / 2);
    ctx.fillStyle = this.metal(ctx, 0, len);
    ctx.fill();
    ink(ctx, this.palette.out, 2.6);
    ctx.restore();
  }

  private drawBolt(ctx: CanvasRenderingContext2D, isHero: boolean, headOnly: boolean) {
    const sq = this.p("squash");
    const hop = this.p("hop");

    if (!headOnly) {
      const sh = Math.max(0.3, 1 - hop / 22);
      ctx.beginPath();
      ctx.ellipse(60, 113, 26 * sh, 3.5 * sh, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fill();
    }

    ctx.save();
    // squash and stretch around the feet
    ctx.translate(60 + this.p("lean"), 112 - hop);
    ctx.scale(1 - sq * 0.12, 1 + sq * 0.14);
    ctx.translate(-60, -112);

    // Legs: short stubs, a foot lifts for a tap
    ([[-1, "legL"], [1, "legR"]] as const).forEach(([s, leg]) => {
      const up = this.p(leg);
      rr(ctx, 60 + s * 10 - 7, 96 - up, 14, 16, 7);
      ctx.fillStyle = this.metal(ctx, 96, 112);
      ctx.fill();
      ink(ctx, this.palette.out, 2.6);
    });

    // Body
    rr(ctx, 39, 70, 42, 34, 15);
    ctx.fillStyle = this.metal(ctx, 70, 104);
    ctx.fill();
    ink(ctx, this.palette.out);
    const cg = 0.3 + 0.7 * this.p("glow");
    ctx.save();
    ctx.shadowColor = "rgba(52,227,203,0.95)";
    ctx.shadowBlur = 8 * this.p("glow");
    ctx.beginPath();
    ctx.arc(60, 87, 5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(52,227,203," + Math.min(1, cg).toFixed(3) + ")";
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(60, 87, 5, 0, Math.PI * 2);
    ink(ctx, this.palette.out, 2);

    // Head, tilting at the neck
    ctx.save();
    ctx.translate(60, 72);
    ctx.rotate(this.p("tilt"));
    ctx.scale(HEAD_SCALE, HEAD_SCALE);
    ctx.translate(-60, -72);
    this.drawHead(ctx, isHero);
    ctx.restore();

    // Arms last so a hand can reach the chin
    this.nub(ctx, 41, 77, -1, this.p("armL"), 15, 10);
    this.nub(ctx, 79, 77, 1, this.p("armR"), 15, 10);

    ctx.restore();
  }

  private drawHead(ctx: CanvasRenderingContext2D, withDots: boolean) {
    const now = this.now;
    const motion = this.motion;
    // Antenna. Still at rest: a constant twitch is the one thing that never
    // stops moving, and a corner of the desktop is no place for it.
    const wob = this.move === "rest" ? 0 : Math.sin(now * 5) * 1.5 * motion;
    ctx.beginPath();
    ctx.moveTo(60, 20);
    ctx.lineTo(60 + wob, 9);
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = this.palette.out;
    ctx.stroke();
    const b = Math.max(0.2, Math.min(1, this.p("bulb")));
    ctx.save();
    ctx.shadowColor = "rgba(232,155,90,0.95)";
    ctx.shadowBlur = 10 * b;
    ctx.beginPath();
    ctx.arc(60 + wob, 7, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(232,155,90," + (0.45 + 0.55 * b).toFixed(3) + ")";
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(60 + wob, 7, 4.2, 0, Math.PI * 2);
    ink(ctx, this.palette.out, 2.2);

    // Ear discs
    [-1, 1].forEach((s) => {
      ctx.beginPath();
      ctx.arc(60 + s * 37, 47, 7, 0, Math.PI * 2);
      ctx.fillStyle = this.palette.earDisc;
      ctx.fill();
      ink(ctx, this.palette.out, 2.4);
      const lit = s === 1 ? this.p("ear") : this.p("ear") * 0.4;
      ctx.beginPath();
      ctx.arc(60 + s * 37, 47, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = lit > 0.05 ? "rgba(52,227,203," + Math.min(1, 0.3 + 0.7 * lit).toFixed(3) + ")" : "#2C3337";
      ctx.fill();
    });

    // Shell
    rr(ctx, 25, 19, 70, 56, 21);
    ctx.fillStyle = this.metal(ctx, 19, 75);
    ctx.fill();
    ink(ctx, this.palette.out);
    rr(ctx, 36, 23, 30, 4.5, 2.2);
    ctx.fillStyle = this.palette.shellHighlight;
    ctx.fill();

    // Visor
    rr(ctx, 32, 28, 56, 37, 14);
    ctx.fillStyle = this.visorGradient(ctx);
    ctx.fill();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = "#6E787C";
    ctx.stroke();

    // Brows
    const br = this.p("brow");
    [-1, 1].forEach((s) => {
      ctx.save();
      ctx.translate(60 + s * 13, 34 - 1.6 * Math.max(0, br));
      ctx.rotate(s * (br < 0 && s === 1 ? 0.35 : br < 0 ? -0.2 : -0.12 * br));
      rr(ctx, -5.5, -1.1, 11, 2.2, 1.1);
      ctx.fillStyle = "rgba(52,227,203,0.8)";
      ctx.fill();
      ctx.restore();
    });

    [-1, 1].forEach((s) => {
      this.drawEye(ctx, 60 + s * 13, 45, s);
    });

    // Mouth LEDs
    ctx.save();
    ctx.fillStyle = "#34E3CB";
    ctx.shadowColor = "rgba(52,227,203,0.8)";
    ctx.shadowBlur = 3;
    if (this.p("oMouth") > 0.5) {
      ctx.beginPath();
      ctx.arc(65, 58, 1.8, 0, Math.PI * 2);
      ctx.fill();
    } else {
      for (let i = 0; i < 5; i++) {
        const u = (i - 2) / 2;
        const curve = this.p("smile") * 2 * (1 - u * u);
        const talk = this.p("mouth") * (0.55 + 0.45 * Math.sin(i * 1.9 + now * 16)) * (1 - Math.abs(u) * 0.35);
        const h = 1.6 + 5.5 * Math.max(0, talk);
        rr(ctx, 60 + u * 8 - 1, 58 - h / 2 + curve - 1, 2, h, 1);
        ctx.fill();
      }
    }
    ctx.restore();

    if (withDots && this.p("dots") > 0.05) {
      for (let d = 0; d < 3; d++) {
        const ang = now * 3 * (motion || 0.001) + d * ((Math.PI * 2) / 3);
        const depth = (Math.sin(ang) + 1) / 2;
        ctx.beginPath();
        ctx.arc(98 + Math.cos(ang) * 8, 14 + Math.sin(ang) * 3, 1.8 + 1.3 * depth, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(232,155,90," + Math.min(1, this.p("dots") * (0.45 + 0.55 * depth)).toFixed(3) + ")";
        ctx.fill();
      }
    }
  }

  private drawEye(ctx: CanvasRenderingContext2D, cx: number, cy: number, side: number) {
    const R = 8.6;
    const gaze = this.gaze;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#04080A";
    ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);

    const gx = Math.max(-1, Math.min(1, gaze.x - side * 0.06));
    const gy = Math.max(-1, Math.min(1, gaze.y));
    const ix = cx + gx * R * 0.4;
    const iy = cy + gy * R * 0.38;
    ctx.save();
    ctx.translate(ix, iy);
    ctx.scale(1 - 0.2 * Math.abs(gx), 1 - 0.2 * Math.abs(gy));
    const irisR = R * 0.78;
    ctx.beginPath();
    ctx.arc(0, 0, irisR, 0, Math.PI * 2);
    ctx.fillStyle = this.irisGradient(ctx, irisR);
    ctx.fill();
    const pr = irisR * (0.24 + 0.42 * Math.max(0, Math.min(1, this.p("pupil"))));
    ctx.beginPath();
    ctx.arc(0, 0, pr, 0, Math.PI * 2);
    ctx.fillStyle = "#020405";
    ctx.fill();
    ctx.restore();

    // Glints stay put while the eye moves.
    ctx.beginPath();
    ctx.ellipse(cx - R * 0.36, cy - R * 0.4, R * 0.24, R * 0.16, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + R * 0.35, cy + R * 0.32, R * 0.09, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fill();

    // Lids
    const upper = Math.min(1, Math.max(0, this.p("upper")) + this.blinkAmt);
    const lower = Math.min(1, Math.max(0, this.p("lower")));
    const uy = cy - R + 2 * R * upper * (lower > 0.3 && upper > 0.55 ? 0.62 : 1);
    ctx.fillStyle = "#3F484C";
    ctx.fillRect(cx - R - 1, cy - R - 1, 2 * R + 2, uy - (cy - R - 1));
    if (lower > 0.03) {
      const ly = cy + R - 2 * R * lower;
      ctx.beginPath();
      ctx.moveTo(cx - R - 1, ly + 2);
      ctx.quadraticCurveTo(cx, ly - 4 * lower, cx + R + 1, ly + 2);
      ctx.lineTo(cx + R + 1, cy + R + 1);
      ctx.lineTo(cx - R - 1, cy + R + 1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#7C878C";
    ctx.stroke();
  }
}
