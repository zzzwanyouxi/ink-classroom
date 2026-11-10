'use strict';

/* ==================== 常量 ==================== */
const PALETTE = ['#1c2026', '#d93a3a', '#2563eb', '#15803d', '#c2410c', '#7c3aed', '#0e7490', '#f2c200'];
const LS_KEY = 'ink-classroom-v3';
const BASE_W = 1600;
const BASE_H = 2400;
const GROW_STEP = 800;
const MAX_H = 40000;
const PAD = 10;
const WIDTHS = [1.8, 3.6, 6.4, 10];
const HIGH_MUL = 6;
const MAX_PTS = 20000;
const CALIB_KEY = 'ink-classroom-calib';
const desktop = (typeof window !== 'undefined' && window.inkDesktop) || null;

const PEN_TYPES = [
  { id: 'ballpoint', name: '圆珠笔', short: '圆珠' },
  { id: 'fountain', name: '钢笔', short: '钢笔' },
  { id: 'felt', name: '马克笔', short: '马克' },
  { id: 'highlighter', name: '荧光笔', short: '荧光' },
];

/* ==================== 状态 ==================== */
let state = { notebooks: [], sel: { nb: '', sec: '', page: '' }, ui: null };
let pens = [
  { type: 'ballpoint', color: '#1c2026', w: 1 },
  { type: 'fountain', color: '#2563eb', w: 2 },
  { type: 'felt', color: '#d93a3a', w: 2 },
  { type: 'highlighter', color: '#f2c200', w: 2 },
];
let activePen = 0;
let tool = 'pen';
let shapeSnap = false;
let selection = new Set();

let dpr = 1, paneW = 0, paneH = 0, lastW = 0, lastH = 0;
let scale = 1, offsetX = 0, scrollTop = 0, zoom = 1;
let docZoom = 1, syncScroll = false;

const calib = { gamma: 1, smooth: 2 };
const hist = new Map();
const assets = new Map();
const imgCache = new Map();
let idb = null;

/* ==================== DOM ==================== */
const $ = (id) => document.getElementById(id);
const el = {
  tree: $('tree'), searchInput: $('searchInput'), newFolderBtn: $('newFolderBtn'),
  penGroup: $('penGroup'), colorGroup: $('colorGroup'), widthGroup: $('widthGroup'),
  toolGroup: $('toolGroup'), undo: $('undoBtn'), redo: $('redoBtn'), replay: $('replayBtn'),
  shapeBtn: $('shapeBtn'), importBtn: $('importBtn'), docBtn: $('docBtn'),
  exportBtn: $('exportBtn'), presentBtn: $('presentBtn'), fullBtn: $('fullBtn'),
  body: $('body'), side: $('side'), sideResizer: $('sideResizer'), edgeHot: $('edgeHot'), sideBtn: $('sideBtn'),
  docpane: $('docpane'), splitter: $('splitter'),
  docInk: $('docInk'), docCursor: $('docCursor'),
  docScroll: $('docScroll'), docPages: $('docPages'), docEmpty: $('docEmpty'),
  docname: $('docname'), syncBtn: $('syncBtn'), docZoomIn: $('docZoomIn'), docZoomOut: $('docZoomOut'),
  notepane: $('notepane'), noteScroll: $('noteScroll'), noteSpacer: $('noteSpacer'),
  bg: $('bg'), live: $('live'), penCursor: $('penCursor'), emptyhint: $('emptyhint'),
  selbar: $('selbar'), zoomIn: $('zoomIn'), wsBtn: $('wsBtn'), wsStatus: $('wsStatus'), zoomOut: $('zoomOut'), zoomLabel: $('zoomLabel'),
  fileInput: $('fileInput'), dropmask: $('dropmask'), toast: $('toast'),
  ribbon: $('ribbon'), ribbonHot: $('ribbonHot'), pinBtn: $('pinBtn'),
};
const bgCtx = el.bg.getContext('2d');
const liveCtx = el.live.getContext('2d');

/* ==================== 工具 ==================== */
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function curveP(p) { return Math.pow(clamp(p, 0.02, 1), calib.gamma); }

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('show'), 2000);
}
function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/* ==================== 模型 ==================== */
function newPage(title) {
  return { id: uid(), title: title || '第 1 页', w: BASE_W, h: BASE_H, paper: 'plain', doc: null, strokes: [] };
}
function newSection(title) { return { id: uid(), title: title || '分区 1', pages: [newPage('第 1 页')] }; }
function newNotebook(title) { return { id: uid(), title: title || '课堂笔记本', open: true, sections: [newSection('板书')] }; }

function findNotebook(id) { return state.notebooks.find((n) => n.id === id) || null; }
function findSection(id) {
  for (const n of state.notebooks) {
    const s = n.sections.find((x) => x.id === id);
    if (s) return { nb: n, sec: s };
  }
  return null;
}
function findPage(id) {
  for (const n of state.notebooks) {
    for (const s of n.sections) {
      const p = s.pages.find((x) => x.id === id);
      if (p) return { nb: n, sec: s, page: p };
    }
  }
  return null;
}
function curObj() { return findPage(state.sel.page); }
function pageNow() { const o = curObj(); return o ? o.page : null; }

function normalizePage(p) {
  if (!p.w) p.w = BASE_W;
  if (!p.h) p.h = BASE_H;
  if (!Array.isArray(p.strokes)) p.strokes = [];
  if (p.doc === undefined) p.doc = null;
  if (!Array.isArray(p.docInk)) p.docInk = [];
  if (!p.paper) p.paper = 'plain';
  p.strokes.forEach((s) => { if (!s.id) s.id = uid(); if (s.tool === 'pen') s.tool = 'ballpoint'; if (!s.pts) s.pts = []; s.bb = null; });
}

function seed() {
  const nb = newNotebook('课堂笔记本');
  state.notebooks = [nb];
  state.sel = { nb: nb.id, sec: nb.sections[0].id, page: nb.sections[0].pages[0].id };
}

/* ==================== 存档 ==================== */
let saveTimer = 0;

function uiState() {
  return {
    pens: pens, activePen: activePen, shapeSnap: shapeSnap,
    docZoom: docZoom, syncScroll: syncScroll, ribbonPinned: ribbonPinned,
    tool: tool, zoom: zoom, sidePinned: sidePinned,
    defaultPenIdx: defaultPenIdx,
    defaultPen: defaultPenIdx >= 0 && pens[defaultPenIdx]
      ? { type: pens[defaultPenIdx].type, color: pens[defaultPenIdx].color, w: pens[defaultPenIdx].w }
      : null,
    docWidth: el.docpane.style.width || '',
  };
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      state.ui = uiState();
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch (e) { /* ignore */ }
    scheduleWorkspaceSave();
  }, 350);
}

/* ==================== 工作文件夹（桌面版自动保存） ==================== */
let assetDirty = true;
let wsTimer = 0;
let wsDirPath = null;

function baseName(p) {
  if (!p) return '';
  const s = String(p);
  const a = s.lastIndexOf('/');
  const b = s.lastIndexOf(String.fromCharCode(92));
  return s.slice(Math.max(a, b) + 1);
}
function assetsObject() {
  const o = {};
  assets.forEach((v, k) => { o[k] = v; });
  return o;
}
function fmtClock(t) {
  const d = new Date(t || Date.now());
  const h = d.getHours();
  const m = d.getMinutes();
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}
function updateWsStatus(text) {
  const n = document.getElementById('wsStatus');
  if (n) n.textContent = text;
}
function scheduleWorkspaceSave() {
  if (!desktop) return;
  clearTimeout(wsTimer);
  wsTimer = setTimeout(async () => {
    try {
      state.ui = uiState();
      const r = await desktop.saveWorkspace({ state: state, assets: assetDirty ? assetsObject() : null });
      if (r && r.ok) {
        assetDirty = false;
        wsDirPath = r.dir;
        updateWsStatus('已保存 ' + fmtClock(r.at));
      } else {
        updateWsStatus('未绑定文件夹');
      }
    } catch (e) { /* ignore */ }
  }, 1200);
}
async function chooseWorkspace() {
  if (!desktop) { toast('网页版不支持文件夹保存，请用桌面版'); return; }
  try {
    const dir = await desktop.pickFolder();
    if (!dir) return;
    wsDirPath = dir;
    state.ui = uiState();
    const r = await desktop.saveWorkspace({ state: state, assets: assetsObject() });
    assetDirty = false;
    updateWsStatus('已绑定 ' + baseName(dir));
    if (r && r.ok) toast('已保存到文件夹：' + baseName(dir));
  } catch (e) {
    toast('选择文件夹失败');
  }
}

function loadCalib() {
  try {
    const raw = localStorage.getItem(CALIB_KEY);
    if (!raw) return;
    const c = JSON.parse(raw);
    if (c && c.gamma) calib.gamma = c.gamma;
    if (c && typeof c.smooth === 'number') calib.smooth = c.smooth;
  } catch (e) { /* ignore */ }
}

function normalizeState() {
  if (!state || !Array.isArray(state.notebooks) || !state.notebooks.length) return false;
    if (!state.ui || !state.ui.inkNorm2) {
      for (const nb of state.notebooks) {
        for (const sec of nb.sections) {
          for (const pg of sec.pages) {
            for (const s of (pg.docInk || [])) s.width = s.width * (1000 / 1600) / 1.6;
          }
        }
      }
      state.ui = state.ui || {};
      state.ui.inkNorm2 = 1;
    }
    for (const nb of state.notebooks) {
      for (const sec of nb.sections) {
        if (!Array.isArray(sec.pages) || !sec.pages.length) sec.pages = [newPage('第 1 页')];
        sec.pages.forEach(normalizePage);
      }
    }
    if (state.ui) {
      if (Array.isArray(state.ui.pens) && state.ui.pens.length === 4) pens = state.ui.pens;
      activePen = state.ui.activePen || 0;
      shapeSnap = !!state.ui.shapeSnap;
      docZoom = state.ui.docZoom || 1;
      syncScroll = !!state.ui.syncScroll;
      if (state.ui.tool && ['pen', 'eraser', 'lasso', 'ruler'].indexOf(state.ui.tool) >= 0) tool = state.ui.tool;
      if (typeof state.ui.defaultPenIdx === 'number' && state.ui.defaultPenIdx >= 0 && state.ui.defaultPen && state.ui.defaultPenIdx < 4) {
        defaultPenIdx = state.ui.defaultPenIdx;
        pens[defaultPenIdx] = { type: state.ui.defaultPen.type, color: state.ui.defaultPen.color, w: state.ui.defaultPen.w };
        activePen = defaultPenIdx;
        tool = 'pen';
      }
      if (state.ui.docWidth) { el.docpane.style.width = state.ui.docWidth; }
      if (state.ui.sidePinned) { sidePinned = true; el.side.classList.add('pinned', 'open'); }
    }
    if (!findPage(state.sel.page)) {
      const nb = state.notebooks[0];
      const sec = nb.sections[0];
      state.sel = { nb: nb.id, sec: sec.id, page: sec.pages[0].id };
    }
  return true;
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.notebooks) || !data.notebooks.length) return false;
    state = data;
    return normalizeState();
  } catch (e) { return false; }
}

/* ==================== 图片资源 ==================== */
function openAssetsDB() {
  return new Promise((resolve) => {
    if (!window.indexedDB) return resolve(null);
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), 1800);
    let req;
    try { req = indexedDB.open('ink-classroom-assets', 1); } catch (e) { clearTimeout(timer); return finish(null); }
    req.onupgradeneeded = () => { try { req.result.createObjectStore('assets', { keyPath: 'id' }); } catch (e) {} };
    req.onsuccess = () => { clearTimeout(timer); finish(req.result); };
    req.onerror = () => { clearTimeout(timer); finish(null); };
    req.onblocked = () => { clearTimeout(timer); finish(null); };
  });
}
async function loadAssets() {
  idb = await openAssetsDB();
  if (!idb) return;
  const all = await new Promise((resolve) => {
    try {
      const req = idb.transaction('assets', 'readonly').objectStore('assets').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
  for (const a of all) assets.set(a.id, a.dataUrl);
}
function putAsset(id, dataUrl) {
  assetDirty = true;
  assets.set(id, dataUrl);
  if (!idb) return;
  try { idb.transaction('assets', 'readwrite').objectStore('assets').put({ id: id, dataUrl: dataUrl }); } catch (e) {}
}

/* ==================== 视图 ==================== */
function recompute() {
  const p = pageNow();
  paneW = el.noteScroll.clientWidth || 0;
  paneH = el.noteScroll.clientHeight || 0;
  if (!p || !paneW) { scale = 1; offsetX = 0; return; }
  scale = (paneW - PAD * 2) / p.w * zoom;
  offsetX = (paneW - p.w * scale) / 2;
}
function updateSpacer() {
  const p = pageNow();
  if (!p) return;
  const cw = Math.max(paneW, Math.round(p.w * scale));
  el.noteSpacer.style.width = cw + 'px';
  el.noteSpacer.style.height = Math.round(p.h * scale + 80) + 'px';
}

function viewOffsetX() {
  const p = pageNow();
  if (!p) return 0;
  if (el.noteScroll.scrollWidth - el.noteScroll.clientWidth > 1) return -el.noteScroll.scrollLeft;
  return (paneW - p.w * scale) / 2;
}
function applyView(ctx) {
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offsetX, dpr * (-scrollTop));
}
function toContent(e) {
  const r = el.noteScroll.getBoundingClientRect();
  return {
    x: (e.clientX - r.left - viewOffsetX()) / scale,
    y: (e.clientY - r.top + el.noteScroll.scrollTop) / scale,
  };
}
function updateZoomLabel() { el.zoomLabel.textContent = Math.round(zoom * 100) + '%'; }

function ensureHeight() {
  const p = pageNow();
  if (!p || !scale) return;
  let maxY = 0;
  for (const s of p.strokes) {
    const b = getBB(s);
    if (b.maxY > maxY) maxY = b.maxY;
  }
  const viewH = paneH / scale;
  const need = Math.max(maxY + Math.max(600, viewH * 0.5), viewH + 400);
  if (need > p.h && p.h < MAX_H) {
    p.h = Math.min(MAX_H, Math.ceil(need / GROW_STEP) * GROW_STEP);
    updateSpacer();
  }
}
function growIfNeeded(y) {
  const p = pageNow();
  if (!p || p.h >= MAX_H) return;
  if (y > p.h - 350) {
    p.h = Math.min(MAX_H, Math.ceil((y + 600) / GROW_STEP) * GROW_STEP);
    updateSpacer();
  }
}
function ensureMinHeight() {
  const p = pageNow();
  if (!p || !paneH || !scale) return;
  const need = paneH / scale + 400;
  if (p.h * scale < paneH + 500) {
    p.h = Math.ceil(Math.max(BASE_H, need) / GROW_STEP) * GROW_STEP;
    updateSpacer();
  }
}

/* ==================== 墨迹渲染 ==================== */
function resample(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [{ x: pts[0].x, y: pts[0].y, p: pts[0].p }];
  let remain = step;
  for (let i = 1; i < pts.length; i++) {
    let ax = pts[i - 1].x, ay = pts[i - 1].y, ap = pts[i - 1].p;
    const bx = pts[i].x, by = pts[i].y, bp = pts[i].p;
    let seg = Math.hypot(bx - ax, by - ay);
    while (seg >= remain) {
      const t = remain / seg;
      const nx = ax + (bx - ax) * t;
      const ny = ay + (by - ay) * t;
      const np = ap + (bp - ap) * t;
      out.push({ x: nx, y: ny, p: np });
      ax = nx; ay = ny; ap = np;
      seg -= remain;
      remain = step;
    }
    remain -= seg;
  }
  const last = pts[pts.length - 1];
  out.push({ x: last.x, y: last.y, p: last.p });
  return out;
}
function smoothPressure(pts, win) {
  const n = pts.length;
  if (n < 3 || win <= 0) return pts;
  const out = pts.slice();
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let k = -win; k <= win; k++) {
      const j = i + k;
      if (j >= 0 && j < n) { sum += pts[j].p; cnt++; }
    }
    out[i] = { x: pts[i].x, y: pts[i].y, p: sum / cnt };
  }
  return out;
}
function tracePath(ctx, pts) {
  ctx.beginPath();
  if (pts.length === 1) { ctx.arc(pts[0].x, pts[0].y, 0.7, 0, Math.PI * 2); return; }
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) { ctx.lineTo(pts[1].x, pts[1].y); return; }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
}
function ribbon(ctx, pts, baseW) {
  const n = pts.length;
  if (n < 2) return;
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i > 0 ? i - 1 : 0];
    const b = pts[i < n - 1 ? i + 1 : n - 1];
    let dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const edge = Math.min(i, n - 1 - i);
    const taper = edge < 3 ? 0.55 + 0.15 * edge : 1;
    const w = Math.max(0.35, baseW * (0.3 + 0.95 * curveP(pts[i].p)) * taper) * 0.5;
    left.push({ x: pts[i].x - dy * w, y: pts[i].y + dx * w });
    right.push({ x: pts[i].x + dy * w, y: pts[i].y - dx * w });
  }
  ctx.beginPath();
  ctx.moveTo(left[0].x, left[0].y);
  for (let i = 1; i < n; i++) ctx.lineTo(left[i].x, left[i].y);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
  ctx.closePath();
  ctx.fill();
  const w0 = Math.max(0.35, baseW * (0.3 + 0.95 * curveP(pts[0].p))) * 0.5;
  const w1 = Math.max(0.35, baseW * (0.3 + 0.95 * curveP(pts[n - 1].p))) * 0.5;
  ctx.beginPath();
  ctx.arc(pts[0].x, pts[0].y, w0, 0, Math.PI * 2);
  ctx.arc(pts[n - 1].x, pts[n - 1].y, w1, 0, Math.PI * 2);
  ctx.fill();
}
function drawStroke(ctx, s) {
  const pts = s.pts;
  if (!pts || !pts.length) return;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.tool === 'highlighter') {
    ctx.globalAlpha = 0.32;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'butt';
    tracePath(ctx, pts);
    ctx.stroke();
  } else if (s.tool === 'fountain') {
    const rs = resample(pts, 1.4);
    ribbon(ctx, smoothPressure(rs, calib.smooth), s.width);
  } else if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, Math.max(0.7, s.width * 0.35), 0, Math.PI * 2);
    ctx.fill();
  } else if (s.tool === 'felt') {
    ctx.lineWidth = Math.max(1, s.width * 0.85);
    tracePath(ctx, pts);
    ctx.stroke();
  } else {
    ctx.lineWidth = Math.max(0.8, s.width * 0.55);
    tracePath(ctx, pts);
    ctx.stroke();
  }
  ctx.restore();
}

function getBB(s) {
  if (s.bb) return s.bb;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of s.pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  s.bb = { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
  return s.bb;
}

/* ==================== 形状识别 ==================== */
function pathLen(pts) {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += dist(pts[i - 1], pts[i]);
  return n;
}
function shapeDetect(pts) {
  if (pts.length < 6) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const bw = maxX - minX, bh = maxY - minY;
  const diag = Math.hypot(bw, bh);
  if (diag < 40) return null;
  const len = pathLen(pts);
  if (len < diag * 0.6) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const closed = dist(first, last) < diag * 0.3;
  if (!closed) {
    let dev = 0;
    const vx = last.x - first.x, vy = last.y - first.y;
    const vv = vx * vx + vy * vy || 1;
    for (const p of pts) {
      const t = clamp(((p.x - first.x) * vx + (p.y - first.y) * vy) / vv, 0, 1);
      dev = Math.max(dev, Math.hypot(p.x - (first.x + vx * t), p.y - (first.y + vy * t)));
    }
    if (dev < Math.max(4.5, len * 0.05)) return { kind: 'line', pts: [first, last] };
    return null;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const a = Math.max(bw / 2, 1), b = Math.max(bh / 2, 1);
  let ellSum = 0;
  for (const p of pts) ellSum += Math.abs(Math.hypot((p.x - cx) / a, (p.y - cy) / b) - 1);
  const ellErr = ellSum / pts.length;
  let rectHit = 0;
  const tol = diag * 0.1;
  for (const p of pts) {
    const d = Math.min(Math.abs(p.x - minX), Math.abs(p.x - maxX), Math.abs(p.y - minY), Math.abs(p.y - maxY));
    if (d < tol) rectHit++;
  }
  if (ellErr < 0.14) {
    const out = [];
    for (let i = 0; i <= 44; i++) {
      const t = (i / 44) * Math.PI * 2;
      out.push({ x: cx + Math.cos(t) * a, y: cy + Math.sin(t) * b, p: 0.75 });
    }
    return { kind: 'ellipse', pts: out };
  }
  if (rectHit / pts.length > 0.9) {
    return {
      kind: 'rect',
      pts: [
        { x: minX, y: minY, p: 0.75 }, { x: maxX, y: minY, p: 0.75 },
        { x: maxX, y: maxY, p: 0.75 }, { x: minX, y: maxY, p: 0.75 },
        { x: minX, y: minY, p: 0.75 },
      ],
    };
  }
  return null;
}

/* ==================== 选中框 ==================== */
function selBBox() {
  if (!selection.size) return null;
  const p = pageNow();
  if (!p) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, found = false;
  for (const s of p.strokes) {
    if (!selection.has(s.id)) continue;
    const b = getBB(s);
    found = true;
    if (b.minX < minX) minX = b.minX;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return found ? { minX: minX, maxX: maxX, minY: minY, maxY: maxY } : null;
}
function selectionStrokes() {
  const p = pageNow();
  if (!p) return [];
  return p.strokes.filter((s) => selection.has(s.id));
}
function moveStroke(s, dx, dy) {
  s.pts = s.pts.map((q) => ({ x: q.x + dx, y: q.y + dy, p: q.p }));
  s.bb = null;
}
function unionBox(boxes) {
  const u = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const b of boxes) {
    if (b.minX < u.minX) u.minX = b.minX;
    if (b.maxX > u.maxX) u.maxX = b.maxX;
    if (b.minY < u.minY) u.minY = b.minY;
    if (b.maxY > u.maxY) u.maxY = b.maxY;
  }
  return u;
}
function alignSel(mode) {
  const arr = selectionStrokes();
  if (!arr.length) return;
  pushHist();
  const boxes = arr.map(getBB);
  const u = unionBox(boxes);
  arr.forEach((s, i) => {
    const b = boxes[i];
    let dx = 0, dy = 0;
    if (mode === 'left') dx = u.minX - b.minX;
    else if (mode === 'hcenter') dx = (u.minX + u.maxX) / 2 - (b.minX + b.maxX) / 2;
    else if (mode === 'right') dx = u.maxX - b.maxX;
    else if (mode === 'top') dy = u.minY - b.minY;
    else if (mode === 'vcenter') dy = (u.minY + u.maxY) / 2 - (b.minY + b.maxY) / 2;
    else if (mode === 'bottom') dy = u.maxY - b.maxY;
    if (dx || dy) moveStroke(s, dx, dy);
  });
  redraw(); save();
}
function distSel(axis) {
  const arr = selectionStrokes();
  if (arr.length < 3) { toast('至少选 3 条才能等距分布'); return; }
  pushHist();
  const boxes = arr.map(getBB);
  const center = (b) => (axis === 'h' ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2);
  const order = arr.map((_, i) => i).sort((a, b) => center(boxes[a]) - center(boxes[b]));
  const c0 = center(boxes[order[0]]);
  const c1 = center(boxes[order[order.length - 1]]);
  const step = (c1 - c0) / (order.length - 1);
  order.forEach((i, k) => {
    const d = c0 + step * k - center(boxes[i]);
    if (axis === 'h') moveStroke(arr[i], d, 0); else moveStroke(arr[i], 0, d);
  });
  redraw(); save();
}
function rotateSel() {
  const arr = selectionStrokes();
  const bb = selBBox();
  if (!arr.length || !bb) return;
  pushHist();
  const cx0 = (bb.minX + bb.maxX) / 2;
  const cy0 = (bb.minY + bb.maxY) / 2;
  for (const s of arr) {
    s.pts = s.pts.map((p) => ({ x: cx0 - (p.y - cy0), y: cy0 + (p.x - cx0), p: p.p }));
    s.bb = null;
  }
  redraw(); save();
}
let clipboard = [];
function copySel() {
  const arr = selectionStrokes();
  if (!arr.length) return;
  clipboard = arr.map((s) => ({ tool: s.tool, color: s.color, width: s.width, pts: s.pts.map((p) => ({ x: p.x, y: p.y, p: p.p })) }));
  toast('已复制 ' + clipboard.length + ' 条笔迹');
}
function pasteClip() {
  const p = pageNow();
  if (!clipboard.length || !p) return;
  pushHist();
  const made = clipboard.map((s) => ({
    id: uid(), tool: s.tool, color: s.color, width: s.width, bb: null,
    pts: s.pts.map((q) => ({ x: q.x + 28, y: q.y + 28, p: q.p })),
  }));
  for (const s of made) p.strokes.push(s);
  selection = new Set(made.map((s) => s.id));
  redraw(); save();
  toast('已粘贴');
}
function deleteSel() {
  const p = pageNow();
  if (!p || !selection.size) return;
  pushHist();
  p.strokes = p.strokes.filter((s) => !selection.has(s.id));
  selection.clear();
  redraw(); save();
}
function handlePoints(bb) {
  return [
    { x: bb.minX, y: bb.minY }, { x: bb.maxX, y: bb.minY },
    { x: bb.maxX, y: bb.maxY }, { x: bb.minX, y: bb.maxY },
  ];
}
function handleAt(p, bb) {
  const r = 12 / scale;
  for (const h of handlePoints(bb)) if (Math.abs(p.x - h.x) < r && Math.abs(p.y - h.y) < r) return h;
  return null;
}
function updateSelBar() {
  if (!el.selbar) return;
  const bb = selection.size && isSelectTool() ? selBBox() : null;
  if (!bb) { el.selbar.style.display = 'none'; return; }
  el.selbar.style.display = 'flex';
  const bw = el.selbar.offsetWidth || 330;
  const sx = offsetX + bb.minX * scale;
  const sy = bb.minY * scale - scrollTop;
  el.selbar.style.left = Math.round(clamp(sx, 8, Math.max(8, paneW - bw - 8))) + 'px';
  el.selbar.style.top = Math.round(clamp(sy - 44, 8, Math.max(8, paneH - 44))) + 'px';
}

/* ==================== 渲染 ==================== */
function paintPaper(p, y0, y1) {
  const step = 44;
  if (p.paper === 'grid') {
    bgCtx.beginPath();
    bgCtx.strokeStyle = '#e9ebf2';
    bgCtx.lineWidth = 1;
    for (let x = step; x < p.w; x += step) { bgCtx.moveTo(x + 0.5, y0); bgCtx.lineTo(x + 0.5, y1); }
    for (let y = Math.floor(y0 / step) * step; y < y1; y += step) { bgCtx.moveTo(0, y + 0.5); bgCtx.lineTo(p.w, y + 0.5); }
    bgCtx.stroke();
  } else if (p.paper === 'lines') {
    bgCtx.beginPath();
    bgCtx.strokeStyle = '#e9ebf2';
    bgCtx.lineWidth = 1;
    for (let y = Math.floor(y0 / 56) * 56; y < y1; y += 56) { bgCtx.moveTo(0, y + 0.5); bgCtx.lineTo(p.w, y + 0.5); }
    bgCtx.stroke();
  }
}

function redraw() {
  bgCtx.setTransform(1, 0, 0, 1, 0, 0);
  bgCtx.clearRect(0, 0, el.bg.width, el.bg.height);
  clearLive();
  const p = pageNow();
  if (!p) return;
  recompute();
  offsetX = viewOffsetX();
  if (!paneW) return;
  const y0 = scrollTop / scale;
  const y1 = (scrollTop + paneH) / scale;

  bgCtx.save();
  applyView(bgCtx);
  bgCtx.beginPath();
  bgCtx.rect(0, 0, p.w, p.h);
  bgCtx.clip();
  bgCtx.fillStyle = '#ffffff';
  bgCtx.fillRect(0, 0, p.w, p.h);
  if (p.paper !== 'plain') paintPaper(p, y0, y1);
  if (replaying.active) {
    let left = replaying.count;
    for (const s of p.strokes) {
      if (left <= 0) break;
      const take = Math.min(s.pts.length, left);
      left -= take;
      if (take > 1) drawStroke(bgCtx, { tool: s.tool, color: s.color, width: s.width, pts: s.pts.slice(0, take) });
    }
  } else {
    for (const s of p.strokes) {
      const b = getBB(s);
      if (b.maxY < y0 - 120 || b.minY > y1 + 120) continue;
      drawStroke(bgCtx, s);
    }
  }
  const bb = selBBox();
  if (bb) {
    bgCtx.setLineDash([7 / scale, 5 / scale]);
    bgCtx.lineWidth = 1.6 / scale;
    bgCtx.strokeStyle = '#6d4ae0';
    bgCtx.strokeRect(bb.minX - 6 / scale, bb.minY - 6 / scale, bb.maxX - bb.minX + 12 / scale, bb.maxY - bb.minY + 12 / scale);
    bgCtx.setLineDash([]);
    if (isSelectTool()) {
      const hs = 9 / scale;
      for (const h of handlePoints(bb)) {
        bgCtx.fillStyle = '#ffffff';
        bgCtx.strokeStyle = '#6d4ae0';
        bgCtx.lineWidth = 1.6 / scale;
        bgCtx.beginPath();
        bgCtx.rect(h.x - hs / 2, h.y - hs / 2, hs, hs);
        bgCtx.fill();
        bgCtx.stroke();
      }
    }
  }
  bgCtx.restore();
  updateHint();
  updateSelBar();
}

function clearLive() {
  liveCtx.setTransform(1, 0, 0, 1, 0, 0);
  liveCtx.clearRect(0, 0, el.live.width, el.live.height);
}
function renderLive() {
  clearLive();
  const p = pageNow();
  if (!p || !paneW) return;
  offsetX = viewOffsetX();
  applyView(liveCtx);
  liveCtx.save();
  liveCtx.beginPath();
  liveCtx.rect(0, 0, p.w, p.h);
  liveCtx.clip();
  if (drawing) drawStroke(liveCtx, drawing);
  if (marquee) {
    const x0 = Math.min(marquee.a.x, marquee.b.x);
    const y0 = Math.min(marquee.a.y, marquee.b.y);
    const w = Math.abs(marquee.b.x - marquee.a.x);
    const h = Math.abs(marquee.b.y - marquee.a.y);
    liveCtx.fillStyle = 'rgba(37, 99, 235, 0.10)';
    liveCtx.fillRect(x0, y0, w, h);
    liveCtx.strokeStyle = '#2563eb';
    liveCtx.lineWidth = 1.2 / scale;
    liveCtx.strokeRect(x0, y0, w, h);
  }
  if (lassoPts && lassoPts.length > 1) {
    liveCtx.setLineDash([6 / scale, 4 / scale]);
    liveCtx.lineWidth = 1.6 / scale;
    liveCtx.strokeStyle = '#6d4ae0';
    liveCtx.beginPath();
    liveCtx.moveTo(lassoPts[0].x, lassoPts[0].y);
    for (let i = 1; i < lassoPts.length; i++) liveCtx.lineTo(lassoPts[i].x, lassoPts[i].y);
    liveCtx.closePath();
    liveCtx.stroke();
    liveCtx.setLineDash([]);
  }
  liveCtx.restore();
}
function updateHint() {
  const p = pageNow();
  el.emptyhint.style.display = (p && p.strokes.length === 0 && !drawing) ? 'block' : 'none';
}

/* ==================== 历史 ==================== */
function pushHist() {
  const p = pageNow();
  if (!p) return;
  let h = hist.get(state.sel.page);
  if (!h) { h = { u: [], r: [] }; hist.set(state.sel.page, h); }
  h.u.push({ s: p.strokes.slice(), d: (p.docInk || []).slice() });
  if (h.u.length > 100) h.u.shift();
  h.r.length = 0;
  syncHistBtns();
}
function undo() {
  const h = hist.get(state.sel.page);
  const p = pageNow();
  if (!h || !p || !h.u.length) return;
  h.r.push({ s: p.strokes.slice(), d: (p.docInk || []).slice() });
  const prev = h.u.pop();
  p.strokes = prev.s;
  p.docInk = prev.d;
  selection.clear();
  redraw(); drawDocInk(); save(); syncHistBtns();
}
function redo() {
  const h = hist.get(state.sel.page);
  const p = pageNow();
  if (!h || !p || !h.r.length) return;
  h.u.push({ s: p.strokes.slice(), d: (p.docInk || []).slice() });
  const next = h.r.pop();
  p.strokes = next.s;
  p.docInk = next.d;
  selection.clear();
  redraw(); drawDocInk(); save(); syncHistBtns();
}
function syncHistBtns() {
  const h = hist.get(state.sel.page);
  el.undo.disabled = !h || !h.u.length;
  el.redo.disabled = !h || !h.r.length;
}

/* ==================== 指针 ==================== */
let drawing = null;
let eraseSet = null;
let lassoPts = null;
let marquee = null;
let moving = null;
let lastPenAt = 0;
let replaying = { active: false, count: 0, total: 0, raf: 0 };
let panStart = null;
let spaceDown = false;
let defaultPenIdx = -1;

function pressureOf(e) {
  if (e.pointerType === 'pen') return clamp(e.pressure || 0.5, 0.06, 1);
  return 0.55;
}
function isPalm(e) { return e.pointerType === 'touch' && performance.now() - lastPenAt < 1200; }
function penWidth(pen) {
  const base = WIDTHS[pen.w] || 3.6;
  return pen.type === 'highlighter' ? base * HIGH_MUL : base;
}
function currentPen() { return pens[activePen] || pens[0]; }
function isSelectTool() { return tool === 'lasso' || tool === 'marquee'; }

function placeCursor(e) {
  const r = el.noteScroll.getBoundingClientRect();
  el.penCursor.style.left = (e.clientX - r.left) + 'px';
  el.penCursor.style.top = (e.clientY - r.top) + 'px';
  el.penCursor.style.display = 'block';
}
function setCursorShape() {
  el.penCursor.className = tool === 'eraser' ? 'eraser' : isSelectTool() ? 'lasso' : '';
}

let warnedPointer = false;
function warnIfMouse(e) {
  if (warnedPointer || e.pointerType !== 'mouse') return;
  warnedPointer = true;
  toast('检测到输入是鼠标：数位板在鼠标模式，压感用不了。驱动里切到 Windows Ink 才有笔锋');
}

function onDown(e) {
  if (e.button === 2) return;
  if (e.pointerType === 'pen') lastPenAt = performance.now();
  if (isPalm(e) || !e.isPrimary) return;
  const p = pageNow();
  if (!p) return;
  e.preventDefault();
  if (spaceDown || e.button === 1) {
    panStart = { sx: e.clientX, sy: e.clientY, sl: el.noteScroll.scrollLeft, st: el.noteScroll.scrollTop };
    try { el.noteScroll.setPointerCapture(e.pointerId); } catch (err) {}
    el.noteScroll.style.cursor = 'grabbing';
    el.penCursor.style.display = 'none';
    return;
  }
  warnIfMouse(e);
  try { el.noteScroll.setPointerCapture(e.pointerId); } catch (err) {}
  placeCursor(e);
  if (replaying.active) stopReplay();
  const q = toContent(e);

  if (tool === 'eraser') {
    pushHist();
    eraseSet = new Set();
    eraseAt(q.x, q.y);
    return;
  }
  if (isSelectTool()) {
    const bb = selBBox();
    if (bb) {
      const corner = handleAt(q, bb);
      if (corner) {
        pushHist();
        const anchor = { x: corner.x === bb.minX ? bb.maxX : bb.minX, y: corner.y === bb.minY ? bb.maxY : bb.minY };
        const origin = new Map();
        for (const s of p.strokes) if (selection.has(s.id)) origin.set(s.id, s.pts.map((t) => ({ x: t.x, y: t.y, p: t.p })));
        moving = { mode: 'scale', anchor: anchor, d0: Math.hypot(q.x - anchor.x, q.y - anchor.y) || 1, origin: origin };
        return;
      }
      if (q.x > bb.minX - 10 / scale && q.x < bb.maxX + 10 / scale && q.y > bb.minY - 10 / scale && q.y < bb.maxY + 10 / scale) {
        pushHist();
        const origin = new Map();
        for (const s of p.strokes) if (selection.has(s.id)) origin.set(s.id, s.pts.map((t) => ({ x: t.x, y: t.y, p: t.p })));
        moving = { mode: 'move', start: q, origin: origin };
        return;
      }
      selection.clear();
    }
    if (tool === 'lasso') lassoPts = [q];
    else marquee = { a: q, b: q };
    renderLive(); redraw();
    return;
  }
  const pen = currentPen();
  const isRuler = tool === 'ruler';
  drawing = {
    kind: isRuler ? 'ruler' : 'pen',
    tool: isRuler ? 'ballpoint' : pen.type,
    color: pen.color,
    width: penWidth(pen),
    pts: [{ x: q.x, y: q.y, p: pressureOf(e) }],
  };
  el.emptyhint.style.display = 'none';
  renderLive();
}

function addPoint(s, x, y, pressure) {
  const last = s.pts[s.pts.length - 1];
  if (Math.hypot(x - last.x, y - last.y) < 0.9) return;
  s.pts.push({ x: x, y: y, p: pressure });
  if (s.pts.length > MAX_PTS) s.pts.length = MAX_PTS;
}

function onMove(e) {
  if (isPalm(e)) return;
  if (panStart) {
    el.noteScroll.scrollLeft = panStart.sl - (e.clientX - panStart.sx);
    el.noteScroll.scrollTop = panStart.st - (e.clientY - panStart.sy);
    scrollTop = el.noteScroll.scrollTop;
    redraw();
    return;
  }
  placeCursor(e);
  const p = pageNow();
  if (!p) return;
  const q = toContent(e);

  if (moving) {
    if (moving.mode === 'scale') {
      const d = Math.hypot(q.x - moving.anchor.x, q.y - moving.anchor.y) || 1;
      const f = clamp(d / moving.d0, 0.15, 6);
      const ax = moving.anchor.x, ay = moving.anchor.y;
      for (const s of p.strokes) {
        const orig = moving.origin.get(s.id);
        if (!orig) continue;
        s.pts = orig.map((t) => ({ x: ax + (t.x - ax) * f, y: ay + (t.y - ay) * f, p: t.p }));
        s.bb = null;
      }
    } else {
      const dx = q.x - moving.start.x;
      const dy = q.y - moving.start.y;
      for (const s of p.strokes) {
        const orig = moving.origin.get(s.id);
        if (!orig) continue;
        s.pts = orig.map((t) => ({ x: t.x + dx, y: t.y + dy, p: t.p }));
        s.bb = null;
      }
    }
    redraw();
    return;
  }
  if (eraseSet) { eraseAt(q.x, q.y); return; }
  if (marquee) { marquee.b = q; renderLive(); return; }
  if (lassoPts) {
    const last = lassoPts[lassoPts.length - 1];
    if (Math.hypot(q.x - last.x, q.y - last.y) > 1.5 / scale) { lassoPts.push(q); renderLive(); }
    return;
  }
  if (!drawing) return;
  const co = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents()) || [];
  const list = co.length ? co : [e];
  const r = el.noteScroll.getBoundingClientRect();
  for (const ev of list) {
    let x = (ev.clientX - r.left - offsetX) / scale;
    let y = (ev.clientY - r.top + scrollTop) / scale;
    if (e.shiftKey && drawing.pts.length > 0) {
      const a = drawing.pts[0];
      const dx = x - a.x, dy = y - a.y;
      const ang = Math.atan2(dy, dx);
      const snap = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
      if (Math.abs(ang - snap) < 0.14) {
        const len = Math.hypot(dx, dy);
        x = a.x + Math.cos(snap) * len;
        y = a.y + Math.sin(snap) * len;
      }
    }
    addPoint(drawing, x, y, pressureOf(ev));
    growIfNeeded(y);
  }
  renderLive();
}

function finishStroke() {
  const p = pageNow();
  if (!p || !drawing) return;
  const s = drawing;
  drawing = null;
  clearLive();
  if (s.kind === 'ruler' && s.pts.length > 1) {
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    s.pts = [{ x: a.x, y: a.y, p: 0.8 }, { x: b.x, y: b.y, p: 0.8 }];
  } else if (shapeSnap && s.tool !== 'highlighter') {
    const shape = shapeDetect(s.pts);
    if (shape) { s.pts = shape.pts; s.tool = 'ballpoint'; }
  }
  pushHist();
  s.id = uid();
  s.bb = null;
  p.strokes.push(s);
  ensureHeight();
  redraw();
  save();
}

function onUp() {
  if (panStart) { panStart = null; el.noteScroll.style.cursor = spaceDown ? 'grab' : ''; return; }
  if (moving) { moving = null; save(); return; }
  if (eraseSet) { eraseSet = null; save(); return; }
  if (lassoPts) { applyLasso(); return; }
  if (marquee) { applyMarquee(); return; }
  if (drawing) finishStroke();
}

function applyLasso() {
  const p = pageNow();
  const poly = lassoPts;
  lassoPts = null;
  if (!p || !poly || poly.length < 3) { redraw(); return; }
  selection.clear();
  for (const s of p.strokes) {
    for (const q of s.pts) {
      if (pointInPoly(q, poly)) { selection.add(s.id); break; }
    }
  }
  redraw();
  if (selection.size) toast('已选中 ' + selection.size + ' 条笔迹');
}
function applyMarquee() {
  const p = pageNow();
  const m = marquee;
  marquee = null;
  if (!p || !m) { redraw(); return; }
  const x0 = Math.min(m.a.x, m.b.x);
  const x1 = Math.max(m.a.x, m.b.x);
  const y0 = Math.min(m.a.y, m.b.y);
  const y1 = Math.max(m.a.y, m.b.y);
  if (x1 - x0 < 4 / scale || y1 - y0 < 4 / scale) { redraw(); return; }
  selection.clear();
  for (const s of p.strokes) {
    const b = getBB(s);
    if (b.maxX >= x0 && b.minX <= x1 && b.maxY >= y0 && b.minY <= y1) selection.add(s.id);
  }
  redraw();
  if (selection.size) toast('框选 ' + selection.size + ' 条笔迹，可拖动 / 缩放 / 对齐 / 删除');
}

function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  let t = 0;
  if (len > 0) t = clamp(((px - a.x) * dx + (py - a.y) * dy) / len, 0, 1);
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}
function eraseAt(x, y) {
  const p = pageNow();
  if (!p) return;
  const tol = Math.max(4, (8 + (WIDTHS[currentPen().w] || 3) * 2) / scale);
  let changed = false;
  p.strokes = p.strokes.filter((s) => {
    const pts = s.pts;
    if (!pts.length) return false;
    if (pts.length === 1) {
      if (Math.hypot(x - pts[0].x, y - pts[0].y) <= tol) { changed = true; return false; }
      return true;
    }
    const b = getBB(s);
    if (x < b.minX - tol || x > b.maxX + tol || y < b.minY - tol || y > b.maxY + tol) return true;
    for (let i = 1; i < pts.length; i++) {
      if (segDist(x, y, pts[i - 1], pts[i]) <= tol) { changed = true; return false; }
    }
    return true;
  });
  if (changed) { selection.clear(); redraw(); }
}

/* 输入保护：阻止原生拖拽、文本选中、中键自动滚动 */
document.addEventListener('dragstart', (e) => { e.preventDefault(); }, true);
document.addEventListener('selectstart', (e) => {
  const t = e.target;
  if (t && t.closest && t.closest('#notepane, #docpane, #side, #rail, #ribbon')) e.preventDefault();
}, true);
document.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }, { passive: false });
document.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

el.noteScroll.addEventListener('pointerdown', onDown);
el.noteScroll.addEventListener('pointermove', onMove);
el.noteScroll.addEventListener('pointerup', onUp);
el.noteScroll.addEventListener('pointercancel', onUp);
el.noteScroll.addEventListener('pointerleave', () => { el.penCursor.style.display = 'none'; });
el.noteScroll.addEventListener('pointerenter', setCursorShape);
el.noteScroll.addEventListener('contextmenu', (e) => e.preventDefault());

/* ==================== 滚动 ==================== */
let syncGuard = false;
el.noteScroll.addEventListener('scroll', () => {
  scrollTop = el.noteScroll.scrollTop;
  redraw();
  if (syncScroll && !syncGuard) {
    syncGuard = true;
    const a = el.noteScroll, b = el.docScroll;
    const fa = a.scrollTop / Math.max(1, a.scrollHeight - a.clientHeight);
    b.scrollTop = fa * Math.max(0, b.scrollHeight - b.clientHeight);
    requestAnimationFrame(() => { syncGuard = false; });
  }
});
el.docScroll.addEventListener('scroll', () => {
  if (syncScroll && !syncGuard) {
    syncGuard = true;
    const a = el.docScroll, b = el.noteScroll;
    const fa = a.scrollTop / Math.max(1, a.scrollHeight - a.clientHeight);
    b.scrollTop = fa * Math.max(0, b.scrollHeight - b.clientHeight);
    requestAnimationFrame(() => { syncGuard = false; });
  }
});
/* 画布高度由笔迹驱动增长（见 ensureHeight / growIfNeeded） */

/* ==================== 工具栏 ==================== */
function renderToolbar() {
  el.penGroup.textContent = '';
  pens.forEach((pen, i) => {
    const b = document.createElement('button');
    b.className = 'pen' + (i === activePen && tool !== 'eraser' && tool !== 'lasso' ? ' active' : '')
      + (i === defaultPenIdx ? ' isdefault' : '');
    b.dataset.pen = String(i);
    b.title = PEN_TYPES[i].name;
    const dot = document.createElement('span');
    dot.className = 'dot ' + pen.type;
    dot.style.background = pen.color;
    const nm = document.createElement('span');
    nm.className = 'pname';
    nm.textContent = PEN_TYPES[i].short;
    b.append(dot, nm);
    el.penGroup.appendChild(b);
  });
  el.colorGroup.textContent = '';
  PALETTE.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === currentPen().color ? ' active' : '');
    b.style.background = c;
    b.dataset.color = c;
    b.title = c;
    el.colorGroup.appendChild(b);
  });
  el.widthGroup.textContent = '';
  [0, 1, 2, 3].forEach((i) => {
    const b = document.createElement('button');
    b.className = 'wbtn' + (i === currentPen().w ? ' active' : '');
    b.dataset.w = String(i);
    b.title = '粗细 ' + (i + 1);
    const d = document.createElement('span');
    const size = 5 + i * 5;
    d.style.width = size + 'px';
    d.style.height = size + 'px';
    d.style.background = currentPen().color;
    b.appendChild(d);
    el.widthGroup.appendChild(b);
  });
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  el.shapeBtn.classList.toggle('active', shapeSnap);
  el.syncBtn.classList.toggle('on', syncScroll);
  setCursorShape();
  syncHistBtns();
}

el.penGroup.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pen]');
  if (!b) return;
  activePen = parseInt(b.dataset.pen, 10);
  tool = 'pen';
  renderToolbar(); save();
});
el.penGroup.addEventListener('contextmenu', (e) => {
  const b = e.target.closest('[data-pen]');
  if (!b) return;
  e.preventDefault();
  const i = parseInt(b.dataset.pen, 10);
  if (defaultPenIdx === i) {
    defaultPenIdx = -1;
    toast('已取消默认笔，改成记住上次用的笔');
  } else {
    defaultPenIdx = i;
    activePen = i;
    tool = 'pen';
    toast('默认笔：' + PEN_TYPES[i].name + '（以后每次打开都用它）');
  }
  renderToolbar();
  save();
});

el.colorGroup.addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]');
  if (!b) return;
  currentPen().color = b.dataset.color;
  renderToolbar(); save();
});
el.widthGroup.addEventListener('click', (e) => {
  const b = e.target.closest('[data-w]');
  if (!b) return;
  currentPen().w = parseInt(b.dataset.w, 10);
  renderToolbar(); save();
});
el.toolGroup.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (!b) return;
  const t = b.dataset.tool;
  tool = tool === t ? 'pen' : t;
  selection.clear();
  renderToolbar(); redraw();
});
if (el.selbar) {
  el.selbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    e.preventDefault();
    const act = b.dataset.act;
    if (act === 'disth') distSel('h');
    else if (act === 'distv') distSel('v');
    else if (act === 'rotate') rotateSel();
    else if (act === 'copy') copySel();
    else if (act === 'delete') deleteSel();
    else alignSel(act);
  });
}

el.shapeBtn.addEventListener('click', () => {
  shapeSnap = !shapeSnap;
  toast(shapeSnap ? '形状识别：开' : '形状识别：关');
  renderToolbar(); save();
});
el.undo.addEventListener('click', undo);
el.redo.addEventListener('click', redo);

/* ==================== 重播 ==================== */
function startReplay() {
  const p = pageNow();
  if (!p || !p.strokes.length) return;
  stopReplay();
  replaying.active = true;
  replaying.count = 0;
  replaying.total = p.strokes.reduce((a, s) => a + s.pts.length, 0);
  el.noteScroll.scrollTop = 0;
  scrollTop = 0;
  const per = Math.max(8, Math.round(replaying.total / 260));
  const step = () => {
    replaying.count += per;
    redraw();
    if (replaying.count < replaying.total) replaying.raf = requestAnimationFrame(step);
    else { replaying.active = false; redraw(); }
  };
  replaying.raf = requestAnimationFrame(step);
}
function stopReplay() {
  if (replaying.raf) cancelAnimationFrame(replaying.raf);
  replaying.raf = 0;
  replaying.active = false;
  replaying.count = 0;
}
el.replay.addEventListener('click', startReplay);

/* ==================== 导航（Codex 式文件夹） ==================== */
function renderTree() {
  if (!el.tree) return;
  const kw = (el.searchInput && el.searchInput.value ? el.searchInput.value : '').trim().toLowerCase();
  el.tree.textContent = '';

  if (!state.notebooks.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = '还没有文件夹，点右上角 ＋ 新建';
    el.tree.appendChild(empty);
    return;
  }

  for (const nb of state.notebooks) {
    const folder = document.createElement('div');
    folder.className = 'folder' + (nb.open ? ' open' : '');

    const head = document.createElement('div');
    head.className = 'folder-head' + (nb.id === state.sel.nb && !nb.open ? ' cur' : '');
    head.dataset.nb = nb.id;

    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = nb.open ? '▾' : '▸';

    const icon = document.createElement('span');
    icon.className = 'ficon';
    icon.textContent = nb.open ? '▾' : '▸';
    icon.style.display = 'none';

    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = nb.title;

    const add = document.createElement('button');
    add.className = 'fbtn';
    add.dataset.act = 'addsec';
    add.title = '新建分区';
    add.textContent = '＋';

    head.append(caret, name, add);
    folder.appendChild(head);

    if (nb.open) {
      for (const sec of nb.sections) {
        folder.appendChild(sectionBlock(nb, sec, kw));
      }
    }
    el.tree.appendChild(folder);
  }
}

function sectionBlock(nb, sec, kw) {
  const box = document.createElement('div');
  box.className = 'subfolder';

  const head = document.createElement('div');
  head.className = 'sub-head' + (sec.id === state.sel.sec ? ' cur' : '');
  head.dataset.sec = sec.id;

  const caret = document.createElement('span');
  caret.className = 'caret sm';
  caret.textContent = sec.open === false ? '▸' : '▾';

  const name = document.createElement('span');
  name.className = 'sname';
  name.textContent = sec.title;

  const add = document.createElement('button');
  add.className = 'fbtn';
  add.dataset.act = 'addpage';
  add.dataset.sec = sec.id;
  add.title = '新建页面';
  add.textContent = '＋';

  head.append(caret, name, add);
  box.appendChild(head);

  if (sec.open === false) return box;

  const list = sec.pages.filter((p) => !kw || p.title.toLowerCase().indexOf(kw) >= 0);
  for (const p of list) {
    const item = document.createElement('div');
    item.className = 'pitem' + (p.id === state.sel.page ? ' cur' : '');
    item.dataset.page = p.id;
    const dot = document.createElement('span');
    dot.className = 'pdot';
    const t = document.createElement('span');
    t.className = 'ptitle';
    t.textContent = p.title;
    item.append(dot, t);
    box.appendChild(item);
  }
  if (!list.length && kw) {
    const none = document.createElement('div');
    none.className = 'pnone';
    none.textContent = '没有匹配页面';
    box.appendChild(none);
  }
  return box;
}

function renderAll() {
  renderTree();
  renderToolbar();
  renderDoc();
  redraw();
}

function saveView() {
  const p = pageNow();
  if (!p) return;
  p.view = {
    zoom: zoom,
    top: el.noteScroll.scrollTop,
    left: el.noteScroll.scrollLeft,
    docTop: el.docScroll.scrollTop,
  };
}

function afterPageSwitch(fresh) {
  selection.clear();
  const p = pageNow();
  const v = (!fresh && p && p.view) ? p.view : null;
  zoom = (v && v.zoom) ? v.zoom : 1;
  scrollTop = 0;
  recompute();
  updateSpacer();
  ensureMinHeight();
  el.noteScroll.scrollTop = v ? (v.top || 0) : 0;
  el.noteScroll.scrollLeft = v ? (v.left || 0) : 0;
  el.docScroll.scrollTop = v ? (v.docTop || 0) : 0;
  scrollTop = el.noteScroll.scrollTop;
  updateZoomLabel();
}

function selectSection(id) {
  const hit = findSection(id);
  if (!hit) return;
  saveView();
  state.sel = { nb: hit.nb.id, sec: hit.sec.id, page: hit.sec.pages[0].id };
  hit.nb.open = true;
  hit.sec.open = true;
  afterPageSwitch();
  renderAll();
  save();
}

function selectPage(id) {
  const hit = findPage(id);
  if (!hit) return;
  saveView();
  state.sel = { nb: hit.nb.id, sec: hit.sec.id, page: hit.page.id };
  hit.nb.open = true;
  hit.sec.open = true;
  afterPageSwitch();
  renderTree();
  renderDoc();
  redraw();
  save();
}

function addPageTo(secId) {
  const hit = findSection(secId);
  if (!hit) return;
  saveView();
  const p = newPage('第 ' + (hit.sec.pages.length + 1) + ' 页');
  hit.sec.pages.push(p);
  hit.sec.open = true;
  state.sel = { nb: hit.nb.id, sec: hit.sec.id, page: p.id };
  afterPageSwitch(true);
  renderAll();
  save();
}

function addPage() {
  const o = curObj();
  if (!o) return;
  addPageTo(o.sec.id);
}

function addSection(nbId) {
  const nb = findNotebook(nbId);
  if (!nb) return;
  saveView();
  const s = newSection('分区 ' + (nb.sections.length + 1));
  nb.sections.push(s);
  nb.open = true;
  state.sel = { nb: nb.id, sec: s.id, page: s.pages[0].id };
  afterPageSwitch(true);
  renderAll();
  save();
  setTimeout(() => {
    const name = prompt('新分区名称', s.title);
    if (name && name.trim()) { s.title = name.trim(); renderAll(); save(); }
  }, 30);
}

function addNotebook() {
  saveView();
  const nb = newNotebook('文件夹 ' + (state.notebooks.length + 1));
  state.notebooks.push(nb);
  state.sel = { nb: nb.id, sec: nb.sections[0].id, page: nb.sections[0].pages[0].id };
  afterPageSwitch(true);
  renderAll();
  save();
  setTimeout(() => {
    const name = prompt('新文件夹名称', nb.title);
    if (name && name.trim()) { nb.title = name.trim(); renderTree(); save(); }
  }, 30);
}

el.tree.addEventListener('click', (e) => {
  const addSec = e.target.closest('[data-act="addsec"]');
  if (addSec) {
    const row = addSec.closest('.folder-head');
    if (row) addSection(row.dataset.nb);
    return;
  }
  const addPg = e.target.closest('[data-act="addpage"]');
  if (addPg) { addPageTo(addPg.dataset.sec); return; }

  const pageEl = e.target.closest('.pitem');
  if (pageEl) { selectPage(pageEl.dataset.page); return; }

  const sub = e.target.closest('.sub-head');
  if (sub) {
    const hit = findSection(sub.dataset.sec);
    if (!hit) return;
    hit.sec.open = hit.sec.open === false;
    if (hit.sec.id !== state.sel.sec) selectSection(hit.sec.id);
    else { renderTree(); save(); }
    return;
  }

  const head = e.target.closest('.folder-head');
  if (head) {
    const nb = findNotebook(head.dataset.nb);
    if (!nb) return;
    nb.open = !nb.open;
    state.sel.nb = nb.id;
    renderTree();
    save();
  }
});

el.tree.addEventListener('dblclick', (e) => {
  const pageEl = e.target.closest('.pitem');
  if (pageEl) {
    const hit = findPage(pageEl.dataset.page);
    if (!hit) return;
    const name = prompt('页面名称', hit.page.title);
    if (name && name.trim()) { hit.page.title = name.trim(); renderTree(); save(); }
    return;
  }
  const sub = e.target.closest('.sub-head');
  if (sub) {
    const hit = findSection(sub.dataset.sec);
    if (!hit) return;
    const name = prompt('分区名称', hit.sec.title);
    if (name && name.trim()) { hit.sec.title = name.trim(); renderAll(); save(); }
    return;
  }
  const head = e.target.closest('.folder-head');
  if (head) {
    const nb = findNotebook(head.dataset.nb);
    if (!nb) return;
    const name = prompt('文件夹名称', nb.title);
    if (name && name.trim()) { nb.title = name.trim(); renderTree(); save(); }
  }
});

el.tree.addEventListener('contextmenu', (e) => {
  const pageEl = e.target.closest('.pitem');
  if (!pageEl) return;
  e.preventDefault();
  const hit = findPage(pageEl.dataset.page);
  if (!hit) return;
  if (hit.sec.pages.length <= 1) { toast('至少保留一页'); return; }
  if (!confirm('删除页面「' + hit.page.title + '」？')) return;
  hit.sec.pages = hit.sec.pages.filter((p) => p.id !== hit.page.id);
  hist.delete(hit.page.id);
  state.sel = { nb: hit.nb.id, sec: hit.sec.id, page: hit.sec.pages[0].id };
  afterPageSwitch();
  renderAll();
  save();
});

if (el.newFolderBtn) el.newFolderBtn.addEventListener('click', addNotebook);
if (el.searchInput) el.searchInput.addEventListener('input', renderTree);


/* ==================== 原卷（左栏） ==================== */
function renderDoc() {
  const p = pageNow();
  el.docPages.textContent = '';
  if (!p || !p.doc || !p.doc.pages.length) {
    el.docEmpty.style.display = 'flex';
    el.docname.textContent = '';
    return;
  }
  el.docEmpty.style.display = 'none';
  el.docname.textContent = p.doc.name || '';
  docImgEls = [];
  p.doc.pages.forEach((pg) => {
    const d = document.createElement('div');
    d.className = 'doc-page';
    const img = document.createElement('img');
    img.draggable = false;
    const u = assets.get(pg.asset);
    if (u) img.src = u;
    img.onload = () => drawDocInk();
    img.style.width = (docZoom * 100) + '%';
    d.appendChild(img);
    el.docPages.appendChild(d);
    docImgEls.push(img);
  });
  docCanvasSize();
  drawDocInk();
}

function setDoc(name, pages, silent) {
  const p = pageNow();
  if (!p || !pages.length) return;
  if (!silent && p.doc && p.doc.pages.length) {
    if (!confirm('替换左侧原卷？')) return;
  }
  p.doc = {
    name: name,
    pages: pages.map((pg) => { const id = uid(); putAsset(id, pg.url); return { asset: id, w: pg.w, h: pg.h }; }),
  };
  el.docScroll.scrollTop = 0;
  renderDoc();
  save();
  toast('原卷已放到左边：' + name);
}

el.docZoomIn.addEventListener('click', () => { docZoom = clamp(docZoom * 1.15, 0.6, 8); renderDoc(); save(); });
el.docZoomOut.addEventListener('click', () => { docZoom = clamp(docZoom / 1.15, 0.6, 8); renderDoc(); save(); });
el.docScroll.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  docZoom = clamp(docZoom * (e.deltaY < 0 ? 1.12 : 0.89), 0.6, 8);
  renderDoc();
  save();
}, { passive: false });
el.syncBtn.addEventListener('click', () => {
  syncScroll = !syncScroll;
  el.syncBtn.classList.toggle('on', syncScroll);
  toast(syncScroll ? '左右同步滚动：开' : '左右同步滚动：关');
  save();
});
el.docBtn.addEventListener('click', () => {
  const hidden = el.docpane.style.display === 'none';
  el.docpane.style.display = hidden ? 'flex' : 'none';
  el.splitter.style.display = hidden ? 'block' : 'none';
  el.docBtn.classList.toggle('on', hidden);
  setTimeout(resize, 30);
});

/* ==================== 分栏拖拽 ==================== */
let splitDrag = null;
el.splitter.addEventListener('pointerdown', (e) => {
  splitDrag = { x: e.clientX, w: el.docpane.getBoundingClientRect().width };
  try { el.splitter.setPointerCapture(e.pointerId); } catch (err) {}
});
el.splitter.addEventListener('pointermove', (e) => {
  if (!splitDrag) return;
  const total = el.body.getBoundingClientRect().width;
  const w = clamp(splitDrag.w + (e.clientX - splitDrag.x), 240, total * 0.78);
  el.docpane.style.width = Math.round(w) + 'px';
  el.docpane.style.flex = '0 0 ' + Math.round(w) + 'px';
  resize();
});
el.splitter.addEventListener('pointerup', () => { if (splitDrag) { splitDrag = null; save(); } });

/* ==================== 缩放 ==================== */
function setZoom(z) {
  const p = pageNow();
  if (!p) return;
  const vx = viewOffsetX();
  const cx = (paneW / 2 - vx) / scale;
  const cy = (el.noteScroll.scrollTop + paneH / 2) / scale;
  zoom = clamp(z, 0.5, 3.5);
  recompute();
  updateSpacer();
  const pageW = p.w * scale;
  if (pageW > paneW) el.noteScroll.scrollLeft = clamp(cx * scale - paneW / 2, 0, pageW - paneW);
  else el.noteScroll.scrollLeft = 0;
  el.noteScroll.scrollTop = clamp(cy * scale - paneH / 2, 0, Math.max(0, p.h * scale + 80 - paneH));
  scrollTop = el.noteScroll.scrollTop;
  redraw();
  updateZoomLabel();
  requestAnimationFrame(resize);
}
el.zoomIn.addEventListener('click', () => setZoom(zoom * 1.2));
el.zoomOut.addEventListener('click', () => setZoom(zoom / 1.2));
el.zoomLabel.addEventListener('click', () => { zoom = 1; afterPageSwitch(); redraw(); updateZoomLabel(); });

/* ==================== 导出 / 投影 ==================== */
el.exportBtn.addEventListener('click', () => {
  const p = pageNow();
  if (!p) return;
  let maxY = 0;
  for (const s of p.strokes) maxY = Math.max(maxY, getBB(s).maxY);
  const H = clamp(maxY + 400, 1200, 14000);
  const k = Math.min(1, 1400 / p.w);
  const c = document.createElement('canvas');
  c.width = Math.round(p.w * k);
  c.height = Math.round(H * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  for (const s of p.strokes) drawStroke(ctx, s);
  c.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = p.title + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  });
});

function fsEnter() {
  if (desktop) { desktop.setFullScreen(true); return; }
  const p = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
  if (p && p.catch) p.catch(() => {});
}
function fsExit() {
  if (desktop) { desktop.setFullScreen(false); return; }
  if (document.fullscreenElement && document.exitFullscreen) {
    const p = document.exitFullscreen();
    if (p && p.catch) p.catch(() => {});
  }
}
function toggleFull() {
  if (desktop) { desktop.toggleFullScreen(); return; }
  if (document.fullscreenElement) fsExit(); else fsEnter();
}
if (el.fullBtn) el.fullBtn.addEventListener('click', toggleFull);

function enterPresent() {
  if (document.body.classList.contains('present')) return;
  document.body.classList.add('present');
  selection.clear();
  fsEnter();
  toast('投影模式 · 按 P 或 Esc 退出');
  setTimeout(resize, 80);
}
function exitPresent() {
  if (!document.body.classList.contains('present')) return;
  document.body.classList.remove('present');
  fsExit();
  setTimeout(resize, 80);
}
el.presentBtn.addEventListener('click', () => {
  document.body.classList.contains('present') ? exitPresent() : enterPresent();
});
if (desktop && desktop.onFullScreen) {
  desktop.onFullScreen((v) => {
    if (!v) {
      document.body.classList.remove('present');
      setTimeout(resize, 80);
    }
  });
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) document.body.classList.remove('present');
  setTimeout(resize, 80);
});

/* ==================== 导入 ==================== */
async function importFiles(files) {
  const list = Array.prototype.slice.call(files || []);
  for (const f of list) {
    const name = (f.name || '').toLowerCase();
    try {
      if (f.type && f.type.indexOf('image/') === 0) {
        toast('正在插入图片…');
        const pages = await window.InkImport.imagePages(f);
        setDoc(stripExt(f.name || '图片'), pages);
      } else if (name.endsWith('.pdf')) {
        toast('正在解析 PDF…');
        const pages = await window.InkImport.pdfPages(f, (i, t) => toast('渲染 PDF ' + i + '/' + t));
        setDoc(stripExt(f.name || 'PDF'), pages);
      } else if (name.endsWith('.docx')) {
        toast('正在解析 Word…');
        const pages = await window.InkImport.docxPages(f);
        setDoc(stripExt(f.name || 'Word'), pages);
      } else if (name.endsWith('.doc')) {
        toast('旧版 .doc 暂不支持，请另存为 .docx 或 PDF');
      } else {
        toast('不支持的文件：' + (f.name || ''));
      }
    } catch (err) {
      console.error(err);
      toast('导入失败：' + (err && err.message ? err.message : String(err)));
    }
  }
}
if (el.wsBtn) el.wsBtn.addEventListener('click', chooseWorkspace);
el.importBtn.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files && el.fileInput.files.length) importFiles(el.fileInput.files);
  el.fileInput.value = '';
});
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') < 0) return;
  dragDepth++;
  el.dropmask.classList.add('show');
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.dropmask.classList.remove('show');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.dropmask.classList.remove('show');
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) importFiles(files);
});
window.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.files;
  if (items && items.length) { e.preventDefault(); importFiles(items); }
});

/* ==================== 键盘 ==================== */
window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!spaceDown) { spaceDown = true; el.noteScroll.style.cursor = 'grab'; }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copySel(); return; }
  if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClip(); return; }
  if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); copySel(); deleteSel(); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === '1') { activePen = 0; tool = 'pen'; renderToolbar(); save(); return; }
  if (e.key === '2') { activePen = 1; tool = 'pen'; renderToolbar(); save(); return; }
  if (e.key === '3') { activePen = 2; tool = 'pen'; renderToolbar(); save(); return; }
  if (e.key === '4') { activePen = 3; tool = 'pen'; renderToolbar(); save(); return; }
  if (e.key.toLowerCase() === 'e') { tool = 'eraser'; renderToolbar(); return; }
  if (e.key.toLowerCase() === 'l') { tool = 'lasso'; renderToolbar(); return; }
  if (e.key.toLowerCase() === 'm') { tool = 'marquee'; renderToolbar(); return; }
  if (e.key.toLowerCase() === 'r') { tool = 'ruler'; renderToolbar(); return; }
  if (e.key.toLowerCase() === 'h') { togglePin(); return; }
  if (e.key.toLowerCase() === 'f') { toggleFull(); return; }
  if (e.key.toLowerCase() === 'p') { e.preventDefault(); document.body.classList.contains('present') ? exitPresent() : enterPresent(); return; }
  if (e.key === 'Escape') {
    if (selection.size) { selection.clear(); redraw(); } else exitPresent();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!selection.size) return;
    e.preventDefault();
    deleteSel();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; el.noteScroll.style.cursor = ''; }
});

window.addEventListener('beforeunload', () => {
  try {
    saveView();
    state.ui = uiState();
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (e) { /* ignore */ }
});

/* ==================== 尺寸 ==================== */
function resize() {
  if (el.side.classList.contains('open')) positionSidePanel();
  const w = el.noteScroll.clientWidth || 0;
  const h = el.noteScroll.clientHeight || 0;
  if (w === lastW && h === lastH) { recompute(); return; }
  lastW = w; lastH = h;
  paneW = w; paneH = h;
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  for (const c of [el.bg, el.live]) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = w + 'px';
    c.style.height = h + 'px';
  }
  recompute();
  ensureMinHeight();
  updateSpacer();
  redraw();
}

/* ==================== 演示 ==================== */
function demoDocImage(title, rows) {
  const c = document.createElement('canvas');
  c.width = 1240;
  c.height = 1754;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, 1240, 1754);
  x.fillStyle = '#1c2026';
  x.font = 'bold 36px "Microsoft YaHei", sans-serif';
  x.fillText(title, 96, 130);
  x.font = '21px "Microsoft YaHei", sans-serif';
  x.fillStyle = '#3a3a48';
  for (let i = 0; i < rows; i++) {
    x.fillText((i + 1) + '. 题干占位文字：左边是原卷，右边写推导过程。', 96, 210 + i * 46);
  }
  return c.toDataURL('image/jpeg', 0.85);
}

function seedDemo() {
  const p = pageNow();
  if (!p) return;
  if (!p.doc) {
    setDoc('示例试卷', [
      { w: 1240, h: 1754, url: demoDocImage('示例试卷 · 第一页', 20) },
      { w: 1240, h: 1754, url: demoDocImage('示例试卷 · 第二页', 20) },
    ], true);
  }
  if (!p.strokes.length) {
    const mk = (tool, color, width, pts) => ({ id: uid(), tool: tool, color: color, width: width, bb: null, pts: pts });
    const wave = [];
    for (let i = 0; i <= 120; i++) {
      const t = i / 120;
      wave.push({ x: 110 + t * 620, y: 260 + Math.sin(t * Math.PI * 2.6) * 62, p: 0.25 + 0.7 * Math.abs(Math.sin(t * Math.PI * 4)) });
    }
    p.strokes.push(mk('fountain', '#2563eb', 6.4, wave));
    const note = [];
    for (let i = 0; i <= 40; i++) note.push({ x: 120 + i * 16, y: 470, p: 0.8 });
    p.strokes.push(mk('highlighter', '#f2c200', 6.4 * HIGH_MUL, note));
    const circ = [];
    for (let i = 0; i <= 90; i++) {
      const a = -Math.PI / 2 + (i / 90) * Math.PI * 2;
      circ.push({ x: 900 + Math.cos(a) * 90, y: 300 + Math.sin(a) * 90, p: 0.6 + 0.3 * Math.sin(a * 2) });
    }
    p.strokes.push(mk('ballpoint', '#d93a3a', 3.6, circ));
  }
  if (!p.docInk || !p.docInk.length) {
    const ann = [];
    for (let i = 0; i <= 36; i++) ann.push({ x: 300 + i * 7, y: 690 + Math.sin(i / 4) * 5, p: 0.85 });
    p.docInk = [{ id: uid(), pageIdx: 0, tool: 'ballpoint', color: '#d93a3a', width: 3.6 * 1.6, pts: ann }];
  }
  ensureHeight();
  renderDoc();
  redraw();
  drawDocInk();
  save();
}

/* ==================== 原卷批注（左栏也能写） ==================== */
const DOC_W = 1000;
let docImgEls = [];
let docDrawing = null;
let docErase = null;
let docDpr = 1;
let docLastPenAt = 0;

function docCanvasSize() {
  const w = el.docScroll.clientWidth || 0;
  const h = el.docScroll.clientHeight || 0;
  docDpr = Math.min(window.devicePixelRatio || 1, 2.5);
  el.docInk.width = Math.round(w * docDpr);
  el.docInk.height = Math.round(h * docDpr);
  el.docInk.style.width = w + 'px';
  el.docInk.style.height = h + 'px';
}

function docHit(clientX, clientY) {
  for (let i = 0; i < docImgEls.length; i++) {
    const r = docImgEls[i].getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return { idx: i, rect: r };
  }
  return null;
}

function docLocal(clientX, clientY) {
  const hit = docHit(clientX, clientY);
  if (!hit) return null;
  const k = DOC_W / hit.rect.width;
  return { idx: hit.idx, x: (clientX - hit.rect.left) * k, y: (clientY - hit.rect.top) * k, k: k };
}

function docInkTransform(ctx, img) {
  const sr = el.docScroll.getBoundingClientRect();
  const r = img.getBoundingClientRect();
  const k = r.width / DOC_W;
  ctx.setTransform(docDpr * k, 0, 0, docDpr * k, docDpr * (r.left - sr.left), docDpr * (r.top - sr.top));
  return k;
}

function drawDocInk() {
  if (!el.docInk) return;
  const ctx = el.docInk.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, el.docInk.width, el.docInk.height);
  const p = pageNow();
  if (!p || !p.doc) return;
  const sr = el.docScroll.getBoundingClientRect();
  for (const s of (p.docInk || [])) {
    const img = docImgEls[s.pageIdx];
    if (!img) continue;
    const r = img.getBoundingClientRect();
    if (r.bottom < sr.top - 60 || r.top > sr.bottom + 60) continue;
    docInkTransform(ctx, img);
    drawStroke(ctx, s);
  }
  if (docDrawing) {
    const img = docImgEls[docDrawing.pageIdx];
    if (img) { docInkTransform(ctx, img); drawStroke(ctx, docDrawing); }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function docCursorMove(e) {
  if (!el.docCursor) return;
  const sr = el.docScroll.getBoundingClientRect();
  el.docCursor.style.left = (e.clientX - sr.left) + 'px';
  el.docCursor.style.top = (e.clientY - sr.top) + 'px';
  el.docCursor.style.display = 'block';
  el.docCursor.className = tool === 'eraser' ? 'eraser' : '';
}

function docEraseAt(cx, cy) {
  const p = pageNow();
  const q = docLocal(cx, cy);
  if (!p || !q) return;
  const img = docImgEls[q.idx];
  const k = img ? img.getBoundingClientRect().width / DOC_W : 1;
  const tol = Math.max(4, (8 + (WIDTHS[currentPen().w] || 3) * 2) / (k || 1));
  let changed = false;
  p.docInk = (p.docInk || []).filter((s) => {
    if (s.pageIdx !== q.idx) return true;
    const pts = s.pts;
    if (!pts.length) return false;
    if (pts.length === 1) {
      if (Math.hypot(q.x - pts[0].x, q.y - pts[0].y) <= tol) { changed = true; return false; }
      return true;
    }
    for (let i = 1; i < pts.length; i++) {
      if (segDist(q.x, q.y, pts[i - 1], pts[i]) <= tol) { changed = true; return false; }
    }
    return true;
  });
  if (changed) drawDocInk();
}

function docDown(e) {
  if (e.button === 2) return;
  if (e.pointerType === 'pen') docLastPenAt = performance.now();
  if (e.pointerType === 'touch' && performance.now() - docLastPenAt < 1200) return;
  if (!e.isPrimary) return;
  const p = pageNow();
  if (!p) return;
  e.preventDefault();
  warnIfMouse(e);
  if (!p.doc) { toast('先把 PDF / 图片放到左边'); return; }
  const q = docLocal(e.clientX, e.clientY);
  if (!q) return;
  try { el.docScroll.setPointerCapture(e.pointerId); } catch (err) {}
  docCursorMove(e);
  if (tool === 'eraser') { pushHist(); docErase = new Set(); docEraseAt(e.clientX, e.clientY); return; }
  if (tool === 'lasso') { toast('原卷区先不支持套索，直接拿笔批注就行'); return; }
  const pen = currentPen();
  const isRuler = tool === 'ruler';
  docDrawing = {
    kind: isRuler ? 'ruler' : 'pen',
    pageIdx: q.idx,
    tool: isRuler ? 'ballpoint' : pen.type,
    color: pen.color,
    width: penWidth(pen) * (DOC_W / 1600),
    pts: [{ x: q.x, y: q.y, p: pressureOf(e) }],
  };
  drawDocInk();
}

function docMove(e) {
  if (e.pointerType === 'touch' && performance.now() - docLastPenAt < 1200) return;
  docCursorMove(e);
  if (docErase) { docEraseAt(e.clientX, e.clientY); return; }
  if (!docDrawing) return;
  const co = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents()) || [];
  const list = co.length ? co : [e];
  for (const ev of list) {
    const q = docLocal(ev.clientX, ev.clientY);
    if (!q || q.idx !== docDrawing.pageIdx) continue;
    const last = docDrawing.pts[docDrawing.pts.length - 1];
    if (Math.hypot(q.x - last.x, q.y - last.y) < 1) continue;
    docDrawing.pts.push({ x: q.x, y: q.y, p: pressureOf(ev) });
  }
  drawDocInk();
}

function docUp() {
  if (docErase) { docErase = null; drawDocInk(); save(); return; }
  if (!docDrawing) return;
  const s = docDrawing;
  docDrawing = null;
  const p = pageNow();
  if (s.kind === 'ruler' && s.pts.length > 1) {
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    s.pts = [{ x: a.x, y: a.y, p: 0.8 }, { x: b.x, y: b.y, p: 0.8 }];
  } else if (shapeSnap && s.tool !== 'highlighter') {
    const shape = shapeDetect(s.pts);
    if (shape) { s.pts = shape.pts; s.tool = 'ballpoint'; }
  }
  pushHist();
  s.id = uid();
  if (!Array.isArray(p.docInk)) p.docInk = [];
  p.docInk.push(s);
  drawDocInk();
  save();
}

el.docScroll.addEventListener('pointerdown', docDown);
el.docScroll.addEventListener('pointermove', docMove);
el.docScroll.addEventListener('pointerup', docUp);
el.docScroll.addEventListener('pointercancel', docUp);
el.docScroll.addEventListener('pointerleave', () => { if (el.docCursor) el.docCursor.style.display = 'none'; });
el.docScroll.addEventListener('scroll', () => { drawDocInk(); });
if (window.ResizeObserver) new ResizeObserver(() => { docCanvasSize(); drawDocInk(); }).observe(el.docScroll);

/* ==================== 侧栏拖拽 / 收起 ==================== */
let sideDrag = null;
function setSideWidth(w) {
  if (w < 96) { el.side.style.display = 'none'; return; }
  el.side.style.display = 'flex';
  el.side.style.width = Math.round(w) + 'px';
  el.side.style.flex = '0 0 ' + Math.round(w) + 'px';
}
el.sideResizer.addEventListener('pointerdown', (e) => {
  const hidden = el.side.style.display === 'none';
  sideDrag = { x: e.clientX, w: hidden ? 0 : el.side.getBoundingClientRect().width };
  try { el.sideResizer.setPointerCapture(e.pointerId); } catch (err) {}
});
el.sideResizer.addEventListener('pointermove', (e) => {
  if (!sideDrag) return;
  const w = clamp(sideDrag.w + (e.clientX - sideDrag.x), 0, 420);
  setSideWidth(w);
  resize();
});
el.sideResizer.addEventListener('pointerup', () => { if (sideDrag) { sideDrag = null; save(); } });

/* ==================== 侧栏悬停显示（Codex 式浮层） ==================== */
let sidePinned = false;
let sideTimer = 0;

function positionSidePanel() {
  if (!el.sideBtn) return;
  const r = el.sideBtn.getBoundingClientRect();
  if (!r.width) return;
  el.side.style.left = Math.round(r.right + 10) + 'px';
  el.side.style.top = Math.round(r.top - 4) + 'px';
}

function openSide() {
  clearTimeout(sideTimer);
  positionSidePanel();
  el.side.classList.add('open');
}
function closeSide() {
  if (sidePinned) return;
  el.side.classList.remove('open');
}
function scheduleCloseSide() {
  clearTimeout(sideTimer);
  if (sidePinned) return;
  sideTimer = setTimeout(() => { if (!sidePinned) el.side.classList.remove('open'); }, 380);
}
function toggleSidePin() {
  sidePinned = !sidePinned;
  el.side.classList.toggle('pinned', sidePinned);
  if (el.sideBtn) el.sideBtn.classList.toggle('on', sidePinned);
  if (sidePinned) {
    openSide();
    toast('侧栏已固定（再点一下取消）');
  } else {
    scheduleCloseSide();
    toast('侧栏改为悬停显示：鼠标移到最左图标条就出现');
  }
  save();
}
if (el.edgeHot) el.edgeHot.addEventListener('pointerenter', openSide);
el.side.addEventListener('pointerenter', openSide);
el.side.addEventListener('pointerleave', scheduleCloseSide);
if (el.sideBtn) {
  el.sideBtn.addEventListener('pointerenter', openSide);
  el.sideBtn.addEventListener('pointerleave', scheduleCloseSide);
  el.sideBtn.addEventListener('click', toggleSidePin);
  el.sideBtn.classList.toggle('on', sidePinned);
}

/* ==================== 工具栏自动隐藏 ==================== */
let ribbonPinned = false;
let ribbonTimer = 0;

function armRibbon() {
  clearTimeout(ribbonTimer);
  if (ribbonPinned) return;
  ribbonTimer = setTimeout(() => {
    if (!ribbonPinned) document.body.classList.add('ribbon-hidden');
  }, 2600);
}
function showRibbon() {
  document.body.classList.remove('ribbon-hidden');
  armRibbon();
}
function togglePin() {
  ribbonPinned = !ribbonPinned;
  if (el.pinBtn) {
    el.pinBtn.classList.toggle('on', ribbonPinned);
    el.pinBtn.textContent = ribbonPinned ? '已固定' : '固定';
  }
  if (ribbonPinned) {
    clearTimeout(ribbonTimer);
    document.body.classList.remove('ribbon-hidden');
    toast('工具栏已固定');
  } else {
    toast('工具栏自动隐藏：已开');
    armRibbon();
  }
  save();
}
function applyPin() {
  if (el.pinBtn) {
    el.pinBtn.classList.toggle('on', ribbonPinned);
    el.pinBtn.textContent = ribbonPinned ? '已固定' : '固定';
  }
  if (ribbonPinned) document.body.classList.remove('ribbon-hidden');
}
if (el.ribbon) {
  el.ribbon.addEventListener('pointerenter', showRibbon);
  el.ribbon.addEventListener('pointermove', () => { clearTimeout(ribbonTimer); armRibbon(); });
  el.ribbon.addEventListener('pointerleave', armRibbon);
}
if (el.ribbonHot) el.ribbonHot.addEventListener('pointerenter', showRibbon);
if (el.pinBtn) el.pinBtn.addEventListener('click', togglePin);
window.addEventListener('pointermove', (e) => { if (e.clientY < 6) showRibbon(); }, { passive: true });

/* ==================== 启动 ==================== */

window.addEventListener('error', (e) => {
  try { toast('脚本错误：' + (e.message || e.error)); } catch (err) {}
});

async function boot() {
  loadCalib();
  let ok = false;
  if (desktop) {
    try {
      const ws = await desktop.loadWorkspace();
      if (ws && ws.state && Array.isArray(ws.state.notebooks) && ws.state.notebooks.length) {
        state = ws.state;
        wsDirPath = ws.dir || null;
        if (ws.assets) {
          for (const k in ws.assets) assets.set(k, ws.assets[k]);
          assetDirty = false;
        }
        ok = normalizeState();
      }
    } catch (e) { ok = false; }
  }
  if (!ok) ok = loadState();
  if (!ok) seed();
  if (desktop) updateWsStatus(wsDirPath ? '已绑定 ' + baseName(wsDirPath) : '本地（未绑定）');
  if (new URLSearchParams(location.search).has('demo')) seedDemo();
  ribbonPinned = !!(state.ui && state.ui.ribbonPinned);
  applyPin();
  armRibbon();
  afterPageSwitch();
  renderAll();
  syncHistBtns();
  const forceSideOpen = new URLSearchParams(location.search).has('sideopen');
  openSide();
  if (forceSideOpen) {
    clearTimeout(sideTimer);
    el.side.classList.add('open');
  } else {
    setTimeout(() => { if (!sidePinned) scheduleCloseSide(); }, 1600);
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(el.noteScroll);
  window.addEventListener('resize', resize);
  resize();
  setTimeout(resize, 150);
  setTimeout(resize, 500);
  if (state.ui && state.ui.zoom && state.ui.zoom !== 1 && !(pageNow() && pageNow().view)) {
    setTimeout(() => { try { setZoom(state.ui.zoom); } catch (err) {} }, 260);
  }
  loadAssets().then(() => { renderDoc(); }).catch(() => {});
}

function runSelfTest() {
  const out = [];
  const log = (k, v) => out.push(k + ': ' + v);
  log('geom', paneW + 'x' + paneH + ' scale=' + scale.toFixed(3) + ' h=' + pageNow().h);
  const baseStrokes = pageNow().strokes.length;
  const r = el.noteScroll.getBoundingClientRect();
  const cx = r.left + 240, cy = r.top + 200;
  const opt = (x, y, p) => ({
    pointerId: 1, isPrimary: true, pointerType: 'pen', clientX: x, clientY: y,
    pressure: p, bubbles: true, cancelable: true, buttons: 1,
  });
  el.noteScroll.dispatchEvent(new PointerEvent('pointerdown', opt(cx, cy, 0.5)));
  for (let i = 1; i <= 12; i++) {
    el.noteScroll.dispatchEvent(new PointerEvent('pointermove', opt(cx + i * 8, cy + Math.sin(i) * 6, 0.5 + i * 0.03)));
  }
  el.noteScroll.dispatchEvent(new PointerEvent('pointerup', opt(cx + 96, cy, 0.3)));
  log('strokes', pageNow().strokes.length);
  log('points', pageNow().strokes.length ? pageNow().strokes[0].pts.length : 0);
  undo(); log('undo', pageNow().strokes.length);
  redo(); log('redo', pageNow().strokes.length);

  const p2 = pageNow();
  p2.strokes.push({ id: uid(), tool: 'ballpoint', color: '#1c2026', width: 3, bb: null, pts: [{ x: 100, y: 100, p: 0.7 }, { x: 200, y: 150, p: 0.7 }] });
  p2.strokes.push({ id: uid(), tool: 'ballpoint', color: '#1c2026', width: 3, bb: null, pts: [{ x: 300, y: 420, p: 0.7 }, { x: 420, y: 380, p: 0.7 }] });
  selection = new Set(p2.strokes.map((s) => s.id));
  alignSel('left'); distSel('h'); rotateSel();
  log('aligned', JSON.stringify(selBBox() ? 'ok' : 'no'));
  copySel(); pasteClip();
  log('pasted', pageNow().strokes.length);
  deleteSel();
  log('deleted', pageNow().strokes.length);
  const afterCleanup = pageNow().strokes.length;

  if (pageNow().doc && docImgEls.length) {
    const img0 = docImgEls[0];
    const r0 = img0.getBoundingClientRect();
    const o2 = (x, y) => ({ pointerId: 3, isPrimary: true, pointerType: 'pen', clientX: x, clientY: y, pressure: 0.6, bubbles: true, cancelable: true, buttons: 1 });
    el.docScroll.dispatchEvent(new PointerEvent('pointerdown', o2(r0.left + 40, r0.top + 60)));
    for (let i = 1; i <= 8; i++) el.docScroll.dispatchEvent(new PointerEvent('pointermove', o2(r0.left + 40 + i * 10, r0.top + 60 + i * 5)));
    el.docScroll.dispatchEvent(new PointerEvent('pointerup', o2(r0.left + 120, r0.top + 100)));
    log('docInk', (pageNow().docInk || []).length);
  }

  // 视图记忆：调好缩放和滚动 → 切去新页 → 切回来应恢复
  setZoom(1.6);
  el.noteScroll.scrollTop = 200;
  saveView();
  const pageA = state.sel.page;
  const secA = curObj().sec.id;
  addPageTo(secA);
  log('newPageZoom', zoom.toFixed(2) + ' top=' + el.noteScroll.scrollTop);
  selectPage(pageA);
  log('viewMem', 'zoom=' + zoom.toFixed(2) + ' top=' + el.noteScroll.scrollTop);

  // 框选
  tool = 'marquee';
  renderToolbar();
  const mr = el.noteScroll.getBoundingClientRect();
  const mo = (x, y) => ({ pointerId: 5, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y, pressure: 0.5, bubbles: true, cancelable: true, buttons: 1 });
  el.noteScroll.dispatchEvent(new PointerEvent('pointerdown', mo(mr.left + 8, mr.top + 8)));
  el.noteScroll.dispatchEvent(new PointerEvent('pointermove', mo(mr.left + 220, mr.top + 160)));
  el.noteScroll.dispatchEvent(new PointerEvent('pointerup', mo(mr.left + 220, mr.top + 160)));
  log('marqueeSel', String(selection.size));
  tool = 'pen';
  renderToolbar();

  // 删除按钮 / Delete 键
  const beforeDel = pageNow().strokes.length;
  const delBtn = el.selbar ? el.selbar.querySelector('[data-act="delete"]') : null;
  if (delBtn) delBtn.click();
  log('delBtn', beforeDel + '->' + pageNow().strokes.length + ' sel=' + selection.size);

  // 默认笔：右键笔槽 2
  const penBtn = el.penGroup.querySelector('[data-pen="1"]');
  if (penBtn) penBtn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  log('defaultPen', String(defaultPenIdx));

  setZoom(1.8);
  const bgRect = el.bg.getBoundingClientRect();
  log('canvasFit', bgRect.width.toFixed(1) + 'x' + bgRect.height.toFixed(1) + ' vs ' + (el.bg.width / dpr).toFixed(1) + 'x' + (el.bg.height / dpr).toFixed(1));
  log('hscroll', 'sw=' + el.noteScroll.scrollWidth + ' cw=' + el.noteScroll.clientWidth + ' sl=' + el.noteScroll.scrollLeft + ' scale=' + scale.toFixed(2));
  setZoom(1);

  const before = pageNow().h;
  const deep = before - 160;
  pageNow().strokes.push({ id: uid(), tool: 'ballpoint', color: '#1c2026', width: 3, bb: null, pts: [{ x: 120, y: deep, p: 0.7 }, { x: 260, y: deep + 30, p: 0.7 }] });
  ensureHeight();
  log('grow', before + ' -> ' + pageNow().h);
  const docOk = (pageNow().docInk || []).length >= (pageNow().doc ? 1 : 0);
  out.push('RESULT ' + (pageNow().h > before && afterCleanup === baseStrokes + 3 && docOk ? 'PASS' : 'FAIL'));
  const pre = document.createElement('pre');
  pre.id = 'testout';
  pre.textContent = out.join(String.fromCharCode(10));
  document.body.appendChild(pre);
}

const helpLink = document.getElementById('helpLink');
if (helpLink) {
  helpLink.addEventListener('click', () => {
    toast('1-4 切笔 · E 橡皮 · L 套索 · M 框选 · R 直尺 · H 工具栏 · P 投影 · Ctrl+Z/Y 撤销重做');
  });
}
const aboutLink = document.getElementById('aboutLink');
if (aboutLink) {
  aboutLink.addEventListener('click', () => toast('课堂笔记 · 左原卷 / 右草稿 · 两边都能写'));
}

try {
  boot();
} catch (err) {
  const p = document.createElement('pre');
  p.id = 'booterr';
  p.style.cssText = 'position:fixed;left:0;top:0;z-index:99;background:#fff;color:#b00020;font-size:12px;padding:8px;white-space:pre-wrap;max-width:90vw';
  p.textContent = String((err && err.stack) || err);
  document.body.appendChild(p);
}
if (new URLSearchParams(location.search).has('selftest')) setTimeout(runSelfTest, 300);
