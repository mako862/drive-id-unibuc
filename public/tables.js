// window.tables: secțiunea „Tabele publice”. Oricine vede tabelele; utilizatorii autentificați le pot edita.
// Se editează ca text: lipește direct celule copiate din Excel / Google Sheets (separate prin tab),
// sau scrie CSV (virgulă / punct și virgulă). Prima linie = antetul tabelului.
(() => {
  'use strict';
  let authenticated = false;
  let editor = null;
  let editingId = null;
  let busy = false;

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

  function buildTable(content) {
    const rows = parseDelimited(content);
    const wrap = document.createElement('div');
    wrap.className = 'pt-wrap';
    if (!rows.length) {
      wrap.textContent = 'Tabel gol.';
      return wrap;
    }
    const table = document.createElement('table');
    table.className = 'pt-table';
    const columns = Math.max(...rows.map(r => r.length));
    rows.forEach((cells, index) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < columns; c++) {
        const cellEl = document.createElement(index === 0 ? 'th' : 'td');
        cellEl.textContent = cells[c] ?? '';
        tr.append(cellEl);
      }
      table.append(tr);
    });
    wrap.append(table);
    return wrap;
  }

  function button(label, classes, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = classes;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function ensureEditor() {
    if (editor) return editor;
    const dialog = document.createElement('dialog');
    dialog.className = 'rounded-2xl p-0 w-[min(680px,94vw)] shadow-2xl';
    dialog.innerHTML = `
      <form method="dialog" class="p-5 space-y-3" id="ptForm">
        <h3 class="font-bold text-lg text-slate-900" id="ptHeading"></h3>
        <label class="block text-xs font-semibold text-slate-700">Titlu
          <input id="ptTitle" maxlength="200" class="mt-1 w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-xl text-sm font-normal">
        </label>
        <label class="block text-xs font-semibold text-slate-700">Conținut (prima linie = antet)
          <textarea id="ptContent" rows="12" spellcheck="false" class="mt-1 w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-xl text-sm font-mono font-normal" placeholder="Lipește aici celulele copiate din Excel / Google Sheets"></textarea>
        </label>
        <p id="ptError" class="hidden text-sm text-red-700" role="alert"></p>
        <div class="flex justify-end gap-2">
          <button type="button" id="ptCancel" class="px-4 py-2 rounded-xl text-sm font-semibold bg-slate-100 hover:bg-slate-200">Anulează</button>
          <button type="submit" id="ptSave" class="px-4 py-2 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white">Salvează</button>
        </div>
      </form>`;
    document.body.append(dialog);
    const q = id => dialog.querySelector(id);
    q('#ptCancel').addEventListener('click', () => { if (!busy) dialog.close(); });
    q('#ptForm').addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      const save = q('#ptSave');
      const error = q('#ptError');
      save.disabled = true;
      save.textContent = 'Se salvează…';
      error.classList.add('hidden');
      try {
        await window.drive.saveTable(editingId, { title: q('#ptTitle').value, content: q('#ptContent').value });
        dialog.close();
        await show(authenticated, document.getElementById('searchInput')?.value || '');
      } catch (err) {
        error.textContent = err.message || 'Tabelul nu a putut fi salvat.';
        error.classList.remove('hidden');
      } finally {
        busy = false;
        save.disabled = false;
        save.textContent = 'Salvează';
      }
    });
    editor = dialog;
    return dialog;
  }

  function openEditor(table) {
    if (!authenticated) return;
    const dialog = ensureEditor();
    editingId = table?.id || null;
    dialog.querySelector('#ptHeading').textContent = table ? 'Editează tabelul' : 'Adaugă tabel';
    dialog.querySelector('#ptTitle').value = table?.title || '';
    dialog.querySelector('#ptContent').value = table?.content || '';
    dialog.querySelector('#ptError').classList.add('hidden');
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('#ptTitle').focus();
  }

  async function removeTable(table) {
    if (!authenticated || !confirm(`Ștergi tabelul „${table.title}”?`)) return;
    try {
      await window.drive.removeTable(table.id);
      await show(authenticated, document.getElementById('searchInput')?.value || '');
    } catch (error) {
      alert(error.message || 'Tabelul nu a putut fi șters.');
    }
  }

  async function show(isAuthenticated, query = '') {
    authenticated = !!isAuthenticated;
    const panel = document.getElementById('tablesPanel');
    if (!panel) return;
    panel.replaceChildren();
    panel.className = 'p-4 lg:p-6 space-y-4';

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between gap-3';
    const title = document.createElement('h2');
    title.className = 'font-bold text-lg text-slate-900';
    title.textContent = 'Tabele publice';
    header.append(title);
    if (authenticated) header.append(button('Adaugă tabel', 'px-4 py-2 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white', () => openEditor(null)));
    panel.append(header);

    const status = document.createElement('p');
    status.className = 'text-sm text-slate-500';
    status.textContent = 'Se încarcă tabelele…';
    panel.append(status);

    let tables;
    try {
      tables = await window.drive.tables();
    } catch (error) {
      status.textContent = error.message || 'Tabelele nu pot fi încărcate momentan.';
      return;
    }
    const needle = String(query || '').trim().toLowerCase();
    const shown = tables.filter(t => t.title.toLowerCase().includes(needle));
    const count = document.getElementById('itemCount');
    if (count) count.textContent = `${shown.length} tabele`;
    status.textContent = shown.length ? '' : (tables.length ? 'Niciun tabel nu corespunde căutării.' : 'Nu există încă tabele publice.');
    status.classList.toggle('hidden', shown.length > 0);

    for (const table of shown) {
      const card = document.createElement('section');
      card.className = 'border border-slate-200 rounded-2xl p-4 space-y-3';
      const top = document.createElement('div');
      top.className = 'flex flex-wrap items-center justify-between gap-2';
      const name = document.createElement('h3');
      name.className = 'font-semibold text-slate-800';
      name.textContent = table.title;
      top.append(name);
      if (authenticated) {
        const actions = document.createElement('div');
        actions.className = 'flex gap-2';
        const style = 'px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-600';
        actions.append(button('Editează', style, () => openEditor(table)), button('Șterge', style, () => removeTable(table)));
        top.append(actions);
      }
      card.append(top, buildTable(table.content));
      panel.append(card);
    }
  }

  window.tables = {
    setAuthenticated(flag) { authenticated = !!flag; },
    show,
  };
})();
