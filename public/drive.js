// Client pentru interfața Drive. Expune window.drive (contractul folosit de index.html).
// Fișierele se transferă direct către/din R2 prin funcțiile Cloudflare Pages (/api/upload, /api/file).
(() => {
  'use strict';

  const API = '/api/drive';
  const fileUrl = id => `/api/file/${encodeURIComponent(id)}`;
  const CDN = {
    pdf: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
    pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
    mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js',
    xlsx: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  };
  const MB = 1024 * 1024;

  class DriveError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = 'DriveError';
      this.status = status;
    }
  }
  const abortError = () => new DOMException('Operația a fost întreruptă.', 'AbortError');

  // ---------- apel API ----------

  async function api(action, payload = {}, { signal } = {}) {
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action, ...payload }),
        signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new DriveError('Nu mă pot conecta la server. Verifică conexiunea la internet.', 0);
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {
      throw new DriveError(`Răspuns neașteptat de la server (${res.status}).`, res.status);
    }
    if (!res.ok) throw new DriveError(data.error || `Eroare de server (${res.status}).`, res.status);
    return data;
  }

  // ---------- lista de elemente (cu cache scurt, ca să nu încărcăm serverul) ----------

  const CACHE_MS = 20000;
  let itemsCache = null;
  function invalidate() { itemsCache = null; }
  function getItems() {
    if (!itemsCache || Date.now() - itemsCache.at > CACHE_MS) {
      const entry = { at: Date.now(), promise: null };
      entry.promise = api('items').catch(error => {
        if (itemsCache === entry) itemsCache = null;
        throw error;
      });
      itemsCache = entry;
    }
    return itemsCache.promise;
  }

  // ---------- tipuri de fișiere ----------

  const EXT_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  };
  const extOf = name => (String(name || '').match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
  const mimeOf = item => EXT_MIME[extOf(item.name)] || (item.type && item.type !== 'application/octet-stream' ? item.type : '');

  function documentType(item) {
    const ext = extOf(item.name);
    const mime = String(item.type || '');
    if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
    if (ext === 'docx') return 'docx';
    if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
    if (['txt', 'md', 'csv', 'tsv', 'json', 'log'].includes(ext) || mime === 'text/plain') return 'text';
    return null;
  }

  function inlineType(item) {
    const mime = mimeOf(item);
    if (mime.startsWith('image/')) return /^image\/(png|jpeg|gif|webp|bmp|avif|svg\+xml)$/.test(mime);
    if (mime.startsWith('audio/')) return !!document.createElement('audio').canPlayType(mime);
    if (mime.startsWith('video/')) return !!document.createElement('video').canPlayType(mime);
    return false;
  }

  // ---------- utilitare DOM ----------

  function h(tag, style = '', props = {}) {
    const el = document.createElement(tag);
    if (style) el.style.cssText = style;
    Object.assign(el, props);
    return el;
  }

  const scriptPromises = new Map();
  function loadScript(url) {
    if (!scriptPromises.has(url)) {
      scriptPromises.set(url, new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = resolve;
        script.onerror = () => {
          scriptPromises.delete(url);
          reject(new DriveError('Nu am putut încărca modulul de citire. Verifică conexiunea și reîncearcă.'));
        };
        document.head.append(script);
      }));
    }
    return scriptPromises.get(url);
  }

  function saveBlobCompat(blob, name) {
    if (typeof window.saveBlob === 'function') return window.saveBlob(blob, name);
    const url = URL.createObjectURL(blob);
    const a = h('a', 'display:none', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function fetchFile(item, { signal, headers } = {}) {
    let res;
    try {
      res = await fetch(fileUrl(item.id), { signal, headers, credentials: 'same-origin' });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new DriveError('Nu mă pot conecta la server. Verifică conexiunea la internet.');
    }
    if (!res.ok && res.status !== 206) {
      throw new DriveError(res.status === 404 ? 'Fișierul nu mai este disponibil.' : `Descărcarea a eșuat (${res.status}).`, res.status);
    }
    return res;
  }

  // ---------- încărcare în fragmente, cu reluare ----------

  const RESUME_PREFIX = 'drive-upload:';
  const resumeKey = (file, parentId) => `${RESUME_PREFIX}${file.name}|${file.size}|${file.lastModified}|${parentId}`;
  function loadResume(key) {
    try {
      const rec = JSON.parse(localStorage.getItem(key) || 'null');
      if (rec && rec.exp > Date.now()) return rec;
    } catch { /* ignorat */ }
    return null;
  }
  function saveResume(key, rec) { try { localStorage.setItem(key, JSON.stringify(rec)); } catch { /* ignorat */ } }
  function clearResume(key) { try { localStorage.removeItem(key); } catch { /* ignorat */ } }

  function putPart(token, partNumber, blob, { signal, onBytes }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const xhr = new XMLHttpRequest();
      const onAbort = () => xhr.abort();
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      xhr.open('PUT', `/api/upload?token=${encodeURIComponent(token)}&part=${partNumber}`);
      xhr.upload.onprogress = event => { if (event.lengthComputable) onBytes?.(event.loaded); };
      xhr.onload = () => {
        cleanup();
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* ignorat */ }
        if (xhr.status >= 200 && xhr.status < 300 && data.etag) resolve(data.etag);
        else reject(new DriveError(data.error || `Încărcarea fragmentului a eșuat (${xhr.status}).`, xhr.status));
      };
      xhr.onerror = () => { cleanup(); reject(new DriveError('Conexiunea a fost întreruptă în timpul încărcării.', 0)); };
      xhr.onabort = () => { cleanup(); reject(abortError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      xhr.send(blob);
    });
  }

  async function putPartWithRetry(token, partNumber, blob, options) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await putPart(token, partNumber, blob, options);
      } catch (error) {
        lastError = error;
        const retryable = error.status === 0 || error.status >= 500;
        if (error.name === 'AbortError' || !retryable) throw error;
        await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
        options.onBytes?.(0);
      }
    }
    throw lastError;
  }

  async function uploadFile(item, { signal, onProgress } = {}) {
    const file = item.blob;
    const total = file.size;
    const report = (phase, bytes) => { try { onProgress?.({ phase, bytes, total }); } catch { /* ignorat */ } };
    const parentId = item.parentId || 'root';
    const key = resumeKey(file, parentId);

    report('verify', 0);
    let rec = loadResume(key);
    if (!rec) {
      const init = await api('uploadInit', {
        item: { id: item.id, name: item.name, parentId, size: file.size, type: file.type || item.type || '', status: item.status },
      }, { signal });
      if (init.done) { invalidate(); report('upload', total); return; }
      rec = { id: item.id, token: init.token, partSize: init.partSize, parts: init.parts, etags: {}, exp: Date.now() + 5.5 * 24 * 3600 * 1000 };
      saveResume(key, rec);
    }
    if (signal?.aborted) throw abortError();

    const partBytes = n => (n < rec.parts ? rec.partSize : file.size - rec.partSize * (rec.parts - 1));
    const pending = [];
    for (let n = 1; n <= rec.parts; n++) if (!rec.etags[n]) pending.push(n);
    let finished = Object.keys(rec.etags).reduce((sum, n) => sum + partBytes(Number(n)), 0);
    const inFlight = new Map();
    const emit = () => report('upload', finished + [...inFlight.values()].reduce((a, b) => a + b, 0));
    emit();

    const stop = new AbortController();
    signal?.addEventListener('abort', () => stop.abort(), { once: true });
    if (signal?.aborted) stop.abort();
    let cursor = 0;
    const worker = async () => {
      try {
        while (cursor < pending.length) {
          if (stop.signal.aborted) throw abortError();
          const n = pending[cursor++];
          const start = (n - 1) * rec.partSize;
          const blob = file.slice(start, start + partBytes(n));
          const etag = await putPartWithRetry(rec.token, n, blob, {
            signal: stop.signal,
            onBytes: bytes => { inFlight.set(n, bytes); emit(); },
          });
          inFlight.delete(n);
          finished += blob.size;
          rec.etags[n] = etag;
          saveResume(key, rec);
          emit();
        }
      } catch (error) {
        stop.abort();
        throw error;
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(3, pending.length) }, worker));
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) {
      const real = failed.find(r => r.reason?.name !== 'AbortError') || failed[0];
      if (real.reason?.status === 410 || real.reason?.status === 404) clearResume(key);
      throw real.reason;
    }

    try {
      await api('uploadComplete', {
        token: rec.token,
        parts: Array.from({ length: rec.parts }, (_, i) => ({ partNumber: i + 1, etag: rec.etags[i + 1] })),
      }, { signal });
    } catch (error) {
      if (error.status === 400 || error.status === 410) clearResume(key);
      throw error;
    }
    clearResume(key);
    invalidate();
    report('upload', total);
  }

  // ---------- descărcare folder ca ZIP ----------

  async function downloadFolder(folder) {
    if (typeof JSZip === 'undefined') throw new DriveError('Modulul ZIP nu este încărcat. Reîncarcă pagina.');
    const all = await getItems();
    const children = new Map();
    for (const entry of all) {
      if (entry.status !== 'approved') continue;
      const key = entry.parentId || 'root';
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(entry);
    }
    const files = [];
    (function walk(id, path, depth) {
      if (depth > 30) return;
      for (const child of children.get(id) || []) {
        if (child.isFolder) walk(child.id, `${path}${child.name}/`, depth + 1);
        else files.push({ item: child, path: `${path}${child.name}` });
      }
    })(folder.id, '', 0);
    if (!files.length) throw new DriveError('Folderul nu conține fișiere aprobate.');
    const totalBytes = files.reduce((sum, f) => sum + f.item.size, 0);
    if (totalBytes > 500 * MB) {
      throw new DriveError('Folderul are peste 500 MB și nu poate fi arhivat în browser. Descarcă fișierele separat.');
    }
    const zip = new JSZip();
    const used = new Set();
    for (const { item, path } of files) {
      let name = path;
      for (let k = 1; used.has(name); k++) {
        const dot = path.lastIndexOf('.');
        name = dot > path.lastIndexOf('/') + 1 ? `${path.slice(0, dot)} (${k})${path.slice(dot)}` : `${path} (${k})`;
      }
      used.add(name);
      zip.file(name, await (await fetchFile(item)).blob());
    }
    saveBlobCompat(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), `${folder.name}.zip`);
    return true;
  }

  // ---------- cititor de documente ----------

  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, iframe, object, embed, link, meta, form, base').forEach(node => node.remove());
    doc.body.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.replace(/\s/g, '').toLowerCase();
        const unsafeUrl = ['href', 'src', 'xlink:href', 'action'].includes(name) && /^(javascript:|vbscript:|data:text)/.test(value);
        if (name.startsWith('on') || unsafeUrl) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A') { el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    });
    return doc.body.innerHTML;
  }

  // Cadru comun: bară de zoom + zonă derulabilă.
  function buildShell(body) {
    body.replaceChildren();
    const wrap = h('div', 'width:100%;height:100%;min-height:0;display:flex;flex-direction:column;');
    const bar = h('div', 'display:flex;align-items:center;justify-content:center;gap:8px;padding:6px;flex:0 0 auto;');
    const mk = (label, title) => h('button', 'min-width:36px;height:32px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;font-weight:600;cursor:pointer;', { type: 'button', textContent: label, title });
    const out = mk('−', 'Micșorează');
    const label = h('span', 'min-width:48px;text-align:center;font-size:12px;color:#475569;', { textContent: '100%' });
    const inn = mk('+', 'Mărește');
    bar.append(out, label, inn);
    const scroller = h('div', 'flex:1 1 auto;min-height:0;overflow:auto;background:#fff;border-radius:12px;');
    wrap.append(bar, scroller);
    body.append(wrap);
    let zoom = 1;
    let handler = () => {};
    const set = value => {
      zoom = Math.min(3, Math.max(0.5, Math.round(value * 100) / 100));
      label.textContent = `${Math.round(zoom * 100)}%`;
      handler(zoom);
    };
    out.onclick = () => set(zoom - 0.25);
    inn.onclick = () => set(zoom + 0.25);
    return { scroller, onZoom: fn => { handler = fn; } };
  }

  async function renderPdf(item, shell, signal) {
    await loadScript(CDN.pdf);
    pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
    const task = pdfjsLib.getDocument({ url: fileUrl(item.id), withCredentials: true });
    signal?.addEventListener('abort', () => task.destroy().catch(() => {}), { once: true });
    let pdf;
    try { pdf = await task.promise; } catch (error) {
      if (signal?.aborted) return;
      throw new DriveError('PDF-ul nu a putut fi deschis. Încearcă „Descarcă”.');
    }
    if (signal?.aborted) return;
    const first = await pdf.getPage(1);
    const v1 = first.getViewport({ scale: 1 });
    const box = h('div', 'display:flex;flex-direction:column;align-items:center;gap:12px;padding:12px;background:#e2e8f0;min-width:max-content;');
    shell.scroller.append(box);
    let zoom = 1;
    const baseWidth = () => Math.max(280, Math.min(shell.scroller.clientWidth - 24, 1100));
    const size = canvas => {
      const w = baseWidth() * zoom;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${w * Number(canvas.dataset.ratio)}px`;
    };
    const canvases = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const canvas = h('canvas', 'background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.2);');
      canvas.dataset.page = String(n);
      canvas.dataset.ratio = String(v1.height / v1.width);
      size(canvas);
      box.append(canvas);
      canvases.push(canvas);
    }
    shell.onZoom(value => { zoom = value; canvases.forEach(size); });
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const canvas = entry.target;
        if (!entry.isIntersecting || canvas.dataset.rendered) continue;
        canvas.dataset.rendered = '1';
        pdf.getPage(Number(canvas.dataset.page)).then(page => {
          if (signal?.aborted) return;
          const natural = page.getViewport({ scale: 1 });
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const scale = Math.min((baseWidth() / natural.width) * dpr * 1.5, 3000 / natural.width);
          const viewport = page.getViewport({ scale });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.dataset.ratio = String(natural.height / natural.width);
          size(canvas);
          return page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        }).catch(() => {});
      }
    }, { root: shell.scroller, rootMargin: '800px' });
    canvases.forEach(canvas => observer.observe(canvas));
    signal?.addEventListener('abort', () => observer.disconnect(), { once: true });
  }

  async function renderDocx(item, shell, signal) {
    if (item.size > 25 * MB) throw new DriveError('Documentul este prea mare pentru previzualizare. Folosește „Descarcă”.');
    await loadScript(CDN.mammoth);
    const buffer = await (await fetchFile(item, { signal })).arrayBuffer();
    if (signal?.aborted) return;
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
    if (signal?.aborted) return;
    const page = h('div', 'max-width:820px;margin:0 auto;padding:24px;font-size:16px;line-height:1.6;color:#0f172a;');
    page.className = 'document-reader';
    page.innerHTML = sanitizeHtml(result.value);
    if (!page.textContent.trim() && !page.querySelector('img')) page.textContent = 'Documentul nu conține text afișabil.';
    shell.scroller.append(page);
    shell.onZoom(value => { page.style.fontSize = `${16 * value}px`; });
  }

  async function renderXlsx(item, shell, signal) {
    if (item.size > 25 * MB) throw new DriveError('Tabelul este prea mare pentru previzualizare. Folosește „Descarcă”.');
    await loadScript(CDN.xlsx);
    const buffer = await (await fetchFile(item, { signal })).arrayBuffer();
    if (signal?.aborted) return;
    const workbook = XLSX.read(buffer, { type: 'array' });
    const root = h('div', 'padding:12px;font-size:14px;');
    const tabs = h('div', 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;');
    const holder = h('div', 'overflow:auto;');
    root.append(tabs, holder);
    const show = name => {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' }).slice(0, 2000);
      const table = h('table', 'border-collapse:collapse;');
      for (const row of rows) {
        const tr = h('tr');
        for (const cell of row.slice(0, 60)) tr.append(h('td', 'border:1px solid #cbd5e1;padding:4px 8px;white-space:nowrap;', { textContent: String(cell) }));
        table.append(tr);
      }
      holder.replaceChildren(table);
      [...tabs.children].forEach(tab => { tab.style.background = tab.dataset.sheet === name ? '#dbeafe' : '#fff'; });
    };
    for (const name of workbook.SheetNames) {
      const tab = h('button', 'padding:4px 10px;border:1px solid #cbd5e1;border-radius:8px;cursor:pointer;', { type: 'button', textContent: name });
      tab.dataset.sheet = name;
      tab.onclick = () => show(name);
      tabs.append(tab);
    }
    if (!workbook.SheetNames.length) throw new DriveError('Fișierul nu conține foi de calcul.');
    show(workbook.SheetNames[0]);
    shell.scroller.append(root);
    shell.onZoom(value => { root.style.fontSize = `${14 * value}px`; });
  }

  async function renderText(item, shell, signal) {
    const headers = item.size > 2 * MB ? { Range: `bytes=0-${2 * MB - 1}` } : undefined;
    const text = await (await fetchFile(item, { signal, headers })).text();
    if (signal?.aborted) return;
    const pre = h('pre', 'margin:0;padding:20px;white-space:pre-wrap;word-break:break-word;font:14px/1.6 ui-monospace,monospace;color:#0f172a;');
    pre.textContent = item.size > 2 * MB ? `${text}\n\n[… previzualizarea arată doar primii 2 MB. Descarcă fișierul pentru conținutul complet.]` : text;
    shell.scroller.append(pre);
    shell.onZoom(value => { pre.style.fontSize = `${14 * value}px`; });
  }

  async function renderDocument(item, body, { signal } = {}) {
    const type = documentType(item);
    if (!type) throw new DriveError('Acest format nu are cititor în website.');
    const shell = buildShell(body);
    const render = { pdf: renderPdf, docx: renderDocx, xlsx: renderXlsx, text: renderText }[type];
    await render(item, shell, signal);
  }

  // ---------- window.drive ----------

  window.drive = {
    maxFileSize: 5 * 1024 * MB,
    maxBufferedSize: 50 * MB,
    maxInlineSize: 25 * MB,

    async initialize() { return api('session'); },
    async session() { return api('session'); },
    async signIn(email, password) { invalidate(); return api('signin', { email, password }); },
    async signOut() { invalidate(); return api('signout'); },

    async items() { return structuredClone(await getItems()); },
    async item(id) {
      const found = (await getItems()).find(entry => entry.id === id);
      if (!found) throw new DriveError('Elementul nu mai este disponibil.', 404);
      return structuredClone(found);
    },
    async save(item, options = {}) {
      if (item.blob) return uploadFile(item, options);
      const { blob, ...metadata } = item;
      await api('save', { item: metadata }, { signal: options.signal });
      invalidate();
    },
    async remove(id) { await api('remove', { id }); invalidate(); },

    async links() { return api('links'); },
    async linkProposals() { return api('linkProposals'); },
    async proposeLink({ title, url }) { await api('proposeLink', { title, url }); },
    async saveLink(id, { title, url }) { await api('saveLink', { id, title, url }); },
    async removeLink(id) { await api('removeLink', { id }); },
    async reviewLink(id, decision) { await api('reviewLink', { id, decision }); },
    async reorderLink(id, position) { await api('reorderLink', { id, position }); },

    async tables() { return api('tables'); },
    async saveTable(id, { title, content }) { return api('saveTable', { id, title, content }); },
    async removeTable(id) { await api('removeTable', { id }); },

    invalidate,
    setConnectionStatus(message, isError) {
      const el = document.getElementById('connectionStatus');
      if (el) { el.textContent = message; el.dataset.error = isError ? '1' : ''; }
    },

    documentType,
    inlineType,
    renderDocument,
    async previewUrl(item) { return fileUrl(item.id); },
    loadThumbnails() {
      document.querySelectorAll('img[data-drive-thumbnail]').forEach(img => {
        if (img.getAttribute('src')) return;
        img.onerror = () => { img.style.visibility = 'hidden'; };
        img.src = fileUrl(img.dataset.driveThumbnail);
      });
    },
    async loadBlob(item) {
      item.blob = await (await fetchFile(item)).blob();
      return item.blob;
    },
    async download(item) {
      if (item.isFolder) return downloadFolder(item);
      const a = h('a', 'display:none', { href: `${fileUrl(item.id)}?dl=1`, download: item.name });
      document.body.append(a);
      a.click();
      a.remove();
      return true;
    },
    async importLocal() { return { imported: 0, skipped: 0, failed: 0 }; },
  };
})();
