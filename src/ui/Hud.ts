import { INK, PAPER, plate, chevron, inkText, steppedBar, diagonalStripes, gauge, shake, fmtTime, RANK_COLORS } from './UiKit';

export interface HudState {
  screen: 'title' | 'intro' | 'select' | 'play' | 'boss' | 'results';
  time: number; timeLimit: number; elapsed: number;
  speed: number; maxSpeed: number;
  health: number; maxHealth: number;
  boost: number; boostMax: number;
  fragments: number; shards: number; orbs: number; pickupTotal: number;
  combo: number; style: number; rank: number;
  objective: string; district: string; seed: string;
  bossHp: number; bossPhase: number; bossName: string; bossActive: boolean;
  message: string; messageFrom: string; messageT: number;
  paceDelta: number; progress: number;
  results: any; selectIndex: number; selectCards: any[];
  best: number | null; flashRank: number;
}

const ACCENT = '#4de8ff';
const HOT = '#ff3d9a';
const WARN = '#ffb03a';

/**
 * HUD AND SCREENS
 * All interface pixels are painted here on a 2D canvas over the frame, in the same ink
 * and palette language as the game. The stage timer is the loudest element by design:
 * it grows, shakes and bleeds colour into the frame as it runs out.
 */
export class Hud {
  private g: CanvasRenderingContext2D;
  private t = 0;
  private styleScale = 1;
  private timerScale = 1;
  private lastTick = -1;
  urgency = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.g = canvas.getContext('2d')!;
  }

  resize(w: number, h: number, dpr: number) {
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  draw(dt: number, s: HudState) {
    const g = this.g;
    const W = this.canvas.width, H = this.canvas.height;
    const k = H / 1080;
    this.t += dt;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.save();
    g.scale(k, k);
    const w = W / k, h = 1080;

    if (s.screen === 'title') this.title(g, w, h, s);
    else if (s.screen === 'intro') this.intro(g, w, h, s);
    else if (s.screen === 'select') this.select(g, w, h, s);
    else if (s.screen === 'results') this.results(g, w, h, s, dt);
    else this.play(g, w, h, s, dt);
    g.restore();
  }

  // ---------------------------------------------------------------- gameplay
  private play(g: CanvasRenderingContext2D, w: number, h: number, s: HudState, dt: number) {
    const left = s.time;
    const low = left < 20;
    this.urgency = left < 30 ? Math.min(1, (30 - left) / 30) : 0;

    // --- STAGE TIMER: the most important number on screen ---
    const tick = Math.floor(left);
    if (tick !== this.lastTick) { this.lastTick = tick; if (low) this.timerScale = 1.16; }
    this.timerScale += (1 - this.timerScale) * Math.min(1, dt * 9);
    const [sx, sy] = shake(this.t, low ? (1 - left / 20) * 7 : 0);
    g.save();
    g.translate(w / 2 + sx, 34 + sy);
    g.scale(this.timerScale, this.timerScale);
    plate(g, -196, 0, 392, 96, 22, low ? 'rgba(90,10,34,0.82)' : 'rgba(14,9,32,0.74)');
    diagonalStripes(g, -196, 0, 392, 96, low ? HOT : ACCENT, 22, low ? 0.3 : 0.14, this.t * 40);
    inkText(g, fmtTime(left), 8, 74, 78, low ? '#fff0f4' : PAPER, 'center', 900, 8, -0.1);
    inkText(g, 'TIME', -168, 30, 22, low ? HOT : ACCENT, 'left', 900, 4, -0.1);
    g.restore();

    // Pace: is the player gaining or losing against the clock?
    const pace = s.paceDelta;
    const paceCol = pace >= 0 ? '#b6ff3d' : HOT;
    plate(g, w / 2 - 118, 138, 236, 40, 14, 'rgba(11,7,24,0.62)');
    inkText(g, (pace >= 0 ? 'ON PACE +' : 'BEHIND ') + Math.abs(pace).toFixed(1) + 's', w / 2, 167, 26, paceCol, 'center', 900, 4, -0.08);
    steppedBar(g, w / 2 - 220, 186, 440, 14, s.progress, 24, ACCENT, 'rgba(11,7,24,0.5)', 6);

    // --- HEALTH + BOOST (left) ---
    for (let i = 0; i < s.maxHealth; i++) {
      const on = i < s.health;
      chevron(g, 44 + i * 42, 46, 46, 40, on ? HOT : 'rgba(255,61,154,0.16)');
    }
    inkText(g, 'VITALS', 46, 116, 20, PAPER, 'left', 900, 4, -0.1);
    steppedBar(g, 44, 128, 268, 26, s.boost / s.boostMax, 12, WARN, 'rgba(11,7,24,0.6)', 10);
    inkText(g, 'BOOST', 50, 148, 17, INK, 'left', 900, 0, -0.1);

    // --- COLLECTIBLES ---
    const collected = s.fragments + s.shards + s.orbs;
    plate(g, 44, 172, 268, 46, 12, 'rgba(11,7,24,0.62)');
    inkText(g, 'DATA  ' + collected + '/' + s.pickupTotal, 58, 205, 26, ACCENT, 'left', 900, 4, -0.08);

    // --- OBJECTIVE + DISTRICT ---
    plate(g, 44, 232, 380, 44, 12, 'rgba(11,7,24,0.5)');
    inkText(g, s.district + '  //  ' + s.objective, 58, 263, 22, PAPER, 'left', 900, 4, -0.08);

    // --- SPEED (bottom right) ---
    const cx = w - 168, cy = h - 168;
    const sp = Math.min(1, s.speed / s.maxSpeed);
    gauge(g, cx, cy, 104, sp, 22, sp > 0.8 ? HOT : ACCENT, 'rgba(11,7,24,0.55)');
    inkText(g, String(Math.round(s.speed)), cx, cy + 18, 76, PAPER, 'center', 900, 7, -0.1);
    inkText(g, 'M/S', cx, cy + 54, 22, ACCENT, 'center', 900, 4, -0.1);

    // --- STYLE / COMBO ---
    if (s.style > 6 || s.combo > 0) {
      this.styleScale += (1 - this.styleScale) * Math.min(1, dt * 8);
      const rk = ['D', 'C', 'B', 'A', 'S', 'SS'][Math.min(5, s.rank)];
      g.save();
      g.translate(w - 96, h - 360);
      g.scale(this.styleScale, this.styleScale);
      inkText(g, rk, 0, 0, 96, RANK_COLORS[rk[0]] || PAPER, 'center', 900, 8, -0.14);
      inkText(g, Math.round(s.style) + ' STYLE', 0, 40, 26, PAPER, 'center', 900, 5, -0.1);
      if (s.combo > 1) inkText(g, 'x' + s.combo + ' CHAIN', 0, 74, 24, HOT, 'center', 900, 5, -0.1);
      g.restore();
    }

    // --- BOSS BAR ---
    if (s.bossActive) {
      plate(g, w / 2 - 380, h - 148, 760, 72, 18, 'rgba(11,7,24,0.76)');
      inkText(g, s.bossName, w / 2 - 356, h - 112, 26, HOT, 'left', 900, 4, -0.08);
      inkText(g, 'PHASE ' + s.bossPhase, w / 2 + 356, h - 112, 24, WARN, 'right', 900, 4, -0.08);
      steppedBar(g, w / 2 - 356, h - 104, 712, 24, s.bossHp, 30, HOT, 'rgba(40,10,30,0.7)', 8);
    }

    // --- TRANSMISSION ---
    if (s.messageT > 0 && s.message) {
      const revealed = Math.floor(Math.min(1, (2.6 - s.messageT) * 26) * s.message.length);
      const txt = s.message.slice(0, Math.max(0, revealed));
      const bw = Math.min(900, 60 + s.message.length * 15);
      plate(g, w / 2 - bw / 2, h - 262, bw, 82, 16, 'rgba(8,5,20,0.86)', ACCENT, 3);
      inkText(g, s.messageFrom, w / 2 - bw / 2 + 22, h - 230, 20, ACCENT, 'left', 900, 3, -0.06);
      inkText(g, txt, w / 2 - bw / 2 + 22, h - 198, 26, PAPER, 'left', 900, 4, 0);
    }

    inkText(g, 'SEED ' + s.seed, 44, h - 40, 20, 'rgba(255,243,224,0.6)', 'left', 900, 3, -0.08);
  }

  // ------------------------------------------------------------------ screens
  private backdrop(g: CanvasRenderingContext2D, w: number, h: number, alpha = 0.55) {
    g.fillStyle = 'rgba(6,4,16,' + alpha + ')';
    g.fillRect(0, 0, w, h);
    diagonalStripes(g, 0, 0, w, h, '#7b3bff', 60, 0.14, this.t * 22);
  }

  private title(g: CanvasRenderingContext2D, w: number, h: number, s: HudState) {
    this.backdrop(g, w, h, 0.34);
    const y = h * 0.34;
    plate(g, w / 2 - 520, y - 96, 1040, 150, 40, 'rgba(11,7,24,0.72)');
    inkText(g, 'VOLTBOROUGH', w / 2, y + 22, 132, PAPER, 'center', 900, 12, -0.14);
    inkText(g, 'A HIGH-SPEED COURIER RUN THROUGH A CITY THAT REMEMBERS YOU', w / 2, y + 96, 26, ACCENT, 'center', 900, 5, -0.08);
    const pulse = 0.6 + 0.4 * Math.sin(this.t * 3.4);
    inkText(g, 'PRESS ENTER OR CLICK TO BEGIN', w / 2, h * 0.68, 34, 'rgba(255,243,224,' + pulse + ')', 'center', 900, 6, -0.1);
    inkText(g, 'WASD MOVE   SPACE JUMP   SHIFT DASH   C ATTACK   V BOOST   CTRL SLIDE', w / 2, h * 0.78, 22, PAPER, 'center', 900, 4, -0.06);
    inkText(g, 'SEED ' + s.seed, w / 2, h * 0.84, 22, WARN, 'center', 900, 4, -0.06);
  }

  private intro(g: CanvasRenderingContext2D, w: number, h: number, s: HudState) {
    this.backdrop(g, w, h, 0.42);
    plate(g, 90, h * 0.3, 720, 300, 40, 'rgba(11,7,24,0.8)');
    inkText(g, 'VEX', 130, h * 0.3 + 110, 118, HOT, 'left', 900, 10, -0.14);
    inkText(g, 'COURIER CLASS  //  BUILD 07', 132, h * 0.3 + 158, 26, ACCENT, 'left', 900, 5, -0.08);
    inkText(g, 'PURPOSE: UNLOGGED', 132, h * 0.3 + 212, 30, PAPER, 'left', 900, 5, -0.08);
    inkText(g, 'ORIGIN: HALCYON, ARCHIVE INCOMPLETE', 132, h * 0.3 + 258, 26, PAPER, 'left', 900, 5, -0.08);
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 4);
    inkText(g, 'PRESS ENTER', w - 120, h - 120, 34, 'rgba(255,243,224,' + pulse + ')', 'right', 900, 6, -0.1);
  }

  private select(g: CanvasRenderingContext2D, w: number, h: number, s: HudState) {
    this.backdrop(g, w, h, 0.5);
    inkText(g, 'CHOOSE A BOROUGH', w / 2, 190, 72, PAPER, 'center', 900, 8, -0.12);
    inkText(g, 'EVERY SEED BUILDS A DIFFERENT CITY. SAME SEED, SAME CITY, ALWAYS.', w / 2, 240, 24, ACCENT, 'center', 900, 4, -0.06);
    const cards = s.selectCards || [];
    const cw = 420, ch = 460, gap = 54;
    const total = cards.length * cw + (cards.length - 1) * gap;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const x = w / 2 - total / 2 + i * (cw + gap);
      const sel = i === s.selectIndex;
      const y = h * 0.32 + (sel ? -18 : 0);
      plate(g, x, y, cw, ch, 34, sel ? 'rgba(38,16,74,0.94)' : 'rgba(11,7,24,0.76)', sel ? ACCENT : INK, sel ? 6 : 4);
      diagonalStripes(g, x, y, cw, 120, sel ? HOT : '#7b3bff', 30, 0.24, this.t * 30 + i * 20);
      inkText(g, c.name, x + 34, y + 78, 44, sel ? PAPER : '#cfc4f2', 'left', 900, 6, -0.1);
      inkText(g, 'SEED  ' + c.seed, x + 34, y + 128, 24, WARN, 'left', 900, 4, -0.06);
      inkText(g, c.distance + ' M', x + 34, y + 210, 62, ACCENT, 'left', 900, 7, -0.1);
      inkText(g, 'TIMER  ' + c.timer + 's', x + 34, y + 268, 26, PAPER, 'left', 900, 4, -0.06);
      inkText(g, 'MODULES  ' + c.modules, x + 34, y + 306, 26, PAPER, 'left', 900, 4, -0.06);
      inkText(g, 'ENEMIES  ' + c.enemies, x + 34, y + 344, 26, PAPER, 'left', 900, 4, -0.06);
      inkText(g, 'DATA  ' + c.pickups, x + 34, y + 382, 26, PAPER, 'left', 900, 4, -0.06);
      if (c.best) inkText(g, 'BEST  ' + fmtTime(c.best), x + 34, y + 424, 26, HOT, 'left', 900, 4, -0.06);
      if (sel) inkText(g, 'ENTER', x + cw - 34, y + 424, 30, ACCENT, 'right', 900, 5, -0.1);
    }
    inkText(g, 'A / D SELECT     ENTER START     R NEW SEEDS', w / 2, h - 90, 26, PAPER, 'center', 900, 5, -0.08);
  }

  private results(g: CanvasRenderingContext2D, w: number, h: number, s: HudState, dt: number) {
    this.backdrop(g, w, h, 0.62);
    const r = s.results || {};
    const rank = r.rank || 'C';
    inkText(g, r.cleared ? 'STAGE CLEAR' : 'RUN ENDED', w / 2, 170, 76, r.cleared ? PAPER : HOT, 'center', 900, 9, -0.12);
    const pop = 1 + Math.max(0, s.flashRank) * 0.5;
    g.save();
    g.translate(w * 0.26, h * 0.5);
    g.scale(pop, pop);
    inkText(g, rank, 0, 90, 300, RANK_COLORS[rank[0]] || PAPER, 'center', 900, 16, -0.16);
    g.restore();
    inkText(g, 'RANK', w * 0.26, h * 0.5 + 150, 34, ACCENT, 'center', 900, 5, -0.1);

    const rows: [string, string][] = [
      ['TIME', fmtTime(r.time || 0)],
      ['TIME REMAINING', fmtTime(r.remaining || 0)],
      ['DATA COLLECTED', (r.collected || 0) + ' / ' + (r.pickupTotal || 0)],
      ['ENEMIES DEFEATED', String(r.kills || 0)],
      ['DAMAGE TAKEN', String(r.damage || 0)],
      ['STYLE SCORE', String(Math.round(r.style || 0))],
      ['LONGEST CHAIN', String(r.chain || 0)],
      ['TOP SPEED', Math.round(r.topSpeed || 0) + ' M/S'],
      ['SHORTCUTS FOUND', String(r.shortcuts || 0)],
      ['BOSS', r.boss ? 'DEFEATED' : 'NOT REACHED'],
    ];
    const x = w * 0.52;
    plate(g, x - 30, h * 0.24, w * 0.42, rows.length * 54 + 40, 26, 'rgba(11,7,24,0.78)');
    rows.forEach((row, i) => {
      const y = h * 0.24 + 62 + i * 54;
      inkText(g, row[0], x, y, 28, '#cfc4f2', 'left', 900, 4, -0.06);
      inkText(g, row[1], x + w * 0.4 - 60, y, 32, PAPER, 'right', 900, 5, -0.06);
    });
    if (s.best) inkText(g, 'BEST  ' + fmtTime(s.best), x, h * 0.24 + rows.length * 54 + 96, 30, HOT, 'left', 900, 5, -0.08);
    const pulse = 0.55 + 0.45 * Math.sin(this.t * 3.6);
    inkText(g, 'ENTER  RUN IT AGAIN        ESC  BOROUGH SELECT', w / 2, h - 90, 32, 'rgba(255,243,224,' + pulse + ')', 'center', 900, 6, -0.1);
  }
}
