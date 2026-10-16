// window.tables: secțiunea „Tabele publice”.
//  • Oricine vede tabelele și poate „propune modificare”; nimic nu se schimbă până nu aprobă un utilizator autentificat.
//  • Utilizatorii autentificați editează direct tabelul într-un editor tip Excel (celule, linkuri, lățimea coloanelor, înălțimea rândurilor).
//  • În celule, linkurile se scriu [text](https://adresa) sau ca adresă simplă https://… și apar albastre și subliniate.
(() => {
  'use strict';

  const L = { minCol: 60, maxCol: 800, defCol: 160, minRow: 26, maxRow: 400, maxRows: 500, maxCols: 40, cell: 2000 };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  let authenticated = false;
  let currentQuery = '';
  let flash = '';
  let renderSeq = 0;

  const el = (tag, cls = '', text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, cls, onClick) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  // ---------- model ----------
  // model = { rows: string[][], colWidths: (number|null)[]|null, rowHeights: (number|null)[]|null }

  function parseDelimited(text) {
    const lines = String(text || '').split(/\r?\n/).filter(line => line.trim() !== '');
    if (!lines.length) return [];
    const first = lines[0];
    const delimiter = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const source = String(text).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === delimiter) { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    row.push(cell);
    rows.push(row);
    return rows.filter(r => r.some(c => c.trim() !== ''));
  }

  const blankRow = cols => Array.from({ length: cols }, () => '');
  const validSizes = (list, n) =>
    Array.isArray(list) && list.length === n && list.some(v => typeof v === 'number')
      ? list.map(v => (typeof v === 'number' ? v : null))
      : null;

  function makeModel(rows, colWidths = null, rowHeights = null) {
    const cols = Math.max(1, ...rows.map(r => r.length));
    const fixed = (rows.length ? rows : [[]]).map(r => Array.from({ length: cols }, (_, i) => String(r[i] ?? '')));
    return { rows: fixed, colWidths: validSizes(colWidths, cols), rowHeights: validSizes(rowHeights, fixed.length) };
  }

  function toModel(content) {
    try {
      const o = JSON.parse(content);
      if (o && o.v === 2 && Array.isArray(o.rows)) return makeModel(o.rows, o.colWidths, o.rowHeights);
    } catch { /* text în formatul vechi */ }
    const rows = parseDelimited(content);
    return makeModel(rows.length ? rows : [['']]);
  }

  const serialize = m => JSON.stringify({ v: 2, rows: m.rows, colWidths: m.colWidths, rowHeights: m.rowHeights });
  const cloneModel = m => makeModel(m.rows.map(r => [...r]), m.colWidths && [...m.colWidths], m.rowHeights && [...m.rowHeights]);

  // ---------- linkuri în celule ----------

  const LINK_RE = /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"]+)/gi;
  const MD_LINK_RE = /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g;

  function safeHref(raw) {
    try {
      const u = new URL(raw);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch { return null; }
  }

  function renderRich(node, text) {
    node.replaceChildren();
    const source = String(text ?? '');
    let last = 0;
    for (const m of source.matchAll(LINK_RE)) {
      let label;
      let raw;
      let tail = '';
      if (m[2]) { label = m[1]; raw = m[2]; } else {
        raw = m[3];
        const punct = raw.match(/[.,;:!?)\]]+$/);
        if (punct) { tail = punct[0]; raw = raw.slice(0, -tail.length); }
        label = raw;
      }
      const href = safeHref(raw);
      if (!href) continue;
      if (m.index > last) node.append(source.slice(last, m.index));
      const a = el('a', '', label);
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow ugc';
      a.title = href;
      node.append(a);
      if (tail) node.append(tail);
      last = m.index + m[0].length;
    }
    if (last < source.length) node.append(source.slice(last));
  }

  // ---------- afișarea tabelului ----------

  function buildTable(model) {
    const wrap = el('div', 'pt-wrap');
    const table = el('table', 'pt-table');
    if (model.colWidths) {
      table.classList.add('pt-fixed');
      table.style.width = `${model.colWidths.reduce((s, w) => s + (w ?? L.defCol), 0)}px`;
      const group = el('colgroup');
      for (const w of model.colWidths) {
        const col = el('col');
        col.style.width = `${w ?? L.defCol}px`;
        group.append(col);
      }
      table.append(group);
    }
    model.rows.forEach((cells, r) => {
      const tr = el('tr');
      const h = model.rowHeights?.[r];
      if (h) tr.style.height = `${h}px`;
      for (const text of cells) {
        const cell = el(r === 0 ? 'th' : 'td');
        if (h) cell.style.height = `${h}px`;
        renderRich(cell, text);
        tr.append(cell);
      }
      table.append(tr);
    });
    wrap.append(table);
    return wrap;
  }

  // ---------- diferențe (pentru aprobarea propunerilor) ----------

  function diffRows(a, b) {
    const A = a.map(r => r.join('\u0001'));
    const B = b.map(r => r.join('\u0001'));
    const n = A.length;
    const m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push({ t: 'same', row: b[j] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: 'del', old: a[i++] });
      else ops.push({ t: 'add', row: b[j++] });
    }
    while (i < n) ops.push({ t: 'del', old: a[i++] });
    while (j < m) ops.push({ t: 'add', row: b[j++] });
    // un bloc de rânduri șterse + adăugate devine „modificat”, rând cu rând
    const out = [];
    let k = 0;
    while (k < ops.length) {
      if (ops[k].t === 'same') { out.push(ops[k++]); continue; }
      const dels = [];
      const adds = [];
      while (k < ops.length && ops[k].t !== 'same') (ops[k].t === 'del' ? dels : adds).push(ops[k++]);
      const pairs = Math.min(dels.length, adds.length);
      for (let p = 0; p < pairs; p++) out.push({ t: 'mod', old: dels[p].old, row: adds[p].row });
      out.push(...dels.slice(pairs), ...adds.slice(pairs));
    }
    return out;
  }

  function buildDiff(oldModel, newModel) {
    const ops = diffRows(oldModel.rows, newModel.rows);
    const cols = Math.max(oldModel.rows[0].length, newModel.rows[0].length);
    const wrap = el('div', 'pt-wrap');
    const table = el('table', 'pt-table pt-diff');
    let added = 0;
    let removed = 0;
    let changed = 0;
    let newIndex = 0;
    for (const op of ops) {
      const isHeader = op.t !== 'del' && newIndex === 0;
      if (op.t !== 'del') newIndex++;
      if (op.t === 'add') added++;
      if (op.t === 'del') removed++;
      const tr = el('tr');
      for (let c = 0; c < cols; c++) {
        const cell = el(isHeader ? 'th' : 'td');
        if (op.t === 'same') renderRich(cell, op.row[c] ?? '');
        else if (op.t === 'add') { cell.classList.add('pt-add'); renderRich(cell, op.row[c] ?? ''); }
        else if (op.t === 'del') { cell.classList.add('pt-del'); cell.textContent = op.old[c] ?? ''; }
        else {
          const before = op.old[c] ?? '';
          const after = op.row[c] ?? '';
          if (before === after) renderRich(cell, after);
          else {
            cell.classList.add('pt-mod');
            changed++;
            if (before) {
              const old = el('div', 'pt-old');
              renderRich(old, before);
              cell.append(old);
            }
            const now = el('div');
            renderRich(now, after);
            cell.append(now);
          }
        }
        tr.append(cell);
      }
      table.append(tr);
    }
    wrap.append(table);
    const parts = [];
    if (changed) parts.push(`${changed} ${changed === 1 ? 'celulă modificată' : 'celule modificate'}`);
    if (added) parts.push(`${added} ${added === 1 ? 'rând adăugat' : 'rânduri adăugate'}`);
    if (removed) parts.push(`${removed} ${removed === 1 ? 'rând șters' : 'rânduri șterse'}`);
    return { node: wrap, summary: parts.length ? parts.join(' · ') : 'Fără modificări de conținut față de varianta actuală.' };
  }

  // ---------- editorul (dialog) ----------

  let editor = null;
  let st = null;
  let busy = false;

  const colLabel = c => {
    let n = c;
    let s = '';
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  };

  function ensureEditor() {
    if (editor) return editor;
    const dialog = el('dialog', 'pt-dialog');
    dialog.id = 'ptEditor';
    dialog.innerHTML = `
      <form class="pt-editor" id="ptForm" novalidate>
        <div class="pt-ed-head"><h3 id="ptHeading"></h3><button type="button" class="pt-x" id="ptX" aria-label="Închide">×</button></div>
        <label class="pt-field" id="ptTitleWrap">Titlul tabelului<input id="ptTitle" maxlength="200" autocomplete="off"></label>
        <p class="pt-static" id="ptTitleStatic"></p>
        <div class="pt-toolbar" id="ptToolbar">
          <button type="button" data-act="addRow">+ Rând</button>
          <button type="button" data-act="addCol">+ Coloană</button>
          <button type="button" data-act="delRow">− Rând</button>
          <button type="button" data-act="delCol">− Coloană</button>
          <span class="pt-sep"></span>
          <button type="button" data-act="link">🔗 Link</button>
          <button type="button" data-act="unlink">Fără link</button>
          <button type="button" data-act="resetSizes" id="ptResetSizes">Dimensiuni automate</button>
        </div>
        <div class="pt-linkbar" id="ptLinkBar" hidden>
          <input id="ptLinkInput" placeholder="Lipește adresa linkului, ex. https://…" autocomplete="off">
          <button type="button" id="ptLinkApply">Aplică</button>
          <button type="button" id="ptLinkCancel">Anulează</button>
          <span class="pt-linkerr" id="ptLinkErr"></span>
        </div>
        <p class="pt-hint" id="ptHint"></p>
        <div class="pt-grid-wrap" id="ptGridWrap"></div>
        <label class="pt-field" id="ptNoteWrap">Ce ai modificat și de ce? (opțional)<textarea id="ptNote" maxlength="300" rows="2"></textarea></label>
        <p class="pt-error" id="ptError" role="alert" hidden></p>
        <div class="pt-foot">
          <span class="pt-hint" id="ptSizeInfo"></span>
          <button type="button" class="pt-btn" id="ptCancel">Anulează</button>
          <button type="submit" class="pt-btn pt-primary" id="ptSave">Salvează</button>
        </div>
      </form>`;
    document.body.append(dialog);
    const q = s => dialog.querySelector(s);
    editor = { dialog, q };

    q('#ptCancel').addEventListener('click', () => tryClose());
    q('#ptX').addEventListener('click', () => tryClose());
    dialog.addEventListener('cancel', event => { event.preventDefault(); tryClose(); });
    q('#ptTitle').addEventListener('input', () => { st.dirty = true; });
    q('#ptNote').addEventListener('input', () => { st.dirty = true; });

    for (const b of dialog.querySelectorAll('#ptToolbar button')) {
      b.addEventListener('mousedown', event => event.preventDefault()); // păstrează selecția din celulă
      b.addEventListener('click', () => toolbarAction(b.dataset.act));
    }
    q('#ptLinkApply').addEventListener('click', applyLink);
    q('#ptLinkCancel').addEventListener('click', () => { q('#ptLinkBar').hidden = true; });
    q('#ptLinkInput').addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); applyLink(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); q('#ptLinkBar').hidden = true; }
    });
    q('#ptForm').addEventListener('submit', submitEditor);
    return editor;
  }

  function setError(message) {
    const box = editor.q('#ptError');
    box.textContent = message || '';
    box.hidden = !message;
  }

  function tryClose() {
    if (busy) return;
    if (st?.dirty && !confirm('Renunți la modificările făcute?')) return;
    if (editor.dialog.open) editor.dialog.close();
  }

  const canResize = () => authenticated && st?.mode === 'edit';
  const colWidth = c => st.model.colWidths?.[c] ?? st.measured?.[c] ?? L.defCol;

  function measure(tableEl, cols) {
    const cells = tableEl ? [...tableEl.querySelectorAll('tr:first-child > *')] : [];
    if (cells.length !== cols) return null;
    return cells.map(cell => {
      const w = Math.round(cell.getBoundingClientRect().width);
      return w > 0 ? clamp(w, L.minCol, L.maxCol) : L.defCol;
    });
  }

  function openEditor({ mode, table, measureFrom }) {
    const { dialog, q } = ensureEditor();
    const model = table ? toModel(table.content) : makeModel(Array.from({ length: 4 }, () => ['', '', '']));
    st = {
      mode, id: table?.id || null, model, base: table ? cloneModel(model) : null,
      active: { r: 0, c: 0 }, dirty: false, measured: null, linkSel: null, editing: null,
    };
    if (!model.colWidths && measureFrom) st.measured = measure(measureFrom, model.rows[0].length);

    const proposing = mode === 'propose';
    q('#ptHeading').textContent = proposing ? 'Propune o modificare' : (table ? 'Editează tabelul' : 'Adaugă tabel');
    q('#ptTitleWrap').hidden = proposing;
    q('#ptTitleStatic').hidden = !proposing;
    q('#ptTitleStatic').textContent = table?.title || '';
    q('#ptTitle').value = table?.title || '';
    q('#ptNoteWrap').hidden = !proposing;
    q('#ptNote').value = '';
    q('#ptResetSizes').hidden = !canResize();
    q('#ptSave').textContent = proposing ? 'Trimite propunerea' : 'Salvează';
    q('#ptHint').textContent = proposing
      ? 'Click pe o celulă ca să scrii. Pentru link: selectează textul, apasă „🔗 Link” și lipește adresa. Propunerea ta nu schimbă nimic până nu o aprobă cineva autentificat.'
      : 'Click pe o celulă ca să scrii. Trage de marginea literelor (A, B, C) pentru lățimea coloanelor și de marginea numerelor pentru înălțimea rândurilor. Pentru link: selectează textul, apasă „🔗 Link” și lipește adresa. Prima linie este antetul.';
    q('#ptLinkBar').hidden = true;
    q('#ptSizeInfo').textContent = '';
    setError('');
    renderGrid();
    if (!dialog.open) dialog.showModal();
    (proposing ? q('#ptGridWrap') : q('#ptTitle')).focus?.();
  }

  // ----- grila -----

  function renderGrid() {
    const m = st.model;
    const cols = m.rows[0].length;
    const wrap = editor.q('#ptGridWrap');
    st.editing = null;
    wrap.replaceChildren();
    const table = el('table', 'pt-grid');
    const group = el('colgroup');
    group.append(el('col', 'pt-gutter'));
    let total = 44;
    for (let c = 0; c < cols; c++) {
      const col = el('col');
      col.style.width = `${colWidth(c)}px`;
      total += colWidth(c);
      group.append(col);
    }
    table.style.width = `${total}px`;
    table.append(group);

    const head = el('tr');
    head.append(el('th', 'pt-corner'));
    for (let c = 0; c < cols; c++) {
      const th = el('th', 'pt-colhead', colLabel(c));
      th.dataset.c = String(c);
      th.addEventListener('click', () => setActive(st.active.r, c));
      if (canResize()) th.append(handle('col', c));
      head.append(th);
    }
    const thead = el('thead');
    thead.append(head);
    table.append(thead);

    const body = el('tbody');
    m.rows.forEach((cells, r) => {
      const tr = el('tr', r === 0 ? 'pt-first' : '');
      const h = m.rowHeights?.[r];
      if (h) tr.style.height = `${h}px`;
      const rowHead = el('th', 'pt-rowhead', String(r + 1));
      rowHead.dataset.r = String(r);
      rowHead.addEventListener('click', () => setActive(r, st.active.c));
      if (canResize()) rowHead.append(handle('row', r));
      tr.append(rowHead);
      cells.forEach((text, c) => tr.append(buildCell(r, c, text)));
      body.append(tr);
    });
    table.append(body);
    wrap.append(table);
    markActive();
  }

  function handle(kind, index) {
    const h = el('div', `pt-handle ${kind}`);
    h.title = kind === 'col' ? 'Trage ca să schimbi lățimea' : 'Trage ca să schimbi înălțimea';
    h.addEventListener('pointerdown', event => startResize(kind, index, event, h));
    return h;
  }

  function buildCell(r, c, text) {
    const td = el('td', 'pt-cell');
    td.dataset.r = String(r);
    td.dataset.c = String(c);
    const view = el('div', 'pt-view');
    view.tabIndex = 0;
    renderRich(view, text);
    const ta = el('textarea', 'pt-edit');
    ta.hidden = true;
    ta.rows = 1;
    ta.value = text;
    ta.maxLength = L.cell;
    ta.spellcheck = false;
    td.append(view, ta);

    view.addEventListener('click', event => { if (event.target.closest('a')) event.preventDefault(); });
    view.addEventListener('focus', () => beginEdit(r, c, view, ta));
    ta.addEventListener('input', () => {
      st.model.rows[r][c] = ta.value;
      st.dirty = true;
      autosize(ta);
    });
    ta.addEventListener('blur', () => { if (ta.isConnected) finishEdit(view, ta); });
    ta.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); focusCell(r + 1, c) || ta.blur(); }
      else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        ta.value = ta.dataset.orig ?? ta.value;
        st.model.rows[r][c] = ta.value;
        ta.blur();
      }
    });
    ta.addEventListener('paste', event => pasteCells(event, r, c));
    return td;
  }

  const autosize = ta => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };

  function beginEdit(r, c, view, ta) {
    if (st.editing && st.editing.ta !== ta) finishEdit(st.editing.view, st.editing.ta);
    st.editing = { view, ta, r, c };
    setActive(r, c);
    ta.dataset.orig = st.model.rows[r][c];
    ta.value = st.model.rows[r][c];
    view.hidden = true;
    ta.hidden = false;
    autosize(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function finishEdit(view, ta) {
    if (st.editing && st.editing.ta === ta) st.editing = null;
    renderRich(view, ta.value);
    ta.hidden = true;
    view.hidden = false;
  }

  function focusCell(r, c) {
    const view = editor.q(`td[data-r="${r}"][data-c="${c}"] .pt-view`);
    if (!view) return false;
    view.focus();
    return true;
  }

  function setActive(r, c) {
    st.active = { r, c };
    markActive();
  }

  function markActive() {
    const grid = editor.q('#ptGridWrap');
    grid.querySelectorAll('.pt-active').forEach(n => n.classList.remove('pt-active'));
    grid.querySelectorAll('.pt-sel').forEach(n => n.classList.remove('pt-sel'));
    grid.querySelector(`td[data-r="${st.active.r}"][data-c="${st.active.c}"]`)?.classList.add('pt-active');
    grid.querySelector(`.pt-colhead[data-c="${st.active.c}"]`)?.classList.add('pt-sel');
    grid.querySelector(`.pt-rowhead[data-r="${st.active.r}"]`)?.classList.add('pt-sel');
  }

  function pasteCells(event, r, c) {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text.includes('\t')) return; // text obișnuit: comportament normal
    event.preventDefault();
    const m = st.model;
    const block = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map(line => line.split('\t'));
    const needRows = Math.min(L.maxRows, r + block.length);
    const needCols = Math.min(L.maxCols, c + Math.max(...block.map(line => line.length)));
    while (m.rows.length < needRows) { m.rows.push(blankRow(m.rows[0].length)); m.rowHeights?.push(null); }
    while (m.rows[0].length < needCols) {
      m.rows.forEach(row => row.push(''));
      m.colWidths?.push(L.defCol);
      st.measured?.push(L.defCol);
    }
    block.forEach((line, i) => line.forEach((value, j) => {
      if (r + i < m.rows.length && c + j < m.rows[0].length) {
        m.rows[r + i][c + j] = value.replace(/^"([\s\S]*)"$/, '$1').replace(/""/g, '"').slice(0, L.cell);
      }
    }));
    st.dirty = true;
    renderGrid();
  }

  // ----- redimensionare -----

  function startResize(kind, index, event, handleEl) {
    event.preventDefault();
    event.stopPropagation();
    const m = st.model;
    const table = editor.q('.pt-grid');
    if (kind === 'col') {
      if (!m.colWidths) m.colWidths = Array.from({ length: m.rows[0].length }, (_, c) => colWidth(c));
    } else if (!m.rowHeights) m.rowHeights = Array(m.rows.length).fill(null);
    const tr = table.tBodies[0].rows[index];
    const startPos = kind === 'col' ? event.clientX : event.clientY;
    const startSize = kind === 'col' ? m.colWidths[index] : (m.rowHeights[index] ?? (Math.round(tr.getBoundingClientRect().height) || 36));
    const info = editor.q('#ptSizeInfo');
    handleEl.classList.add('active');

    const move = ev => {
      const delta = (kind === 'col' ? ev.clientX : ev.clientY) - startPos;
      if (kind === 'col') {
        const w = clamp(Math.round(startSize + delta), L.minCol, L.maxCol);
        m.colWidths[index] = w;
        table.querySelectorAll('col')[index + 1].style.width = `${w}px`;
        table.style.width = `${44 + m.colWidths.reduce((s, x, i) => s + (x ?? colWidth(i)), 0)}px`;
        info.textContent = `Coloana ${colLabel(index)}: ${w} px`;
      } else {
        const h = clamp(Math.round(startSize + delta), L.minRow, L.maxRow);
        m.rowHeights[index] = h;
        tr.style.height = `${h}px`;
        info.textContent = `Rândul ${index + 1}: ${h} px`;
      }
      st.dirty = true;
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      handleEl.classList.remove('active');
      setTimeout(() => { info.textContent = ''; }, 1800);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  // ----- bara de unelte -----

  function commitEditing() {
    if (st.editing) finishEdit(st.editing.view, st.editing.ta);
  }

  function toolbarAction(act) {
    const m = st.model;
    const { r, c } = st.active;
    const cols = m.rows[0].length;
    setError('');
    if (act === 'link') return openLinkBar();
    if (act === 'unlink') {
      m.rows[r][c] = m.rows[r][c].replace(MD_LINK_RE, '$1');
      st.dirty = true;
      return renderGrid();
    }
    commitEditing();
    if (act === 'addRow') {
      if (m.rows.length >= L.maxRows) return setError(`Maximum ${L.maxRows} de rânduri.`);
      m.rows.splice(r + 1, 0, blankRow(cols));
      m.rowHeights?.splice(r + 1, 0, null);
      st.active = { r: r + 1, c };
    } else if (act === 'addCol') {
      if (cols >= L.maxCols) return setError(`Maximum ${L.maxCols} de coloane.`);
      m.rows.forEach(row => row.splice(c + 1, 0, ''));
      m.colWidths?.splice(c + 1, 0, L.defCol);
      st.measured?.splice(c + 1, 0, L.defCol);
      st.active = { r, c: c + 1 };
    } else if (act === 'delRow') {
      if (m.rows.length <= 1) return setError('Tabelul trebuie să aibă cel puțin un rând.');
      if (m.rows[r].some(v => v.trim()) && !confirm(`Ștergi rândul ${r + 1}?`)) return;
      m.rows.splice(r, 1);
      m.rowHeights?.splice(r, 1);
      st.active = { r: Math.min(r, m.rows.length - 1), c };
    } else if (act === 'delCol') {
      if (cols <= 1) return setError('Tabelul trebuie să aibă cel puțin o coloană.');
      if (m.rows.some(row => row[c].trim()) && !confirm(`Ștergi coloana ${colLabel(c)}?`)) return;
      m.rows.forEach(row => row.splice(c, 1));
      m.colWidths?.splice(c, 1);
      st.measured?.splice(c, 1);
      st.active = { r, c: Math.min(c, cols - 2) };
    } else if (act === 'resetSizes') {
      m.colWidths = null;
      m.rowHeights = null;
      st.measured = null;
    }
    st.dirty = true;
    renderGrid();
  }

  function openLinkBar() {
    const { r, c } = st.active;
    const ta = st.editing?.ta;
    st.linkSel = ta
      ? { r, c, start: ta.selectionStart, end: ta.selectionEnd }
      : { r, c, start: 0, end: 0 };
    editor.q('#ptLinkErr').textContent = '';
    editor.q('#ptLinkInput').value = '';
    editor.q('#ptLinkBar').hidden = false;
    editor.q('#ptLinkInput').focus();
  }

  function applyLink() {
    let url = editor.q('#ptLinkInput').value.trim();
    if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    const href = safeHref(url);
    if (!href) { editor.q('#ptLinkErr').textContent = 'Adresa nu este validă.'; return; }
    const safe = href.replace(/\(/g, '%28').replace(/\)/g, '%29');
    const { r, c, start, end } = st.linkSel;
    const text = st.model.rows[r][c];
    let out;
    if (end > start) out = `${text.slice(0, start)}[${text.slice(start, end).replace(/[[\]]/g, '')}](${safe})${text.slice(end)}`;
    else if (text.trim()) out = `[${text.replace(MD_LINK_RE, '$1').replace(/[[\]]/g, '')}](${safe})`;
    else out = `[${new URL(href).hostname}](${safe})`;
    st.model.rows[r][c] = out.slice(0, L.cell);
    st.dirty = true;
    editor.q('#ptLinkBar').hidden = true;
    renderGrid();
  }

  // ----- salvare / trimitere -----

  async function submitEditor(event) {
    event.preventDefault();
    if (busy) return;
    commitEditing();
    const { q } = editor;
    const proposing = st.mode === 'propose';
    const title = q('#ptTitle').value.trim();
    if (!proposing && !title) return setError('Scrie un titlu pentru tabel.');
    if (proposing && serialize(st.model) === serialize(st.base)) return setError('Nu ai făcut nicio modificare.');
    busy = true;
    const save = q('#ptSave');
    const label = save.textContent;
    save.disabled = true;
    save.textContent = 'Se trimite…';
    setError('');
    try {
      if (proposing) {
        await window.drive.proposeTable(st.id, { content: serialize(st.model), note: q('#ptNote').value });
        flash = 'Mulțumim! Propunerea ta a fost trimisă și apare pe site după ce o aprobă cineva autentificat.';
      } else {
        await window.drive.saveTable(st.id, { title, content: serialize(st.model) });
      }
      st.dirty = false;
      editor.dialog.close();
      await show(authenticated, currentQuery);
    } catch (error) {
      setError(error.message || 'Nu s-a putut salva. Încearcă din nou.');
    } finally {
      busy = false;
      save.disabled = false;
      save.textContent = label;
    }
  }

  // ---------- aprobarea propunerilor ----------

  let reviewer = null;

  function ensureReviewer() {
    if (reviewer) return reviewer;
    const dialog = el('dialog', 'pt-dialog');
    dialog.id = 'ptReview';
    dialog.innerHTML = `
      <div class="pt-editor">
        <div class="pt-ed-head"><h3 id="ptRevHeading"></h3><button type="button" class="pt-x" id="ptRevX" aria-label="Închide">×</button></div>
        <p class="pt-hint">Galben = celulă modificată (varianta veche e tăiată) · verde = rând adăugat · roșu = rând șters. Dacă nu aprobi, tabelul rămâne neschimbat.</p>
        <div class="pt-rev-body" id="ptRevBody"></div>
      </div>`;
    document.body.append(dialog);
    dialog.querySelector('#ptRevX').addEventListener('click', () => dialog.close());
    reviewer = dialog;
    return dialog;
  }

  function openReview(table, proposals) {
    const dialog = ensureReviewer();
    dialog.querySelector('#ptRevHeading').textContent = `Propuneri pentru „${table.title}”`;
    const body = dialog.querySelector('#ptRevBody');
    body.replaceChildren();
    const current = toModel(table.content);
    for (const p of proposals) {
      const article = el('article', 'pt-prop');
      const when = new Date(p.createdAt).toLocaleString('ro-RO', { dateStyle: 'medium', timeStyle: 'short' });
      article.append(el('p', 'pt-prop-meta', `Propunere din ${when}`));
      if (p.note) article.append(el('p', 'pt-prop-note', `„${p.note}”`));
      if (p.baseUpdatedAt < Date.parse(table.updatedAt)) {
        article.append(el('p', 'pt-warn', 'Tabelul a fost modificat după ce a fost trimisă această propunere. Aprobarea înlocuiește conținutul actual cu cel de mai jos.'));
      }
      const diff = buildDiff(current, toModel(p.content));
      article.append(el('p', 'pt-prop-sum', diff.summary), diff.node);
      const msg = el('p', 'pt-error');
      msg.hidden = true;
      const actions = el('div', 'pt-prop-actions');
      const decide = decision => async () => {
        for (const b of actions.querySelectorAll('button')) b.disabled = true;
        try {
          await window.drive.reviewTableProposal(p.id, decision);
          dialog.close();
          await show(authenticated, currentQuery);
        } catch (error) {
          msg.textContent = error.message || 'Acțiunea nu a reușit.';
          msg.hidden = false;
          for (const b of actions.querySelectorAll('button')) b.disabled = false;
        }
      };
      actions.append(button('Aprobă', 'pt-btn pt-primary', decide('approved')), button('Respinge', 'pt-btn', decide('rejected')));
      article.append(msg, actions);
      body.append(article);
    }
    if (!dialog.open) dialog.showModal();
  }

  // ---------- panoul principal ----------

  async function show(isAuthenticated, query = '') {
    authenticated = !!isAuthenticated;
    currentQuery = query || '';
    const token = ++renderSeq;
    const panel = document.getElementById('tablesPanel');
    if (!panel) return;
    panel.replaceChildren();
    panel.className = 'p-4 lg:p-6 space-y-4';

    const header = el('div', 'flex items-center justify-between gap-3');
    header.append(el('h2', 'font-bold text-lg text-slate-900', 'Tabele publice'));
    const headerActions = el('div', 'flex items-center gap-2');
    header.append(headerActions);
    panel.append(header);

    const status = el('p', 'text-sm text-slate-500', 'Se încarcă tabelele…');
    panel.append(status);

    let tables;
    let proposals = [];
    try {
      tables = await window.drive.tables();
      if (authenticated) {
        try { proposals = await window.drive.tableProposals(); } catch { proposals = []; }
      }
    } catch (error) {
      if (token === renderSeq) status.textContent = error.message || 'Tabelele nu pot fi încărcate momentan.';
      return;
    }
    if (token !== renderSeq) return;

    if (authenticated) {
      headerActions.append(button('Adaugă tabel', 'px-4 py-2 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white', () => openEditor({ mode: 'edit', table: null })));
    }
    if (flash) {
      const note = el('p', 'pt-flash', flash);
      note.setAttribute('role', 'status');
      status.before(note);
      flash = '';
    }

    const needle = String(query || '').trim().toLowerCase();
    const shown = tables.filter(t => t.title.toLowerCase().includes(needle));
    const count = document.getElementById('itemCount');
    if (count) count.textContent = `${shown.length} tabele`;
    status.textContent = shown.length ? '' : (tables.length ? 'Niciun tabel nu corespunde căutării.' : 'Nu există încă tabele publice.');
    status.classList.toggle('hidden', shown.length > 0);

    for (const table of shown) {
      const card = el('section', 'border border-slate-200 rounded-2xl p-4 space-y-3');
      const top = el('div', 'flex flex-wrap items-center justify-between gap-2');
      top.append(el('h3', 'font-semibold text-slate-800', table.title));
      const actions = el('div', 'flex items-center gap-2');
      const display = buildTable(toModel(table.content));
      if (authenticated) {
        const mine = proposals.filter(p => p.tableId === table.id);
        if (mine.length) {
          actions.append(button(`${mine.length} ${mine.length === 1 ? 'propunere' : 'propuneri'}`, 'pt-badge', () => openReview(table, mine)));
        }
        const style = 'px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-600';
        actions.append(
          button('Editează', style, () => openEditor({ mode: 'edit', table, measureFrom: display.querySelector('table') })),
          button('Șterge', style, () => removeTable(table)),
        );
      } else {
        actions.append(button('propune modificare', 'pt-propose', () => openEditor({ mode: 'propose', table, measureFrom: display.querySelector('table') })));
      }
      top.append(actions);
      card.append(top, display);
      panel.append(card);
    }
  }

  async function removeTable(table) {
    if (!authenticated || !confirm(`Ștergi tabelul „${table.title}” (și propunerile lui)?`)) return;
    try {
      await window.drive.removeTable(table.id);
      await show(authenticated, currentQuery);
    } catch (error) {
      alert(error.message || 'Tabelul nu a putut fi șters.');
    }
  }

  window.tables = {
    setAuthenticated(flag) { authenticated = !!flag; },
    show,
  };
})();
