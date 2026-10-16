// POST /api/drive  —  toate acțiunile JSON ale aplicației.
// Fișierele propriu-zise stau în R2 (binding FILES); în Neon (Postgres) stau doar metadatele.
import { getDb, ensureSchema, getBucket } from '../_lib/db.js';
import {
  getSession, getSecret, signToken, verifyToken, passwordsMatch,
  sessionCookie, clearCookie, SESSION_SECONDS,
} from '../_lib/auth.js';
import {
  HttpError, json, handle, checkOrigin, requireId, cleanName, cleanType,
  toNumber, sleep, PART_SIZE, MAX_FILE_SIZE, GB, fileKey,
} from '../_lib/util.js';
import { parseTableContent, normalizeTableContent, lockSizes, sameRows } from '../_lib/tables.js';

const NO_DB = new Set(['session', 'signin', 'signout']);
const UPLOAD_TOKEN_SECONDS = 6 * 24 * 3600; // R2 abandonează singur încărcările neterminate după 7 zile

// ---------- ajutoare ----------

const ITEM_COLS = `id, name, parent_id, is_folder, size::float8 AS size, type, status,
  created_at::float8 AS created_at, updated_at::float8 AS updated_at`;

const toItem = r => ({
  id: r.id,
  name: r.name,
  parentId: r.parent_id,
  isFolder: !!r.is_folder,
  size: Number(r.size),
  type: r.type || '',
  status: r.status,
  createdAt: Number(r.created_at),
  updatedAt: new Date(Number(r.updated_at)).toISOString(),
});

function requireAuth(session) {
  if (!session.isAuthenticated) throw new HttpError(401, 'Trebuie să fii autentificat.');
}

function requireAdmin(session) {
  if (!session.isAdmin) throw new HttpError(401, 'Această acțiune necesită autentificare ca administrator.');
}

const normalizeParent = value => (!value || value === 'root' ? 'root' : requireId(value, 'folder'));

async function requireParentFolder(db, parentId) {
  if (parentId === 'root') return;
  const [parent] = await db('SELECT is_folder FROM cd_items WHERE id = $1', [parentId]);
  if (!parent || !parent.is_folder) throw new HttpError(400, 'Folderul de destinație nu mai există. Alege altă destinație.');
}

// Un folder nu poate fi mutat în el însuși sau într-un subfolder al său.
async function assertNotInsideSelf(db, movingId, targetParentId) {
  if (targetParentId === 'root') return;
  const rows = await db(
    `WITH RECURSIVE tree AS (
       SELECT id FROM cd_items WHERE id = $1
       UNION
       SELECT c.id FROM cd_items c JOIN tree t ON c.parent_id = t.id
     ) SELECT 1 AS hit FROM tree WHERE id = $2`,
    [movingId, targetParentId]
  );
  if (rows.length) throw new HttpError(400, 'Un folder nu poate fi mutat în el însuși sau într-un subfolder al său.');
}

// Protecție împotriva umplerii stocării cu fișiere neaprobate.
async function assertPendingQuota(db, env, extraBytes = 0) {
  const maxItems = toNumber(env.MAX_PENDING_ITEMS, 1000);
  const maxBytes = toNumber(env.MAX_PENDING_BYTES, 2 * GB);
  const [r] = await db(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(size), 0)::float8 AS bytes FROM cd_items WHERE status = 'pending'`
  );
  if (Number(r.n) >= maxItems || Number(r.bytes) + extraBytes > maxBytes) {
    throw new HttpError(429, 'Sunt prea multe fișiere în așteptare. Încearcă din nou după ce administratorul le aprobă.');
  }
}

const newId = prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

// ---------- sesiune ----------

async function actionSession({ session }) {
  return { isAuthenticated: session.isAuthenticated, isAdmin: session.isAdmin };
}

async function actionSignIn({ env }, body) {
  const secret = getSecret(env);
  const password = String(body.password ?? '');
  const email = String(body.email ?? '').trim().toLowerCase();
  const adminEmailOk = !env.ADMIN_EMAIL || email === String(env.ADMIN_EMAIL).trim().toLowerCase();
  const isAdmin = (await passwordsMatch(password, env.ADMIN_PASSWORD, secret)) && adminEmailOk;
  const isMember = !isAdmin && (await passwordsMatch(password, env.MEMBER_PASSWORD, secret));
  if (!isAdmin && !isMember) {
    await sleep(600); // încetinește ghicirea parolei
    throw new HttpError(401, 'Email sau parolă incorectă.');
  }
  const token = await signToken(
    { t: 'session', r: isAdmin ? 'admin' : 'member', exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS },
    secret
  );
  return json({ isAuthenticated: true, isAdmin }, 200, { 'Set-Cookie': sessionCookie(token) });
}

async function actionSignOut() {
  return json({ isAuthenticated: false, isAdmin: false }, 200, { 'Set-Cookie': clearCookie() });
}

// ---------- fișiere și foldere ----------

async function actionItems({ db, session }) {
  const where = session.isAdmin ? '' : `WHERE status = 'approved'`;
  const rows = await db(`SELECT ${ITEM_COLS} FROM cd_items ${where}`);
  return rows.map(toItem);
}

async function actionSave({ db, env, session }, body) {
  const item = body.item || {};
  const id = requireId(item.id, 'element');
  const [existing] = await db(`SELECT ${ITEM_COLS} FROM cd_items WHERE id = $1`, [id]);
  const now = Date.now();

  if (!session.isAdmin) {
    // Vizitatorii pot doar propune foldere noi (în așteptare). Fișierele merg prin uploadInit.
    if (existing) throw new HttpError(401, 'Doar administratorul poate modifica elemente existente.');
    if (!item.isFolder) throw new HttpError(400, 'Fișierele se încarcă prin fluxul de încărcare.');
    const parentId = normalizeParent(item.parentId);
    await requireParentFolder(db, parentId);
    await assertPendingQuota(db, env);
    await db(
      `INSERT INTO cd_items (id, name, parent_id, is_folder, size, type, status, created_at, updated_at)
       VALUES ($1, $2, $3, TRUE, 0, '', 'pending', $4, $4)`,
      [id, cleanName(item.name), parentId, now]
    );
    return { success: true };
  }

  if (existing) {
    const name = item.name === undefined ? existing.name : cleanName(item.name);
    const parentId = item.parentId === undefined ? existing.parent_id : normalizeParent(item.parentId);
    const status = item.status === 'pending' || item.status === 'approved' ? item.status : existing.status;
    if (parentId !== existing.parent_id) {
      await requireParentFolder(db, parentId);
      if (existing.is_folder) await assertNotInsideSelf(db, id, parentId);
    }
    await db(
      'UPDATE cd_items SET name = $2, parent_id = $3, status = $4, updated_at = $5 WHERE id = $1',
      [id, name, parentId, status, now]
    );
    return { success: true };
  }

  if (!item.isFolder) throw new HttpError(400, 'Fișierele se încarcă prin fluxul de încărcare.');
  const parentId = normalizeParent(item.parentId);
  await requireParentFolder(db, parentId);
  await db(
    `INSERT INTO cd_items (id, name, parent_id, is_folder, size, type, status, created_at, updated_at)
     VALUES ($1, $2, $3, TRUE, 0, '', $4, $5, $5)`,
    [id, cleanName(item.name), parentId, item.status === 'pending' ? 'pending' : 'approved', now]
  );
  return { success: true };
}

// Șterge elementul, toți descendenții lui și fișierele lor din R2.
async function actionRemove({ db, env, session }, body) {
  requireAdmin(session);
  const id = requireId(body.id, 'element');
  const tree = await db(
    `WITH RECURSIVE tree AS (
       SELECT id, is_folder FROM cd_items WHERE id = $1
       UNION
       SELECT c.id, c.is_folder FROM cd_items c JOIN tree t ON c.parent_id = t.id
     ) SELECT id, is_folder FROM tree`,
    [id]
  );
  if (!tree.length) return { success: true };
  const keys = tree.filter(r => !r.is_folder).map(r => fileKey(r.id));
  if (keys.length) {
    const bucket = getBucket(env);
    for (let i = 0; i < keys.length; i += 500) await bucket.delete(keys.slice(i, i + 500));
  }
  await db(
    `WITH RECURSIVE tree AS (
       SELECT id FROM cd_items WHERE id = $1
       UNION
       SELECT c.id FROM cd_items c JOIN tree t ON c.parent_id = t.id
     ) DELETE FROM cd_items WHERE id IN (SELECT id FROM tree)`,
    [id]
  );
  return { success: true, removed: tree.length };
}

// ---------- încărcare în fragmente (R2 multipart) ----------

async function insertFileRow(db, p) {
  const rows = await db(
    `INSERT INTO cd_items (id, name, parent_id, is_folder, size, type, status, created_at, updated_at)
     VALUES ($1, $2, $3, FALSE, $4, $5, $6, $7, $7)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [p.id, p.name, p.parentId, p.size, p.type, p.status, p.createdAt]
  );
  return rows.length > 0;
}

async function actionUploadInit({ db, env, session }, body) {
  const bucket = getBucket(env);
  const secret = getSecret(env);
  const item = body.item || {};
  const id = requireId(item.id, 'fișier');
  const name = cleanName(item.name);
  const size = Math.floor(toNumber(item.size, -1));
  if (size < 0) throw new HttpError(400, 'Dimensiunea fișierului este invalidă.');
  if (size > MAX_FILE_SIZE) throw new HttpError(400, 'Limita este de 5 GB per fișier.');
  const parentId = normalizeParent(item.parentId);
  const type = cleanType(item.type);
  await requireParentFolder(db, parentId);
  const [taken] = await db('SELECT 1 AS x FROM cd_items WHERE id = $1', [id]);
  if (taken) throw new HttpError(409, 'Un element cu acest id există deja.');
  if (!session.isAdmin) await assertPendingQuota(db, env, size);
  const status = session.isAdmin && item.status === 'approved' ? 'approved' : 'pending';
  const createdAt = Date.now();
  const contentType = type || 'application/octet-stream';

  if (size === 0) {
    await bucket.put(fileKey(id), new Uint8Array(0), { httpMetadata: { contentType } });
    await insertFileRow(db, { id, name, parentId, size: 0, type, status, createdAt });
    return { done: true };
  }

  const upload = await bucket.createMultipartUpload(fileKey(id), { httpMetadata: { contentType } });
  const token = await signToken(
    {
      t: 'up', id, uid: upload.uploadId, size, name, parentId, type, status, createdAt,
      exp: Math.floor(Date.now() / 1000) + UPLOAD_TOKEN_SECONDS,
    },
    secret
  );
  return { token, partSize: PART_SIZE, parts: Math.ceil(size / PART_SIZE) };
}

async function readUploadToken(env, token) {
  const payload = await verifyToken(token, getSecret(env), 'up');
  if (!payload) throw new HttpError(410, 'Sesiunea de încărcare a expirat. Pornește încărcarea din nou.');
  return payload;
}

async function actionUploadComplete({ db, env }, body) {
  const bucket = getBucket(env);
  const p = await readUploadToken(env, body.token);
  const expectedParts = Math.ceil(p.size / PART_SIZE);

  // Reluare sigură: dacă fișierul a fost deja finalizat, răspundem cu succes.
  const [done] = await db('SELECT size::float8 AS size FROM cd_items WHERE id = $1', [p.id]);
  if (done && Number(done.size) === p.size) return { success: true };

  const parts = Array.isArray(body.parts) ? body.parts : [];
  const seen = new Set();
  const clean = parts.map(part => ({ partNumber: Math.floor(Number(part?.partNumber)), etag: String(part?.etag ?? '') }));
  for (const part of clean) {
    if (!(part.partNumber >= 1 && part.partNumber <= expectedParts) || !part.etag || seen.has(part.partNumber)) {
      throw new HttpError(400, 'Lista de fragmente este invalidă. Reia încărcarea.');
    }
    seen.add(part.partNumber);
  }
  if (clean.length !== expectedParts) throw new HttpError(400, 'Lipsesc fragmente din fișier. Reia încărcarea.');
  clean.sort((a, b) => a.partNumber - b.partNumber);

  const key = fileKey(p.id);
  let object;
  try {
    object = await bucket.resumeMultipartUpload(key, p.uid).complete(clean);
  } catch {
    throw new HttpError(400, 'Fragmentele nu au putut fi asamblate. Reia încărcarea.');
  }
  if (Number(object.size) !== p.size) {
    await bucket.delete(key);
    throw new HttpError(400, 'Dimensiunea fișierului asamblat nu corespunde. Reia încărcarea.');
  }
  try {
    await requireParentFolder(db, p.parentId);
  } catch (error) {
    await bucket.delete(key);
    throw error;
  }
  if (!(await insertFileRow(db, p))) throw new HttpError(409, 'Un element cu acest id există deja.');
  return { success: true };
}

async function actionUploadAbort({ env }, body) {
  const bucket = getBucket(env);
  const p = await readUploadToken(env, body.token);
  try { await bucket.resumeMultipartUpload(fileKey(p.id), p.uid).abort(); } catch { /* deja anulat */ }
  return { success: true };
}

// ---------- linkuri utile ----------

const LINK_COLS = 'id, title, url, position, created_at::float8 AS created_at';
const toLink = r => ({ id: r.id, title: r.title, url: r.url, position: Number(r.position), createdAt: Number(r.created_at) });

function cleanLink(body) {
  const title = String(body.title ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!title || title.length > 200) throw new HttpError(400, 'Titlul este obligatoriu (maxim 200 de caractere).');
  let raw = String(body.url ?? '').trim();
  if (raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new HttpError(400, 'Adresa linkului nu este validă.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.href.length > 2048) {
    throw new HttpError(400, 'Sunt permise doar adrese http:// sau https://.');
  }
  return { title, url: parsed.href };
}

async function renumberLinks(db, orderedIds) {
  if (!orderedIds.length) return;
  const payload = JSON.stringify(orderedIds.map((id, i) => ({ id, pos: i + 1 })));
  await db(
    `UPDATE cd_links SET position = v.pos
     FROM jsonb_to_recordset($1::jsonb) AS v(id text, pos int)
     WHERE cd_links.id = v.id`,
    [payload]
  );
}

const approvedLinkIds = async db =>
  (await db(`SELECT id FROM cd_links WHERE status = 'approved' ORDER BY position ASC, created_at ASC`)).map(r => r.id);

async function actionLinks({ db }) {
  const rows = await db(`SELECT ${LINK_COLS} FROM cd_links WHERE status = 'approved' ORDER BY position ASC, created_at ASC`);
  return rows.map(toLink);
}

async function actionLinkProposals({ db, session }) {
  requireAuth(session);
  const rows = await db(`SELECT ${LINK_COLS} FROM cd_links WHERE status = 'pending' ORDER BY created_at ASC`);
  return rows.map(toLink);
}

async function actionProposeLink({ db }, body) {
  const link = cleanLink(body);
  const [r] = await db(`SELECT COUNT(*)::int AS n FROM cd_links WHERE status = 'pending'`);
  if (Number(r.n) >= 200) throw new HttpError(429, 'Sunt prea multe propuneri în așteptare. Încearcă mai târziu.');
  await db(
    `INSERT INTO cd_links (id, title, url, position, status, created_at) VALUES ($1, $2, $3, 0, 'pending', $4)`,
    [newId('link'), link.title, link.url, Date.now()]
  );
  return { success: true };
}

async function actionSaveLink({ db, session }, body) {
  requireAuth(session);
  const link = cleanLink(body);
  if (body.id) {
    const id = requireId(body.id, 'link');
    const rows = await db('UPDATE cd_links SET title = $2, url = $3 WHERE id = $1 RETURNING id', [id, link.title, link.url]);
    if (!rows.length) throw new HttpError(404, 'Linkul nu mai este disponibil.');
    return { success: true };
  }
  const position = (await approvedLinkIds(db)).length + 1;
  await db(
    `INSERT INTO cd_links (id, title, url, position, status, created_at) VALUES ($1, $2, $3, $4, 'approved', $5)`,
    [newId('link'), link.title, link.url, position, Date.now()]
  );
  return { success: true };
}

async function actionRemoveLink({ db, session }, body) {
  requireAuth(session);
  const id = requireId(body.id, 'link');
  await db('DELETE FROM cd_links WHERE id = $1', [id]);
  await renumberLinks(db, await approvedLinkIds(db));
  return { success: true };
}

async function actionReviewLink({ db, session }, body) {
  requireAuth(session);
  const id = requireId(body.id, 'link');
  if (body.decision !== 'approved' && body.decision !== 'rejected') throw new HttpError(400, 'Decizie invalidă.');
  const [link] = await db('SELECT status FROM cd_links WHERE id = $1', [id]);
  if (!link || link.status !== 'pending') {
    throw new HttpError(409, 'Propunerea a fost deja procesată sau nu mai există.');
  }
  if (body.decision === 'rejected') {
    await db('DELETE FROM cd_links WHERE id = $1', [id]);
    return { success: true };
  }
  const position = (await approvedLinkIds(db)).length + 1;
  await db(`UPDATE cd_links SET status = 'approved', position = $2 WHERE id = $1`, [id, position]);
  return { success: true };
}

async function actionReorderLink({ db, session }, body) {
  requireAuth(session);
  const id = requireId(body.id, 'link');
  const ids = await approvedLinkIds(db);
  const from = ids.indexOf(id);
  if (from < 0) throw new HttpError(404, 'Linkul nu mai este disponibil.');
  ids.splice(from, 1);
  const wanted = Math.floor(toNumber(body.position, 1));
  ids.splice(Math.min(Math.max(wanted, 1), ids.length + 1) - 1, 0, id);
  await renumberLinks(db, ids);
  return { success: true };
}

// ---------- tabele publice ----------

const toTable = r => ({ id: r.id, title: r.title, content: r.content, updatedAt: new Date(Number(r.updated_at)).toISOString() });
const toProposal = r => ({
  id: r.id,
  tableId: r.table_id,
  content: r.content,
  note: r.note,
  baseUpdatedAt: Number(r.base_updated_at),
  createdAt: Number(r.created_at),
});
const PROPOSAL_COLS = 'id, table_id, content, note, base_updated_at::float8 AS base_updated_at, created_at::float8 AS created_at';

async function actionTables({ db }) {
  const rows = await db('SELECT id, title, content, updated_at::float8 AS updated_at FROM cd_tables ORDER BY created_at ASC');
  return rows.map(toTable);
}

async function actionSaveTable({ db, session }, body) {
  requireAuth(session);
  const title = String(body.title ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!title || title.length > 200) throw new HttpError(400, 'Titlul este obligatoriu (maxim 200 de caractere).');
  const content = normalizeTableContent(body.content);
  const now = Date.now();
  if (body.id) {
    const id = requireId(body.id, 'tabel');
    const rows = await db(
      'UPDATE cd_tables SET title = $2, content = $3, updated_at = $4 WHERE id = $1 RETURNING id',
      [id, title, content, now]
    );
    if (!rows.length) throw new HttpError(404, 'Tabelul nu mai este disponibil.');
    return { success: true, id };
  }
  const id = newId('tbl');
  await db('INSERT INTO cd_tables (id, title, content, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)', [id, title, content, now]);
  return { success: true, id };
}

async function actionRemoveTable({ db, session }, body) {
  requireAuth(session);
  const id = requireId(body.id, 'tabel');
  await db('DELETE FROM cd_table_proposals WHERE table_id = $1', [id]);
  await db('DELETE FROM cd_tables WHERE id = $1', [id]);
  return { success: true };
}

// Oricine poate propune o modificare; nimic nu se schimbă până nu o aprobă un utilizator autentificat.
async function actionProposeTable({ db }, body) {
  const tableId = requireId(body.tableId, 'tabel');
  const [table] = await db('SELECT id, content, updated_at::float8 AS updated_at FROM cd_tables WHERE id = $1', [tableId]);
  if (!table) throw new HttpError(404, 'Tabelul nu mai este disponibil.');
  const proposed = parseTableContent(body.content);
  if (!proposed) throw new HttpError(400, 'Format de tabel nepotrivit. Reîncarcă pagina și încearcă din nou.');
  const locked = lockSizes(table.content, proposed);
  const current = parseTableContent(table.content);
  if (current && sameRows(current, locked)) throw new HttpError(400, 'Propunerea nu conține nicio modificare.');
  const note = String(body.note ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 300);
  const [perTable] = await db('SELECT COUNT(*)::int AS n FROM cd_table_proposals WHERE table_id = $1', [tableId]);
  const [total] = await db('SELECT COUNT(*)::int AS n FROM cd_table_proposals');
  if (Number(perTable.n) >= 20 || Number(total.n) >= 200) {
    throw new HttpError(429, 'Sunt prea multe propuneri în așteptare pentru acest tabel. Încearcă mai târziu.');
  }
  await db(
    `INSERT INTO cd_table_proposals (id, table_id, content, note, base_updated_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [newId('prop'), tableId, JSON.stringify(locked), note, table.updated_at, Date.now()]
  );
  return { success: true };
}

async function actionTableProposals({ db, session }) {
  requireAuth(session);
  const rows = await db(`SELECT ${PROPOSAL_COLS} FROM cd_table_proposals ORDER BY created_at ASC`);
  return rows.map(toProposal);
}

async function actionReviewTableProposal({ db, session }, body) {
  requireAuth(session);
  const id = requireId(body.id, 'propunere');
  if (body.decision !== 'approved' && body.decision !== 'rejected') throw new HttpError(400, 'Decizie invalidă.');
  const [proposal] = await db(`SELECT ${PROPOSAL_COLS} FROM cd_table_proposals WHERE id = $1`, [id]);
  if (!proposal) throw new HttpError(409, 'Propunerea a fost deja procesată sau nu mai există.');
  if (body.decision === 'approved') {
    const [table] = await db('SELECT id, content FROM cd_tables WHERE id = $1', [proposal.table_id]);
    if (!table) {
      await db('DELETE FROM cd_table_proposals WHERE id = $1', [id]);
      throw new HttpError(409, 'Tabelul nu mai există.');
    }
    const locked = lockSizes(table.content, parseTableContent(proposal.content));
    await db('UPDATE cd_tables SET content = $2, updated_at = $3 WHERE id = $1', [table.id, JSON.stringify(locked), Date.now()]);
  }
  await db('DELETE FROM cd_table_proposals WHERE id = $1', [id]);
  return { success: true };
}

// ---------- rutare ----------

const ACTIONS = {
  session: actionSession,
  signin: actionSignIn,
  signout: actionSignOut,
  items: actionItems,
  save: actionSave,
  remove: actionRemove,
  uploadInit: actionUploadInit,
  uploadComplete: actionUploadComplete,
  uploadAbort: actionUploadAbort,
  links: actionLinks,
  linkProposals: actionLinkProposals,
  proposeLink: actionProposeLink,
  saveLink: actionSaveLink,
  removeLink: actionRemoveLink,
  reviewLink: actionReviewLink,
  reorderLink: actionReorderLink,
  tables: actionTables,
  saveTable: actionSaveTable,
  removeTable: actionRemoveTable,
  proposeTable: actionProposeTable,
  tableProposals: actionTableProposals,
  reviewTableProposal: actionReviewTableProposal,
};

export const onRequestPost = handle(async ({ request, env }) => {
  checkOrigin(request);
  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, 'Cerere invalidă.'); }
  const action = String(body?.action ?? '');
  if (!Object.hasOwn(ACTIONS, action)) throw new HttpError(400, 'Acțiune necunoscută.');
  const context = { env, request, session: await getSession(request, env) };
  if (!NO_DB.has(action)) {
    context.db = getDb(env);
    await ensureSchema(context.db);
  }
  const result = await ACTIONS[action](context, body);
  return result instanceof Response ? result : json(result);
});
