// 档案重点筛选器 — 客户端 PDF 标注与精简导出
// 使用 pdf.js 渲染，pdf-lib 导出。所有处理均在浏览器本地完成。

const state = {
  pdfDoc: null,
  rawBytes: null,
  fileName: 'document.pdf',
  pages: [],                // [{ pageNumber, pdfPage, viewport1, wrapper, canvas, overlay, ctx, octx, scale, rendered }]
  annotations: new Map(),   // pageNumber -> Annotation[]
  tool: 'none',             // 'none' | 'line' | 'pen' | 'highlight'
  color: '#e22b2b',
  width: 4,
  zoom: 'width',            // 'page' | 'width' | number
  observer: null,
};

// 标注数据结构：
// 直线：{ id, page, type: 'line', x1, y1, x2, y2, color, width }
// 手写：{ id, page, type: 'pen' | 'highlight', points: [{x,y}, ...], color, width }
// 坐标统一使用 PDF 用户空间（原点左下，单位 pt）

const el = {
  fileInputs: document.querySelectorAll('#file-input, #file-input-empty'),
  emptyState: document.getElementById('empty-state'),
  viewer: document.getElementById('viewer'),
  toolbar: document.getElementById('toolbar'),
  pagesContainer: document.getElementById('pages-container'),
  exportBtn: document.getElementById('export-btn'),
  undoBtn: document.getElementById('undo-btn'),
  clearPageBtn: document.getElementById('clear-page-btn'),
  toolBtns: document.querySelectorAll('.tool-btn[data-tool]'),
  colorBtns: document.querySelectorAll('.color-swatch'),
  widthInput: document.getElementById('width-input'),
  widthValue: document.getElementById('width-value'),
  zoomSelect: document.getElementById('zoom-select'),
  zoomIn: document.getElementById('zoom-in'),
  zoomOut: document.getElementById('zoom-out'),
  annotationCount: document.getElementById('annotation-count'),
  toast: document.getElementById('toast'),
  confirmDialog: document.getElementById('confirm-dialog'),
  confirmTitle: document.getElementById('confirm-title'),
  confirmMessage: document.getElementById('confirm-message'),
};

// ---------- Utilities ----------
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'a-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function toast(msg, ms = 2000) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function hexToRgb(hex) {
  const m = hex.replace('#', '');
  const n = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function confirmDialog(message, title = '提示') {
  return new Promise(resolve => {
    el.confirmTitle.textContent = title;
    el.confirmMessage.textContent = message;
    const dlg = el.confirmDialog;
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'confirm');
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

function whenPdfjsReady() {
  if (window.pdfjsLib) return Promise.resolve();
  return new Promise(r => window.addEventListener('pdfjs-ready', r, { once: true }));
}

// ---------- File loading ----------
async function handleFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    toast('请选择 PDF 文件');
    return;
  }
  toast('正在解析 PDF…', 1500);
  await whenPdfjsReady();
  state.fileName = file.name;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.rawBytes = bytes;
    const doc = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    state.pdfDoc = doc;
    state.annotations.clear();
    await mountViewer();
    toast(`已加载 ${doc.numPages} 页，先在工具栏选择「直线/手写/高亮」开始标注`, 3000);
  } catch (err) {
    console.error(err);
    toast('PDF 读取失败');
  }
}

for (const input of el.fileInputs) {
  input.addEventListener('change', e => handleFile(e.target.files?.[0]));
}

// ---------- Viewer mount (lazy render) ----------
async function mountViewer() {
  el.emptyState.classList.add('hidden');
  el.viewer.classList.remove('hidden');
  el.toolbar.classList.remove('hidden');
  el.pagesContainer.innerHTML = '';
  state.pages = [];

  if (state.observer) state.observer.disconnect();
  state.observer = new IntersectionObserver(onIntersect, {
    root: null,
    rootMargin: '600px 0px',
    threshold: 0,
  });

  // 并行拿到每页基础信息（不渲染）
  const pageNums = Array.from({ length: state.pdfDoc.numPages }, (_, i) => i + 1);
  const pdfPages = await Promise.all(pageNums.map(n => state.pdfDoc.getPage(n)));

  for (let i = 0; i < pdfPages.length; i++) {
    const p = pageNums[i];
    const page = pdfPages[i];
    const viewport1 = page.getViewport({ scale: 1 });

    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper placeholder';
    wrapper.dataset.page = p;

    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `第 ${p} 页 / 共 ${state.pdfDoc.numPages} 页`;
    wrapper.appendChild(label);

    const badge = document.createElement('div');
    badge.className = 'page-badge hidden';
    badge.textContent = '已标注';
    wrapper.appendChild(badge);

    const canvas = document.createElement('canvas');
    wrapper.appendChild(canvas);

    const overlay = document.createElement('canvas');
    overlay.className = 'overlay';
    wrapper.appendChild(overlay);

    el.pagesContainer.appendChild(wrapper);

    const entry = {
      pageNumber: p,
      pdfPage: page,
      viewport1,
      wrapper,
      canvas,
      overlay,
      badge,
      ctx: canvas.getContext('2d'),
      octx: overlay.getContext('2d'),
      scale: 1,
      rendered: false,
      renderTask: null,
    };
    state.pages.push(entry);

    applyPlaceholderSize(entry);
    attachDrawing(entry);
    state.observer.observe(wrapper);
  }

  updateExportButton();
}

function applyPlaceholderSize(entry) {
  const cssScale = computeScale(entry.viewport1);
  entry.scale = cssScale;
  const cssW = entry.viewport1.width * cssScale;
  const cssH = entry.viewport1.height * cssScale;
  entry.wrapper.style.width = cssW + 'px';
  entry.wrapper.style.height = cssH + 'px';
  entry.canvas.style.width = cssW + 'px';
  entry.canvas.style.height = cssH + 'px';
  entry.overlay.style.width = cssW + 'px';
  entry.overlay.style.height = cssH + 'px';
}

function onIntersect(entries) {
  for (const ent of entries) {
    if (!ent.isIntersecting) continue;
    const num = +ent.target.dataset.page;
    const entry = state.pages.find(p => p.pageNumber === num);
    if (!entry || entry.rendered) continue;
    renderPage(entry);
  }
}

// ---------- Rendering ----------
function computeScale(viewport1) {
  const container = el.pagesContainer.getBoundingClientRect();
  const maxW = Math.max(240, container.width - 4);
  if (state.zoom === 'width') return maxW / viewport1.width;
  if (state.zoom === 'page') {
    const vh = window.innerHeight - 200;
    return Math.min(maxW / viewport1.width, vh / viewport1.height);
  }
  return Number(state.zoom) || 1;
}

async function renderPage(entry) {
  if (entry.renderTask) entry.renderTask.cancel?.();
  const cssScale = entry.scale;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = entry.pdfPage.getViewport({ scale: cssScale * dpr });

  entry.canvas.width = viewport.width;
  entry.canvas.height = viewport.height;
  entry.overlay.width = viewport.width;
  entry.overlay.height = viewport.height;

  try {
    entry.renderTask = entry.pdfPage.render({ canvasContext: entry.ctx, viewport });
    await entry.renderTask.promise;
    entry.rendered = true;
    entry.wrapper.classList.remove('placeholder');
    drawAnnotations(entry);
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.error(e);
  } finally {
    entry.renderTask = null;
  }
}

function reflowAndRerender() {
  for (const entry of state.pages) {
    applyPlaceholderSize(entry);
    entry.rendered = false;
    entry.wrapper.classList.add('placeholder');
    entry.ctx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
  }
  // 触发可见页重新渲染
  for (const entry of state.pages) {
    const r = entry.wrapper.getBoundingClientRect();
    if (r.bottom > -600 && r.top < window.innerHeight + 600) {
      renderPage(entry);
    }
  }
}

// ---------- Annotation drawing on overlay ----------
function applyStrokeStyle(ctx, type, color, widthPt, scalePx) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  if (type === 'highlight') {
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = widthPt * 3 * scalePx;
  } else {
    ctx.globalAlpha = 1;
    ctx.lineWidth = widthPt * scalePx;
  }
}

function drawAnnotations(entry) {
  const ctx = entry.octx;
  ctx.clearRect(0, 0, entry.overlay.width, entry.overlay.height);
  const list = state.annotations.get(entry.pageNumber) || [];
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const s = entry.scale * dpr;
  const H = entry.overlay.height;

  for (const a of list) {
    applyStrokeStyle(ctx, a.type, a.color, a.width, s);
    ctx.beginPath();
    if (a.type === 'line') {
      ctx.moveTo(a.x1 * s, H - a.y1 * s);
      ctx.lineTo(a.x2 * s, H - a.y2 * s);
    } else {
      const pts = a.points;
      if (!pts || !pts.length) continue;
      ctx.moveTo(pts[0].x * s, H - pts[0].y * s);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x * s, H - pts[i].y * s);
      }
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const hasAnn = list.length > 0;
  entry.wrapper.classList.toggle('has-annotations', hasAnn);
  entry.badge.classList.toggle('hidden', !hasAnn);
}

// ---------- Drawing input ----------
function attachDrawing(entry) {
  const overlay = entry.overlay;
  let drawing = false;
  let preview = null;       // 当前未提交的标注
  let currentTool = null;

  function pdfPointFromEvent(ev) {
    const rect = overlay.getBoundingClientRect();
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    const x = cssX / entry.scale;
    const y = entry.viewport1.height - (cssY / entry.scale);
    return { x, y };
  }

  function isMultiTouch(ev) {
    return ev.touches && ev.touches.length > 1;
  }

  function start(ev) {
    if (state.tool === 'none') return;
    if (isMultiTouch(ev)) return;
    ev.preventDefault();
    drawing = true;
    currentTool = state.tool;
    const pt = pdfPointFromEvent(ev);
    if (currentTool === 'line') {
      preview = {
        id: uuid(), page: entry.pageNumber, type: 'line',
        x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y,
        color: state.color, width: state.width,
      };
    } else {
      preview = {
        id: uuid(), page: entry.pageNumber, type: currentTool, // 'pen' | 'highlight'
        points: [{ x: pt.x, y: pt.y }],
        color: state.color, width: state.width,
      };
    }
    redrawWithPreview();
  }

  function move(ev) {
    if (!drawing) return;
    if (isMultiTouch(ev)) {
      drawing = false;
      preview = null;
      drawAnnotations(entry);
      return;
    }
    ev.preventDefault();
    const pt = pdfPointFromEvent(ev);
    if (preview.type === 'line') {
      preview.x2 = pt.x;
      preview.y2 = pt.y;
    } else {
      const last = preview.points[preview.points.length - 1];
      const dx = pt.x - last.x, dy = pt.y - last.y;
      if (dx * dx + dy * dy > 1) preview.points.push({ x: pt.x, y: pt.y });
    }
    redrawWithPreview();
  }

  function end(ev) {
    if (!drawing) return;
    drawing = false;
    if (!preview) return;
    let valid = false;
    if (preview.type === 'line') {
      const len = Math.hypot(preview.x2 - preview.x1, preview.y2 - preview.y1);
      valid = len >= 3;
    } else {
      valid = preview.points.length >= 2;
    }
    if (valid) {
      const list = state.annotations.get(entry.pageNumber) || [];
      list.push(preview);
      state.annotations.set(entry.pageNumber, list);
      updateExportButton();
    }
    preview = null;
    drawAnnotations(entry);
  }

  function redrawWithPreview() {
    drawAnnotations(entry);
    if (!preview) return;
    const ctx = entry.octx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = entry.scale * dpr;
    const H = entry.overlay.height;
    applyStrokeStyle(ctx, preview.type, preview.color, preview.width, s);
    ctx.beginPath();
    if (preview.type === 'line') {
      ctx.moveTo(preview.x1 * s, H - preview.y1 * s);
      ctx.lineTo(preview.x2 * s, H - preview.y2 * s);
    } else {
      const pts = preview.points;
      ctx.moveTo(pts[0].x * s, H - pts[0].y * s);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * s, H - pts[i].y * s);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  overlay.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);

  overlay.addEventListener('touchstart', start, { passive: false });
  overlay.addEventListener('touchmove', move, { passive: false });
  overlay.addEventListener('touchend', end);
  overlay.addEventListener('touchcancel', end);
}

// ---------- Focused page helpers ----------
function findFocusedPage() {
  const center = window.innerHeight / 2;
  let best = null, bestDist = Infinity;
  for (const p of state.pages) {
    const r = p.wrapper.getBoundingClientRect();
    const c = (r.top + r.bottom) / 2;
    const d = Math.abs(c - center);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

function undoCurrentPage() {
  const entry = findFocusedPage();
  if (!entry) return;
  const list = state.annotations.get(entry.pageNumber);
  if (!list || !list.length) { toast('当前页没有可撤销的标注'); return; }
  list.pop();
  if (!list.length) state.annotations.delete(entry.pageNumber);
  drawAnnotations(entry);
  updateExportButton();
}

async function clearCurrentPage() {
  const entry = findFocusedPage();
  if (!entry) return;
  const list = state.annotations.get(entry.pageNumber);
  if (!list || !list.length) { toast('当前页没有标注'); return; }
  const ok = await confirmDialog(`确定清空第 ${entry.pageNumber} 页的全部标注？`);
  if (!ok) return;
  state.annotations.delete(entry.pageNumber);
  drawAnnotations(entry);
  updateExportButton();
}

// ---------- Toolbar wiring ----------
for (const btn of el.toolBtns) {
  btn.addEventListener('click', () => {
    el.toolBtns.forEach(b => b.classList.toggle('active', b === btn));
    state.tool = btn.dataset.tool;
    el.pagesContainer.classList.toggle('scroll-mode', state.tool === 'none');
  });
}

for (const c of el.colorBtns) {
  c.addEventListener('click', () => {
    el.colorBtns.forEach(b => b.classList.toggle('active', b === c));
    state.color = c.dataset.color;
  });
}

el.widthInput.addEventListener('input', e => {
  state.width = Number(e.target.value);
  el.widthValue.textContent = state.width;
});

el.zoomSelect.addEventListener('change', e => {
  state.zoom = e.target.value;
  reflowAndRerender();
});

el.zoomIn.addEventListener('click', () => bumpZoom(1.25));
el.zoomOut.addEventListener('click', () => bumpZoom(0.8));

function bumpZoom(factor) {
  let cur = Number(state.zoom);
  if (!cur || isNaN(cur)) {
    const focused = findFocusedPage();
    cur = focused ? focused.scale : 1;
  }
  cur = Math.max(0.25, Math.min(4, cur * factor));
  state.zoom = String(Math.round(cur * 100) / 100);
  if (!Array.from(el.zoomSelect.options).some(o => o.value === state.zoom)) {
    const opt = document.createElement('option');
    opt.value = state.zoom;
    opt.textContent = Math.round(cur * 100) + '%';
    el.zoomSelect.appendChild(opt);
  }
  el.zoomSelect.value = state.zoom;
  reflowAndRerender();
}

el.undoBtn.addEventListener('click', undoCurrentPage);
el.clearPageBtn.addEventListener('click', clearCurrentPage);

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!state.pdfDoc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(reflowAndRerender, 200);
});

// ---------- Export ----------
function getMarkedPages() {
  const pages = [];
  for (const [p, list] of state.annotations.entries()) {
    if (list && list.length) pages.push(p);
  }
  pages.sort((a, b) => a - b);
  return pages;
}

function updateExportButton() {
  const marked = getMarkedPages();
  el.exportBtn.disabled = !state.pdfDoc;
  el.annotationCount.textContent = `${marked.length} 页已标注`;
}

el.exportBtn.addEventListener('click', async () => {
  if (!state.pdfDoc) return;
  const marked = getMarkedPages();
  if (!marked.length) { toast('请至少标注一页'); return; }
  const ok = await confirmDialog(
    `将导出 ${marked.length} 页已标注内容，未标注页面会被删除。继续？`,
    '确认导出'
  );
  if (!ok) return;
  try {
    el.exportBtn.disabled = true;
    el.exportBtn.textContent = '正在生成…';
    await exportMarkedPdf(marked);
    toast(`已导出 ${marked.length} 页`);
  } catch (err) {
    console.error(err);
    toast('导出失败：' + (err.message || err));
  } finally {
    el.exportBtn.disabled = false;
    el.exportBtn.textContent = '导出已标注页面';
    updateExportButton();
  }
});

async function exportMarkedPdf(markedPages) {
  const { PDFDocument, rgb } = window.PDFLib;
  const src = await PDFDocument.load(state.rawBytes.slice());
  const out = await PDFDocument.create();
  const indices = markedPages.map(p => p - 1);
  const copied = await out.copyPages(src, indices);

  copied.forEach((page, idx) => {
    out.addPage(page);
    const originalPageNumber = markedPages[idx];
    const list = state.annotations.get(originalPageNumber) || [];

    for (const a of list) {
      const c = hexToRgb(a.color);
      const isHi = a.type === 'highlight';
      const thickness = isHi ? a.width * 3 : a.width;
      const opacity = isHi ? 0.4 : 1;
      const color = rgb(c.r, c.g, c.b);

      if (a.type === 'line') {
        page.drawLine({
          start: { x: a.x1, y: a.y1 },
          end:   { x: a.x2, y: a.y2 },
          thickness, color, opacity,
        });
      } else {
        const pts = a.points || [];
        for (let i = 0; i < pts.length - 1; i++) {
          page.drawLine({
            start: { x: pts[i].x,   y: pts[i].y },
            end:   { x: pts[i+1].x, y: pts[i+1].y },
            thickness, color, opacity,
          });
        }
      }
    }
  });

  const bytes = await out.save();
  const base = state.fileName.replace(/\.pdf$/i, '');
  triggerDownload(bytes, `${base}-marked-pages.pdf`);
}

function triggerDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}
