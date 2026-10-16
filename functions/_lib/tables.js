// Formatul tabelelor publice.
//   v2 (nou): JSON {"v":2,"rows":[["a","b"],["c","d"]],"colWidths":[200,null]|null,"rowHeights":[null,60]|null}
//   vechi   : text simplu (TSV/CSV). Rămâne valid și se convertește în editor la prima modificare.
// Celulele pot conține linkuri în forma [text](https://adresa) sau adrese simple https://...
import { HttpError } from './util.js';

export const TABLE_LIMITS = {
  rows: 500, cols: 40, cell: 2000, content: 400000, legacy: 200000,
  minCol: 60, maxCol: 800, minRow: 26, maxRow: 400,
};

function cleanCell(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .slice(0, TABLE_LIMITS.cell);
}

function sizeList(list, length, min, max) {
  if (!Array.isArray(list) || list.length !== length) return null;
  const sizes = list.map(v => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : null;
  });
  return sizes.some(v => v !== null) ? sizes : null;
}

// Returnează modelul v2 normalizat sau null dacă textul nu este în format v2.
export function parseTableContent(input) {
  const text = String(input ?? '');
  if (text.length > TABLE_LIMITS.content) throw new HttpError(400, 'Tabelul este prea mare.');
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== 'object' || obj.v !== 2) return null;
  if (!Array.isArray(obj.rows) || obj.rows.length < 1) throw new HttpError(400, 'Tabelul trebuie să aibă cel puțin un rând.');
  if (obj.rows.length > TABLE_LIMITS.rows) throw new HttpError(400, `Tabelul poate avea cel mult ${TABLE_LIMITS.rows} de rânduri.`);
  const cols = Math.max(0, ...obj.rows.map(r => (Array.isArray(r) ? r.length : 0)));
  if (cols < 1) throw new HttpError(400, 'Tabelul trebuie să aibă cel puțin o coloană.');
  if (cols > TABLE_LIMITS.cols) throw new HttpError(400, `Tabelul poate avea cel mult ${TABLE_LIMITS.cols} de coloane.`);
  const rows = obj.rows.map(r => Array.from({ length: cols }, (_, i) => cleanCell(Array.isArray(r) ? r[i] : '')));
  return {
    v: 2,
    rows,
    colWidths: sizeList(obj.colWidths, cols, TABLE_LIMITS.minCol, TABLE_LIMITS.maxCol),
    rowHeights: sizeList(obj.rowHeights, rows.length, TABLE_LIMITS.minRow, TABLE_LIMITS.maxRow),
  };
}

// Pentru salvare directă (utilizatori autentificați). Acceptă și textul vechi.
export function normalizeTableContent(input) {
  const model = parseTableContent(input);
  if (model) return JSON.stringify(model);
  const text = String(input ?? '');
  if (text.length > TABLE_LIMITS.legacy) throw new HttpError(400, 'Tabelul este prea mare.');
  return text;
}

// Vizitatorii nu pot schimba dimensiunile: dacă structura (numărul de rânduri / coloane)
// nu se schimbă, păstrăm dimensiunile tabelului actual, oricâte ar trimite ei.
export function lockSizes(currentContent, proposed) {
  const current = parseTableContent(currentContent);
  if (!current) return { ...proposed, colWidths: null, rowHeights: null };
  return {
    ...proposed,
    colWidths: proposed.rows[0].length === current.rows[0].length ? current.colWidths : proposed.colWidths,
    rowHeights: proposed.rows.length === current.rows.length ? current.rowHeights : proposed.rowHeights,
  };
}

export function sameRows(a, b) {
  return JSON.stringify(a.rows) === JSON.stringify(b.rows);
}
