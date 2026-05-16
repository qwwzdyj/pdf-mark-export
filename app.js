// 档案重点筛选器 — 客户端 PDF 标注与精简导出
// 使用 pdf.js 渲染，pdf-lib 导出。所有处理均在浏览器本地完成。

const state = {
  pdfDoc: null,            // pdf.js document
  rawBytes: null,          // 原始 PDF 字节，用于导出
  fileName: 'document.pdf',
  pages: [],               // [{ pageNumber, viewport1, wrapper, canvas, overlay, ctx }]
  annotations: new Map(),  // pageNumber -> [{ id, page, type, x1, y1, x2, y2, color, width }]
  tool: 'underline',
  color: '#e22b2b',
  width: 4,
  zoom: 'width',           // 'page' | 'width' | number
  rendering: false,
};

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

function toast(msg, ms = 2200) {
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

// ---------- pdf.js ready ----------
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
  await whenPdfjsReady();
  state.fileName = file.name;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.rawBytes = bytes;
    const doc = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    state.pdfDoc = doc;
    state.annotations.clear();
    await mountViewer();
    toast(`已加载 ${doc.numPages} 页，开始标注重点`);
  } catch (err) {
    console.error(err);
    toast('PDF 读取失败');
  }
}

for (const input of el.fileInputs) {
  input.addEventListener('change', e => handleFile(e.target.files?.[0]));
}

// ---------- Viewer mount ----------
async function mountViewer() {
  el.emptyState.classList.add('hidden');
  el.viewer.classList.remove('hidden');
  el.toolbar.classList.remove('hidden');
  el.pagesContainer.innerHTML = '';
  state.pages = [];

  for (let p = 1; p <= state.pdfDoc.numPages; p++) {
    const page = await state.pdfDoc.getPage(p);
    const viewport1 = page.getViewport({ scale: 1 });

    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
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
    };
    state.pages.push(entry);
    attachDrawing(entry);
  }

  await renderAllPages();
  updateExportButton();
}

// ---------- Rendering ----------
function computeScale(viewport1) {
  const container = el.pagesContainer.getBoundingClientRect();
  const maxW = Math.max(240, container.width - 4);
  const dprMaxW = maxW; // CSS pixels
  if (state.zoom === 'width') {
    return dprMaxW / viewport1.width;
  }
  if (state.zoom === 'page') {
    const vh = window.innerHeight - 200;
    return Math.min(dprMaxW / viewport1.width, vh / viewport1.height);
  }
  return Number(state.zoom) || 1;
}

async function renderAllPages() {
  for (const page of state.pages) {
    await renderPage(page);
  }
}

async function renderPage(entry) {
  const cssScale = computeScale(entry.viewport1);
  entry.scale = cssScale;
  const dpr = window.devicePixelRatio || 1;
  const viewport = entry.pdfPage.getViewport({ scale: cssScale * dpr });

  entry.canvas.width = viewport.width;
  entry.canvas.height = viewport.height;
  entry.canvas.style.width = (entry.viewport1.width * cssScale) + 'px';
  entry.canvas.style.height = (entry.viewport1.height * cssScale) + 'px';

  entry.overlay.width = viewport.width;
  entry.overlay.height = viewport.height;
  entry.overlay.style.width = entry.canvas.style.width;
  entry.overlay.style.height = entry.canvas.style.height;

  await entry.pdfPage.render({ canvasContext: entry.ctx, viewport }).promise;
  drawAnnotations(entry);
}

function drawAnnotations(entry) {
  const ctx = entry.octx;
  ctx.clearRect(0, 0, entry.overlay.width, entry.overlay.height);
  const list = state.annotations.get(entry.pageNumber) || [];
  const dpr = window.devicePixelRatio || 1;
  const s = entry.scale * dpr; // PDF point -> overlay pixel

  for (const a of list) {
    const x1 = a.x1 * s;
    const x2 = a.x2 * s;
    // Stored y is in PDF coords (origin bottom-left). Convert to canvas (top-left).
    const y1 = entry.overlay.height - a.y1 * s;
    const y2 = entry.overlay.height - a.y2 * s;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = a.color;
    if (a.type === 'highlight') {
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = a.width * 3 * s;
    } else {
      ctx.globalAlpha = 1;
      ctx.lineWidth = a.width * s;
    }
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const hasAnn = list.length > 0;
  entry.wrapper.classList.toggle('has-annotations', hasAnn);
  entry.badge.classList.toggle('hidden', !hasAnn);
}

// ---------- Drawing ----------
function attachDrawing(entry) {
  const overlay = entry.overlay;
  let drawing = false;
  let start = null;
  let preview = null; // { x1, y1, x2, y2 } in PDF points

  function getPdfPoint(ev) {
    const rect = overlay.getBoundingClientRect();
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    // Convert CSS to PDF points (origin bottom-left)
    const x = cssX / entry.scale;
    const yFromTop = cssY / entry.scale;
    const y = entry.viewport1.height - yFromTop;
    return { x, y };
  }

  function drawPreview() {
    drawAnnotations(entry);
    if (!preview) return;
    const ctx = entry.octx;
    const dpr = window.devicePixelRatio || 1;
    const s = entry.scale * dpr;
    const x1 = preview.x1 * s;
    const x2 = preview.x2 * s;
    const y1 = entry.overlay.height - preview.y1 * s;
    const y2 = entry.overlay.height - preview.y2 * s;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (state.tool === 'highlight') {
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = state.width * 3 * s;
    } else {
      ctx.globalAlpha = 1;
      ctx.lineWidth = state.width * s;
    }
    ctx.strokeStyle = state.color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function onDown(ev) {
    ev.preventDefault();
    drawing = true;
    start = getPdfPoint(ev);
    preview = { x1: start.x, y1: start.y, x2: start.x, y2: start.y };
    drawPreview();
  }

  function onMove(ev) {
    if (!drawing) return;
    ev.preventDefault();
    const pt = getPdfPoint(ev);
    let { x: x2, y: y2 } = pt;
    if (state.tool === 'underline') {
      // Underline: keep y level with start for a clean horizontal line
      y2 = start.y;
    }
    preview = { x1: start.x, y1: start.y, x2, y2 };
    drawPreview();
  }

  function onUp(ev) {
    if (!drawing) return;
    ev.preventDefault();
    drawing = false;
    if (!preview) return;
    const len = Math.hypot(preview.x2 - preview.x1, preview.y2 - preview.y1);
    if (len < 4) { preview = null; drawAnnotations(entry); return; }
    const ann = {
      id: uuid(),
      page: entry.pageNumber,
      type: state.tool,
      x1: preview.x1,
      y1: preview.y1,
      x2: preview.x2,
      y2: preview.y2,
      color: state.color,
      width: state.width,
    };
    addAnnotation(ann);
    preview = null;
    drawAnnotations(entry);
  }

  overlay.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  overlay.addEventListener('touchstart', onDown, { passive: false });
  overlay.addEventListener('touchmove', onMove, { passive: false });
  overlay.addEventListener('touchend', onUp);
  overlay.addEventListener('touchcancel', onUp);
}

function addAnnotation(ann) {
  const list = state.annotations.get(ann.page) || [];
  list.push(ann);
  state.annotations.set(ann.page, list);
  updateExportButton();
}

function removeLastOnCurrentVisiblePage() {
  // "Current page" = last visible page wrapper most centered in viewport
  const entry = findFocusedPage();
  if (!entry) return;
  const list = state.annotations.get(entry.pageNumber);
  if (!list || !list.length) {
    toast('当前页没有可撤销的标注');
    return;
  }
  list.pop();
  if (!list.length) state.annotations.delete(entry.pageNumber);
  else state.annotations.set(entry.pageNumber, list);
  drawAnnotations(entry);
  updateExportButton();
}

async function clearCurrentPage() {
  const entry = findFocusedPage();
  if (!entry) return;
  const list = state.annotations.get(entry.pageNumber);
  if (!list || !list.length) {
    toast('当前页没有标注');
    return;
  }
  const ok = await confirmDialog(`确定清空第 ${entry.pageNumber} 页的全部标注？`);
  if (!ok) return;
  state.annotations.delete(entry.pageNumber);
  drawAnnotations(entry);
  updateExportButton();
}

function findFocusedPage() {
  const vhCenter = window.innerHeight / 2;
  let best = null;
  let bestDist = Infinity;
  for (const p of state.pages) {
    const r = p.wrapper.getBoundingClientRect();
    const center = (r.top + r.bottom) / 2;
    const d = Math.abs(center - vhCenter);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

// ---------- Toolbar wiring ----------
for (const btn of el.toolBtns) {
  btn.addEventListener('click', () => {
    el.toolBtns.forEach(b => b.classList.toggle('active', b === btn));
    state.tool = btn.dataset.tool;
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
  renderAllPages();
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
  // Add custom option if not present
  if (!Array.from(el.zoomSelect.options).some(o => o.value === state.zoom)) {
    const opt = document.createElement('option');
    opt.value = state.zoom;
    opt.textContent = Math.round(cur * 100) + '%';
    el.zoomSelect.appendChild(opt);
  }
  el.zoomSelect.value = state.zoom;
  renderAllPages();
}

el.undoBtn.addEventListener('click', removeLastOnCurrentVisiblePage);
el.clearPageBtn.addEventListener('click', clearCurrentPage);

// Resize handling — debounced re-render when width-based zoom
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!state.pdfDoc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderAllPages(), 200);
});

// ---------- Export logic ----------
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
  if (!marked.length) {
    toast('请至少标注一页');
    return;
  }
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
  // copyPages expects zero-based indices
  const indices = markedPages.map(p => p - 1);
  const copied = await out.copyPages(src, indices);

  copied.forEach((page, idx) => {
    out.addPage(page);
    const originalPageNumber = markedPages[idx];
    const list = state.annotations.get(originalPageNumber) || [];
    const { width: pageW, height: pageH } = page.getSize();
    // pdf-lib uses PDF user space (origin bottom-left, points). Our annotations
    // are stored in the same space already (using viewport1 dimensions).
    for (const a of list) {
      const c = hexToRgb(a.color);
      if (a.type === 'highlight') {
        page.drawLine({
          start: { x: a.x1, y: a.y1 },
          end:   { x: a.x2, y: a.y2 },
          thickness: a.width * 3,
          color: rgb(c.r, c.g, c.b),
          opacity: 0.4,
        });
      } else {
        page.drawLine({
          start: { x: a.x1, y: a.y1 },
          end:   { x: a.x2, y: a.y2 },
          thickness: a.width,
          color: rgb(c.r, c.g, c.b),
          opacity: 1,
        });
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
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 500);
}
