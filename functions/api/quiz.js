// POST /api/quiz  —  toate acțiunile quiz-ului (JSON).
// Baza de date: Neon (tabelele qz_*). Parola de administrator: secretul QUIZ_ADMIN_PASSWORD (inițial),
// apoi poate fi schimbată din site (se păstrează în baza de date, nu în cod).
import { getDb } from '../_lib/db.js';
import { getSecret, signToken, verifyToken, passwordsMatch } from '../_lib/auth.js';
import { HttpError, json, handle, checkOrigin, requireId, sleep } from '../_lib/util.js';
import {
  ensureQuizSchema, hmacHex, makePasswordRecord, checkPasswordRecord,
  sessionCookie, clearCookie, readCookie, COOKIE, SESSION_SECONDS,
  normalizeQuestion, normalizeCategories, normalizeSubject, cleanNotes,
  newId, validId, toQuestion, toProposal,
} from '../_lib/quiz.js';

const safeParse = text => { try { return JSON.parse(text); } catch { return null; } };

// ---------- autentificare ----------

// „Amprenta” parolei curente: se schimbă când se schimbă parola, deci sesiunile vechi încetează să mai fie valide.
async function adminFingerprint({ db, env, secret }) {
  const [row] = await db(`SELECT value FROM qz_settings WHERE key = 'admin_hash'`);
  if (row) return (await hmacHex(secret, `pv:${row.value}`)).slice(0, 16);
  if (env.QUIZ_ADMIN_PASSWORD) return (await hmacHex(secret, `pv-env:${env.QUIZ_ADMIN_PASSWORD}`)).slice(0, 16);
  return null;
}

async function sessionIsAdmin(ctx, knownFingerprint) {
  const payload = await verifyToken(readCookie(ctx.request, COOKIE), ctx.secret, 'quiz');
  if (!payload) return false;
  const current = knownFingerprint === undefined ? await adminFingerprint(ctx) : knownFingerprint;
  return !!current && payload.pv === current;
}

async function requireAdmin(ctx) {
  if (!(await sessionIsAdmin(ctx))) throw new HttpError(401, 'Autentificare administrator necesară.');
}

async function passwordOk(ctx, password) {
  const [row] = await ctx.db(`SELECT value FROM qz_settings WHERE key = 'admin_hash'`);
  if (row) return checkPasswordRecord(ctx.secret, row.value, password);
  return passwordsMatch(password, ctx.env.QUIZ_ADMIN_PASSWORD, ctx.secret);
}

async function newSessionCookie(ctx) {
  const pv = await adminFingerprint(ctx);
  const token = await signToken({ t: 'quiz', pv, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }, ctx.secret);
  return sessionCookie(token);
}

async function actionSession(ctx) {
  return { isAdmin: await sessionIsAdmin(ctx) };
}

async function actionSignIn(ctx) {
  const [stored] = await ctx.db(`SELECT 1 AS x FROM qz_settings WHERE key = 'admin_hash'`);
  if (!stored && !ctx.env.QUIZ_ADMIN_PASSWORD) {
    throw new HttpError(500, 'Parola de administrator nu este configurată. Adaugă secretul QUIZ_ADMIN_PASSWORD în Cloudflare.');
  }
  if (!(await passwordOk(ctx, String(ctx.body.password ?? '')))) {
    await sleep(600); // încetinește ghicirea parolei
    throw new HttpError(401, 'Parolă incorectă.');
  }
  return json({ isAdmin: true }, 200, { 'Set-Cookie': await newSessionCookie(ctx) });
}

async function actionSignOut() {
  return json({ isAdmin: false }, 200, { 'Set-Cookie': clearCookie() });
}

async function setSetting(db, key, value) {
  await db(
    `INSERT INTO qz_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

async function actionChangePassword(ctx) {
  await requireAdmin(ctx);
  const current = String(ctx.body.current ?? '');
  const next = String(ctx.body.next ?? '');
  if (!(await passwordOk(ctx, current))) {
    await sleep(600);
    throw new HttpError(403, 'Parola actuală este incorectă.'); // 403, nu 401: sesiunea rămâne validă
  }
  if (next.length < 8) throw new HttpError(400, 'Parola nouă trebuie să aibă cel puțin 8 caractere.');
  if (next.length > 200) throw new HttpError(400, 'Parola nouă este prea lungă.');
  await setSetting(ctx.db, 'admin_hash', await makePasswordRecord(ctx.secret, next));
  // sesiunea curentă rămâne valabilă; celelalte (cu parola veche) sunt deconectate
  return json({ success: true, isAdmin: true }, 200, { 'Set-Cookie': await newSessionCookie(ctx) });
}

// ---------- încărcarea datelor (o singură cerere) ----------

async function actionBootstrap(ctx) {
  const { db } = ctx;
  const [qRows, pRows, sRows, derived, fingerprint] = await Promise.all([
    db(`SELECT id, subject, year, semester, text, explanation, options FROM qz_questions ORDER BY created_at ASC, id ASC`),
    db(`SELECT id, type, target_id, subject, year, semester, text, explanation, options, notes, likes, dislikes, created_at
        FROM qz_proposals ORDER BY created_at DESC, id ASC`),
    db(`SELECT value FROM qz_settings WHERE key = 'subjects'`),
    db(`SELECT subject, MIN(year)::int AS y, MIN(semester)::int AS s1, MAX(semester)::int AS s2
        FROM qz_questions GROUP BY subject ORDER BY subject`),
    adminFingerprint(ctx),
  ]);
  // Categoriile salvate + cele care apar doar în întrebări (ca să poată fi alese la exersare).
  const subjects = normalizeCategories(safeParse(sRows[0]?.value));
  const known = new Set(subjects.map(s => s.code));
  for (const d of derived) {
    if (!d.subject || known.has(d.subject)) continue;
    subjects.push({
      code: d.subject, label: d.subject, year: Number(d.y) || 1,
      semester: Number(d.s1) === Number(d.s2) ? String(d.s1) : 'ALL',
    });
  }
  return {
    questions: qRows.map(toQuestion),
    proposals: pRows.map(toProposal),
    subjects,
    isAdmin: await sessionIsAdmin(ctx, fingerprint),
  };
}

// ---------- întrebări (administrator) ----------

const UPSERT_QUESTION = `
  INSERT INTO qz_questions (id, subject, year, semester, text, explanation, options, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
  ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, year = EXCLUDED.year, semester = EXCLUDED.semester,
    text = EXCLUDED.text, explanation = EXCLUDED.explanation, options = EXCLUDED.options, updated_at = EXCLUDED.updated_at`;

async function actionSaveQuestion(ctx) {
  await requireAdmin(ctx);
  const raw = ctx.body.question || {};
  const q = normalizeQuestion(raw);
  const id = raw.id ? requireId(raw.id, 'întrebare') : newId('q');
  await ctx.db(UPSERT_QUESTION, [id, q.subject, q.year, q.semester, q.text, q.explanation, JSON.stringify(q.options), Date.now()]);
  return { success: true, id };
}

async function actionDeleteQuestions(ctx) {
  await requireAdmin(ctx);
  const ids = (Array.isArray(ctx.body.ids) ? ctx.body.ids : []).filter(validId).slice(0, 5000);
  if (!ids.length) return { success: true, removed: 0 };
  const rows = await ctx.db(
    `DELETE FROM qz_questions WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) RETURNING id`,
    [JSON.stringify(ids)]
  );
  return { success: true, removed: rows.length };
}

// Import: acceptă lista de întrebări (formatul exportat) sau un backup complet. Același id = actualizare, deci
// importul aceluiași fișier de două ori nu dublează întrebările.
async function actionImportData(ctx) {
  await requireAdmin(ctx);
  const { questions, proposals, subjects } = ctx.body;
  if (!Array.isArray(questions)) throw new HttpError(400, 'Fișierul nu conține o listă de întrebări.');
  if (questions.length > 5000) throw new HttpError(400, 'Maximum 5000 de întrebări la un import.');

  const base = Date.now();
  const rows = new Map();
  let skipped = 0;
  questions.forEach((raw, i) => {
    let q;
    try { q = normalizeQuestion(raw); } catch { skipped++; return; }
    const id = validId(raw?.id) ? raw.id : `${newId('q')}${i}`;
    rows.set(id, { id, ...q, options: JSON.stringify(q.options), created_at: base + i });
  });

  let added = 0;
  let updated = 0;
  const list = [...rows.values()];
  for (let i = 0; i < list.length; i += 1000) {
    const result = await ctx.db(
      `INSERT INTO qz_questions (id, subject, year, semester, text, explanation, options, created_at, updated_at)
       SELECT x.id, x.subject, x.year, x.semester, x.text, x.explanation, x.options, x.created_at, x.created_at
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, subject text, year int, semester int, text text, explanation text, options text, created_at bigint)
       ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, year = EXCLUDED.year, semester = EXCLUDED.semester,
         text = EXCLUDED.text, explanation = EXCLUDED.explanation, options = EXCLUDED.options, updated_at = EXCLUDED.updated_at
       RETURNING (xmax = 0) AS inserted`,
      [JSON.stringify(list.slice(i, i + 1000))]
    );
    for (const r of result) (r.inserted ? added++ : updated++);
  }

  let proposalsImported = 0;
  if (Array.isArray(proposals)) {
    const pRows = new Map();
    proposals.slice(0, 1000).forEach((raw, i) => {
      let q;
      try { q = normalizeQuestion(raw); } catch { return; }
      const id = validId(raw?.id) ? raw.id : `${newId('p')}${i}`;
      const target = validId(raw?.targetQuestionId) ? raw.targetQuestionId : null;
      pRows.set(id, {
        id, type: target ? 'EDIT' : 'NEW', target_id: target, ...q, options: JSON.stringify(q.options),
        notes: cleanNotes(raw?.proposalNotes),
        likes: Math.max(0, Math.floor(Number(raw?.likes)) || 0), dislikes: Math.max(0, Math.floor(Number(raw?.dislikes)) || 0),
        created_at: Number(raw?.createdAt) > 0 ? Math.floor(Number(raw.createdAt)) : base + i,
      });
    });
    if (pRows.size) {
      const result = await ctx.db(
        `INSERT INTO qz_proposals (id, type, target_id, subject, year, semester, text, explanation, options, notes, likes, dislikes, created_at)
         SELECT x.id, x.type, x.target_id, x.subject, x.year, x.semester, x.text, x.explanation, x.options, x.notes, x.likes, x.dislikes, x.created_at
         FROM jsonb_to_recordset($1::jsonb) AS x(id text, type text, target_id text, subject text, year int, semester int, text text, explanation text, options text, notes text, likes int, dislikes int, created_at bigint)
         ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, target_id = EXCLUDED.target_id, subject = EXCLUDED.subject,
           year = EXCLUDED.year, semester = EXCLUDED.semester, text = EXCLUDED.text, explanation = EXCLUDED.explanation,
           options = EXCLUDED.options, notes = EXCLUDED.notes, likes = EXCLUDED.likes, dislikes = EXCLUDED.dislikes
         RETURNING id`,
        [JSON.stringify([...pRows.values()])]
      );
      proposalsImported = result.length;
    }
  }

  if (subjects) {
    const [row] = await ctx.db(`SELECT value FROM qz_settings WHERE key = 'subjects'`);
    const merged = new Map(normalizeCategories(safeParse(row?.value)).map(c => [c.code, c]));
    for (const c of normalizeCategories(subjects)) merged.set(c.code, c);
    await setSetting(ctx.db, 'subjects', JSON.stringify([...merged.values()]));
  }
  return { success: true, added, updated, skipped, proposals: proposalsImported };
}

// ---------- categorii (administrator) ----------

async function actionSaveSubjects(ctx) {
  await requireAdmin(ctx);
  const subjects = normalizeCategories(ctx.body.subjects);
  const renames = Array.isArray(ctx.body.renames) ? ctx.body.renames.slice(0, 200) : [];
  for (const r of renames) {
    const from = normalizeSubject(r?.from);
    const to = normalizeSubject(r?.to);
    if (!from || !to || from === to) continue;
    await ctx.db('UPDATE qz_questions SET subject = $2 WHERE subject = $1', [from, to]);
    await ctx.db('UPDATE qz_proposals SET subject = $2 WHERE subject = $1', [from, to]);
  }
  await setSetting(ctx.db, 'subjects', JSON.stringify(subjects));
  return { success: true };
}

// ---------- propuneri ----------

// Oricine poate propune o întrebare nouă sau o modificare; nimic nu intră în bază până nu aprobă administratorul.
async function actionSaveProposal(ctx) {
  const raw = ctx.body.proposal || {};
  const q = normalizeQuestion(raw);
  const notes = cleanNotes(raw.proposalNotes);
  const target = validId(raw.targetQuestionId) ? raw.targetQuestionId : null;
  const type = target ? 'EDIT' : 'NEW';
  const options = JSON.stringify(q.options);

  if (raw.id) {
    const id = requireId(raw.id, 'propunere');
    const rows = await ctx.db(
      `UPDATE qz_proposals SET type = $2, target_id = $3, subject = $4, year = $5, semester = $6,
         text = $7, explanation = $8, options = $9, notes = $10 WHERE id = $1 RETURNING id`,
      [id, type, target, q.subject, q.year, q.semester, q.text, q.explanation, options, notes]
    );
    if (!rows.length) throw new HttpError(404, 'Propunerea nu mai există (a fost aprobată sau respinsă).');
    return { success: true, id };
  }
  const [count] = await ctx.db('SELECT COUNT(*)::int AS n FROM qz_proposals');
  if (Number(count.n) >= 500) throw new HttpError(429, 'Sunt prea multe propuneri în așteptare. Încearcă mai târziu.');
  const id = newId('p');
  await ctx.db(
    `INSERT INTO qz_proposals (id, type, target_id, subject, year, semester, text, explanation, options, notes, likes, dislikes, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 0, $11)`,
    [id, type, target, q.subject, q.year, q.semester, q.text, q.explanation, options, notes, Date.now()]
  );
  return { success: true, id };
}

async function actionVoteProposal(ctx) {
  const id = requireId(ctx.body.id, 'propunere');
  if (ctx.body.vote !== 'LIKE' && ctx.body.vote !== 'DISLIKE') throw new HttpError(400, 'Vot invalid.');
  const column = ctx.body.vote === 'LIKE' ? 'likes' : 'dislikes';
  const rows = await ctx.db(`UPDATE qz_proposals SET ${column} = ${column} + 1 WHERE id = $1 RETURNING likes, dislikes`, [id]);
  if (!rows.length) throw new HttpError(404, 'Propunerea nu mai există.');
  return { success: true, likes: Number(rows[0].likes), dislikes: Number(rows[0].dislikes) };
}

async function actionApproveProposal(ctx) {
  await requireAdmin(ctx);
  const id = requireId(ctx.body.id, 'propunere');
  const [p] = await ctx.db(
    `SELECT id, type, target_id, subject, year, semester, text, explanation, options FROM qz_proposals WHERE id = $1`, [id]
  );
  if (!p) throw new HttpError(409, 'Propunerea a fost deja procesată sau nu mai există.');
  const questionId = p.type === 'EDIT' && p.target_id ? p.target_id : newId('q');
  await ctx.db(UPSERT_QUESTION, [questionId, p.subject, p.year, p.semester, p.text, p.explanation, p.options, Date.now()]);
  await ctx.db('DELETE FROM qz_proposals WHERE id = $1', [id]);
  return { success: true, id: questionId };
}

async function actionRejectProposal(ctx) {
  await requireAdmin(ctx);
  await ctx.db('DELETE FROM qz_proposals WHERE id = $1', [requireId(ctx.body.id, 'propunere')]);
  return { success: true };
}

// ---------- rutare ----------

const ACTIONS = {
  bootstrap: actionBootstrap,
  session: actionSession,
  signin: actionSignIn,
  signout: actionSignOut,
  changePassword: actionChangePassword,
  saveQuestion: actionSaveQuestion,
  deleteQuestions: actionDeleteQuestions,
  importData: actionImportData,
  saveSubjects: actionSaveSubjects,
  saveProposal: actionSaveProposal,
  voteProposal: actionVoteProposal,
  approveProposal: actionApproveProposal,
  rejectProposal: actionRejectProposal,
};

export const onRequestPost = handle(async ({ request, env }) => {
  checkOrigin(request);
  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, 'Cerere invalidă.'); }
  const action = String(body?.action ?? '');
  if (!Object.hasOwn(ACTIONS, action)) throw new HttpError(400, 'Acțiune necunoscută.');
  const secret = getSecret(env);
  const db = getDb(env);
  await ensureQuizSchema(db);
  const result = await ACTIONS[action]({ request, env, secret, db, body });
  return result instanceof Response ? result : json(result);
});
