// hero-particles.ts
// A 2D canvas layer over the hero's WebGL scene: themed particles that drift on their own and
// burst where the visitor taps. Each hero slide picks a kind; while scrolling between slides,
// new particles are drawn from both kinds in proportion, so the layer cross-fades naturally.

export type ParticleKind = "bubbles" | "sparks" | "drops";

type P = {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  max: number;
  phase: number;
  rgb: string;
};

export type ParticleSlide = { kind: ParticleKind; rgb: string };

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class HeroParticles {
  private ctx: CanvasRenderingContext2D;
  private ps: P[] = [];
  private w = 0;
  private h = 0;
  private dpr = 1;
  private spawnAcc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  private canvas: HTMLCanvasElement;
  private slides: ParticleSlide[];
  private getBlend: () => number;

  constructor(canvas: HTMLCanvasElement, slides: ParticleSlide[], getBlend: () => number) {
    this.canvas = canvas;
    this.slides = slides;
    this.getBlend = getBlend;
    this.ctx = canvas.getContext("2d")!;
    this.resize();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  private get cap() {
    return this.w < 700 ? 55 : 110;
  }

  /** The slide whose particles to spawn, chosen in proportion to the scroll position. */
  private pickSlide(): ParticleSlide {
    const b = Math.max(0, Math.min(this.getBlend(), this.slides.length - 1));
    const i = Math.floor(b);
    const f = b - i;
    const next = this.slides[Math.min(i + 1, this.slides.length - 1)];
    return Math.random() < f ? next : this.slides[i];
  }

  private make(s: ParticleSlide, x: number, y: number, burst = false): P {
    const base = { kind: s.kind, rgb: s.rgb, x, y, life: 0, phase: rand(0, Math.PI * 2) };
    const out = burst ? rand(80, 260) : 0;
    const a = rand(0, Math.PI * 2);
    switch (s.kind) {
      case "bubbles":
        return { ...base, vx: Math.cos(a) * out, vy: (burst ? Math.sin(a) * out : 0) - rand(25, 60), r: rand(2, 7), max: rand(5, 10) };
      case "sparks":
        return { ...base, vx: Math.cos(a) * out + rand(-6, 6), vy: (burst ? Math.sin(a) * out : 0) - rand(8, 22), r: rand(1, 2.6), max: rand(4, 8) };
      case "drops":
        return { ...base, vx: Math.cos(a) * out * 0.6 + rand(-5, 5), vy: (burst ? Math.sin(a) * out * 0.6 : 0) + rand(-6, 10), r: rand(4, 14), max: rand(6, 11) };
    }
  }

  /** Burst of the current kind at a point (CSS pixels within the canvas). */
  burst(x: number, y: number) {
    const s = this.pickSlide();
    const n = this.w < 700 ? 16 : 26;
    for (let i = 0; i < n; i++) this.ps.push(this.make(s, x, y, true));
    // keep within budget: drop the oldest ambient particles first
    if (this.ps.length > this.cap * 1.8) this.ps.splice(0, this.ps.length - Math.round(this.cap * 1.8));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (t: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min((t - this.last) / 1000, 0.05);
      this.last = t;
      this.step(dt);
      this.draw(t / 1000);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private step(dt: number) {
    // ambient spawning, about 8 per second
    this.spawnAcc += dt * 8;
    while (this.spawnAcc >= 1 && this.ps.length < this.cap) {
      this.spawnAcc -= 1;
      const s = this.pickSlide();
      const y = s.kind === "drops" ? rand(0, this.h) : rand(this.h * 0.55, this.h + 10);
      this.ps.push(this.make(s, rand(0, this.w), y));
    }
    if (this.spawnAcc > 1) this.spawnAcc = 1;

    // Particles of a kind that is no longer on screen age three times faster, so the
    // layer follows the words instead of piling up old bubbles.
    const b = Math.max(0, Math.min(this.getBlend(), this.slides.length - 1));
    const live = new Set<ParticleKind>();
    this.slides.forEach((s, i) => {
      if (1 - Math.abs(b - i) > 0.05) live.add(s.kind);
    });
    for (const p of this.ps) {
      p.life += live.has(p.kind) ? dt : dt * 3;
      // bursts slow down; bubbles wobble, drops swirl
      p.vx *= 1 - dt * 1.6;
      if (p.kind === "bubbles") p.vy = p.vy * (1 - dt * 0.8) - 30 * dt;
      p.x += (p.vx + (p.kind === "bubbles" ? Math.sin(p.life * 3 + p.phase) * 12 : 0)) * dt;
      p.y += (p.vy + (p.kind === "drops" ? Math.cos(p.life * 0.9 + p.phase) * 6 : 0)) * dt;
      if (p.kind !== "bubbles") p.vy *= 1 - dt * 0.6;
    }
    this.ps = this.ps.filter((p) => p.life < p.max && p.y > -40 && p.y < this.h + 60 && p.x > -60 && p.x < this.w + 60);
  }

  private draw(time: number) {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    for (const p of this.ps) {
      // fade in and out over the lifetime
      const k = Math.min(p.life / 0.6, 1, (p.max - p.life) / 1.2);
      if (k <= 0) continue;
      if (p.kind === "bubbles") {
        ctx.globalAlpha = 0.55 * k;
        ctx.strokeStyle = `rgba(${p.rgb},0.9)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.8 * k;
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.beginPath();
        ctx.arc(p.x - p.r * 0.35, p.y - p.r * 0.35, Math.max(p.r * 0.22, 0.8), 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === "sparks") {
        const tw = 0.6 + 0.4 * Math.sin(time * 6 + p.phase);
        ctx.globalAlpha = k * tw;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 5);
        g.addColorStop(0, `rgba(255,240,200,1)`);
        g.addColorStop(0.25, `rgba(${p.rgb},0.8)`);
        g.addColorStop(1, `rgba(${p.rgb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // a glossy drop: light rim on top, wine-coloured glow below
        ctx.globalAlpha = 0.75 * k;
        const g = ctx.createRadialGradient(p.x - p.r * 0.3, p.y - p.r * 0.35, 0, p.x, p.y, p.r);
        g.addColorStop(0, `rgba(255,225,235,0.95)`);
        g.addColorStop(0.35, `rgba(${p.rgb},0.85)`);
        g.addColorStop(1, `rgba(${p.rgb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}
