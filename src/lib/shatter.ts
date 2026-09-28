import { Delaunay } from 'd3-delaunay';

export type Pt = [number, number];
export type TabStyle = 'dovetail' | 'arrow' | 'mixed';

export interface ShatterParams {
  width: number; // mm
  height: number; // mm
  pieces: number;
  impact: Pt; // mm, inside the sheet
  concentration: number; // 0..1 — how much pieces shrink towards the impact
  tabSize: number; // mm, 0 disables tabs
  tabStyle: TabStyle;
  seed: number;
}

export interface ShatterResult {
  /** Interior cut lines (each shared edge once, with its tab). */
  cuts: Pt[][];
  /** Closed outline of every piece, tabs included (for preview only). */
  pieces: Pt[][];
  tabCount: number;
  /** Total cut length in mm, including the outer frame. */
  cutLength: number;
}

// ---------------------------------------------------------------------------
// Random

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pointSegDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function cross(o: Pt, a: Pt, b: Pt) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function segmentsIntersect(p1: Pt, p2: Pt, q1: Pt, q2: Pt): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segSegDist(p1: Pt, p2: Pt, q1: Pt, q2: Pt): number {
  if (segmentsIntersect(p1, p2, q1, q2)) return 0;
  return Math.min(
    pointSegDist(p1, q1, q2),
    pointSegDist(p2, q1, q2),
    pointSegDist(q1, p1, p2),
    pointSegDist(q2, p1, p2),
  );
}

function polylineLength(pl: Pt[]) {
  let l = 0;
  for (let i = 1; i < pl.length; i++) l += dist(pl[i - 1], pl[i]);
  return l;
}

// ---------------------------------------------------------------------------
// Seeds: a polar lattice around the impact whose spacing grows with distance.
// Rays drift slightly and split when they get too far apart, like real cracks.

function generateSeeds(p: ShatterParams, lambda: number, limit = Infinity): Pt[] {
  const rng = mulberry32(p.seed);
  const { width: W, height: H } = p;
  const [cx, cy] = p.impact;
  const diag = Math.hypot(W, H);
  const k = p.concentration * 9;
  const size = (r: number) => lambda * (1 + (k * r) / diag);

  const rMax = Math.max(
    Math.hypot(cx, cy),
    Math.hypot(W - cx, cy),
    Math.hypot(cx, H - cy),
    Math.hypot(W - cx, H - cy),
  );

  const pts: Pt[] = [[cx, cy]];
  let r = size(0) * 1.05;
  const n0 = Math.max(5, Math.round((2 * Math.PI * r) / size(r)));
  const rot = rng() * Math.PI * 2;
  let angles: number[] = [];
  for (let i = 0; i < n0; i++) {
    angles.push(rot + ((i + (rng() - 0.5) * 0.5) * 2 * Math.PI) / n0);
  }

  while (r < rMax + size(r)) {
    const s = size(r);
    // Split rays whose gap has grown too wide.
    const next: number[] = [];
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i];
      const b = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
      next.push(a);
      if ((b - a) * r > 1.3 * s) next.push(a + (b - a) * (0.35 + rng() * 0.3));
    }
    angles = next;

    for (let i = 0; i < angles.length; i++) {
      angles[i] += (rng() - 0.5) * 0.14 * (s / r);
      const rr = r + (rng() - 0.5) * 0.35 * s;
      const x = cx + rr * Math.cos(angles[i]);
      const y = cy + rr * Math.sin(angles[i]);
      if (x > 0 && x < W && y > 0 && y < H) pts.push([x, y]);
    }
    if (pts.length > limit) break;
    r += s * 1.25;
  }
  return pts;
}

function seedsForCount(p: ShatterParams): Pt[] {
  const target = Math.max(2, Math.round(p.pieces));
  const limit = target * 4;
  let lo = Math.sqrt((p.width * p.height) / target) / 8;
  let hi = Math.hypot(p.width, p.height);
  let best = generateSeeds(p, lo, limit);
  for (let i = 0; i < 30; i++) {
    const mid = Math.sqrt(lo * hi);
    const pts = generateSeeds(p, mid, limit);
    if (pts.length >= target) {
      lo = mid;
      best = pts;
    } else {
      hi = mid;
    }
  }
  // Drop the surplus at random (never the impact seed) — the merged cells
  // add some welcome irregularity.
  const rng = mulberry32(p.seed ^ 0x9e3779b9);
  while (best.length > target) {
    best.splice(1 + Math.floor(rng() * (best.length - 1)), 1);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Planar graph from the clipped Voronoi diagram

interface Edge {
  a: number;
  b: number;
  cells: number[];
  poly: Pt[];
}

const MIN_EDGE = 1.2; // mm — shorter interior edges get collapsed

function buildGraph(seeds: Pt[], W: number, H: number) {
  const voronoi = Delaunay.from(seeds).voronoi([0, 0, W, H]);
  const verts: Pt[] = [];
  const index = new Map<string, number>();
  const vid = (pt: Pt) => {
    const key = `${Math.round(pt[0] * 1e5)},${Math.round(pt[1] * 1e5)}`;
    let id = index.get(key);
    if (id === undefined) {
      id = verts.length;
      verts.push([pt[0], pt[1]]);
      index.set(key, id);
    }
    return id;
  };

  let cells: number[][] = [];
  for (let i = 0; i < seeds.length; i++) {
    const poly = voronoi.cellPolygon(i);
    if (!poly) continue;
    cells.push(poly.slice(0, -1).map((q) => vid(q as Pt)));
  }

  const eps = 1e-6;
  const onX = (v: Pt) => v[0] < eps || v[0] > W - eps;
  const onY = (v: Pt) => v[1] < eps || v[1] > H - eps;

  // Collapse very short interior edges (union-find), keeping border points on the border.
  const parent = verts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const edgeCount = new Map<string, number>();
  for (const c of cells) {
    for (let i = 0; i < c.length; i++) {
      const u = c[i];
      const v = c[(i + 1) % c.length];
      const k = u < v ? `${u}-${v}` : `${v}-${u}`;
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of edgeCount) {
    if (n !== 2) continue;
    const [u, v] = k.split('-').map(Number);
    if (dist(verts[u], verts[v]) < MIN_EDGE) parent[find(u)] = find(v);
  }
  const clusters = new Map<number, number[]>();
  verts.forEach((_, i) => {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r)!.push(i);
  });
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const pick =
      members.find((m) => onX(verts[m]) && onY(verts[m])) ??
      members.find((m) => onX(verts[m]) || onY(verts[m]));
    let pos: Pt;
    if (pick !== undefined) pos = [...verts[pick]] as Pt;
    else {
      pos = [0, 0];
      for (const m of members) {
        pos[0] += verts[m][0] / members.length;
        pos[1] += verts[m][1] / members.length;
      }
    }
    for (const m of members) verts[m] = pos;
  }

  cells = cells
    .map((c) => {
      const out: number[] = [];
      for (const v of c.map(find)) if (out[out.length - 1] !== v) out.push(v);
      while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
      return out;
    })
    .filter((c) => c.length >= 3);

  const edges = new Map<string, Edge>();
  cells.forEach((c, ci) => {
    for (let i = 0; i < c.length; i++) {
      const u = c[i];
      const v = c[(i + 1) % c.length];
      const k = u < v ? `${u}-${v}` : `${v}-${u}`;
      let e = edges.get(k);
      if (!e) {
        e = { a: Math.min(u, v), b: Math.max(u, v), cells: [], poly: [] };
        edges.set(k, e);
      }
      e.cells.push(ci);
    }
  });
  for (const e of edges.values()) e.poly = [verts[e.a], verts[e.b]];

  return { verts, cells, edges };
}

// ---------------------------------------------------------------------------
// Tabs

/** Tab outline in local coords: u along the edge, v into the receiving piece. */
function tabShape(style: 'dovetail' | 'arrow', t: number, uc: number, skew: number): Pt[] {
  const neck = 0.55 * t;
  const head = 1.2 * t;
  const h = 0.95 * t;
  if (style === 'dovetail') {
    return [
      [uc - neck / 2, 0],
      [uc - head / 2 + skew, h],
      [uc + head / 2 + skew, h],
      [uc + neck / 2, 0],
    ];
  }
  const sh = 0.42 * h;
  return [
    [uc - neck / 2, 0],
    [uc - neck / 2, sh],
    [uc - head / 2, sh],
    [uc + skew * 1.5, h * 1.08],
    [uc + head / 2, sh],
    [uc + neck / 2, sh],
    [uc + neck / 2, 0],
  ];
}

function addTabs(
  p: ShatterParams,
  graph: ReturnType<typeof buildGraph>,
  rng: () => number,
): number {
  const { verts, cells, edges } = graph;
  if (p.tabSize <= 0) return 0;

  const cellSegs: [Pt, Pt, string][][] = cells.map((c) =>
    c.map((u, i) => {
      const v = c[(i + 1) % c.length];
      return [verts[u], verts[v], u < v ? `${u}-${v}` : `${v}-${u}`] as [Pt, Pt, string];
    }),
  );
  const centroids: Pt[] = cells.map((c) => {
    let x = 0;
    let y = 0;
    for (const v of c) {
      x += verts[v][0];
      y += verts[v][1];
    }
    return [x / c.length, y / c.length];
  });
  const intrusions: [Pt, Pt][][] = cells.map(() => []);

  const interior = [...edges.entries()].filter(([, e]) => e.cells.length === 2);
  for (let i = interior.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [interior[i], interior[j]] = [interior[j], interior[i]];
  }

  let count = 0;
  for (const [key, e] of interior) {
    const A = verts[e.a];
    const B = verts[e.b];
    const L = dist(A, B);
    const ux = (B[0] - A[0]) / L;
    const uy = (B[1] - A[1]) / L;
    const style: 'dovetail' | 'arrow' =
      p.tabStyle === 'mixed' ? (rng() < 0.5 ? 'dovetail' : 'arrow') : p.tabStyle;
    const ucJitter = 0.5 + (rng() - 0.5) * 0.25;
    const skewJitter = (rng() - 0.5) * 0.35;
    const firstSide = rng() < 0.5 ? 0 : 1;

    let placed = false;
    for (const scale of [1, 0.8, 0.62]) {
      const t = p.tabSize * scale;
      const clearance = Math.max(0.8, 0.32 * t);
      if (L < 1.2 * t + 2 * clearance) continue;
      for (const side of [firstSide, 1 - firstSide]) {
        const tgt = e.cells[side];
        const src = e.cells[1 - side];
        // Normal pointing into the target cell.
        let nx = -uy;
        let ny = ux;
        const c = centroids[tgt];
        if ((c[0] - A[0]) * nx + (c[1] - A[1]) * ny < 0) {
          nx = -nx;
          ny = -ny;
        }
        const local = tabShape(style, t, L * ucJitter, skewJitter * t);
        const world: Pt[] = local.map(([u, v]) => [A[0] + ux * u + nx * v, A[1] + uy * u + ny * v]);

        const segs: [Pt, Pt][] = [];
        for (let s = 1; s < world.length; s++) segs.push([world[s - 1], world[s]]);

        const obstacles: [Pt, Pt][] = [
          ...cellSegs[tgt].filter((s) => s[2] !== key).map((s) => [s[0], s[1]] as [Pt, Pt]),
          ...intrusions[tgt],
          ...intrusions[src],
        ];
        const ok = segs.every(([s0, s1]) =>
          obstacles.every(([o0, o1]) => segSegDist(s0, s1, o0, o1) >= clearance),
        );
        if (!ok) continue;

        e.poly = [A, ...world, B];
        intrusions[tgt].push(...segs);
        placed = true;
        count++;
        break;
      }
      if (placed) break;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Chaining: join edge polylines end-to-end so the laser makes fewer jumps.

function chain(polys: Pt[][]): Pt[][] {
  const k = (p: Pt) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const at = new Map<string, number[]>();
  polys.forEach((pl, i) => {
    for (const end of [pl[0], pl[pl.length - 1]]) {
      const key = k(end);
      if (!at.has(key)) at.set(key, []);
      at.get(key)!.push(i);
    }
  });
  const used = new Array(polys.length).fill(false);
  const out: Pt[][] = [];
  // Start from odd-degree endpoints first so chains run end to end.
  const order = polys
    .map((_, i) => i)
    .sort((a, b) => (at.get(k(polys[b][0]))!.length % 2) - (at.get(k(polys[a][0]))!.length % 2));
  for (const start of order) {
    if (used[start]) continue;
    used[start] = true;
    const line = [...polys[start]];
    for (;;) {
      const endKey = k(line[line.length - 1]);
      const nextId = at.get(endKey)!.find((j) => !used[j]);
      if (nextId === undefined) break;
      used[nextId] = true;
      const pl = polys[nextId];
      const seg = k(pl[0]) === endKey ? pl : [...pl].reverse();
      line.push(...seg.slice(1));
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------

export function shatter(p: ShatterParams): ShatterResult {
  const seeds = seedsForCount(p);
  const graph = buildGraph(seeds, p.width, p.height);
  const tabCount = addTabs(p, graph, mulberry32(p.seed ^ 0x51ed270b));

  const pieces = graph.cells.map((c) => {
    const outline: Pt[] = [];
    for (let i = 0; i < c.length; i++) {
      const u = c[i];
      const v = c[(i + 1) % c.length];
      const e = graph.edges.get(u < v ? `${u}-${v}` : `${v}-${u}`)!;
      const pl = u === e.a ? e.poly : [...e.poly].reverse();
      outline.push(...pl.slice(0, -1));
    }
    return outline;
  });

  const interior = [...graph.edges.values()].filter((e) => e.cells.length === 2).map((e) => e.poly);
  const cuts = chain(interior);
  const cutLength =
    cuts.reduce((acc, pl) => acc + polylineLength(pl), 0) + 2 * (p.width + p.height);

  return { cuts, pieces, tabCount, cutLength };
}

// ---------------------------------------------------------------------------

const f = (n: number) => +n.toFixed(3);
const pathD = (pl: Pt[], close = false) =>
  'M' + pl.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + (close ? 'Z' : '');

export function toSvg(
  p: ShatterParams,
  r: ShatterResult,
  opts: { strokeWidth: number; frame: boolean },
): string {
  const { width: W, height: H } = p;
  const lines = r.cuts.map((pl) => `  <path d="${pathD(pl)}"/>`);
  if (opts.frame) lines.unshift(`  <rect x="0" y="0" width="${f(W)}" height="${f(H)}"/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Broken glass puzzle · ${r.pieces.length} pieces · ${W}×${H} mm · seed ${p.seed} -->
<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">
<g fill="none" stroke="#000000" stroke-width="${opts.strokeWidth}" stroke-linejoin="round" stroke-linecap="round">
${lines.join('\n')}
</g>
</svg>
`;
}

export { pathD };
