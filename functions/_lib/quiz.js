// Cod specific pentru quiz: schemă, validări și parola de administrator.
// Folosește fișierele comune util.js / auth.js / db.js din același proiect (le are deja site-ul Drive).
import { HttpError, ID_RE } from './util.js';

// ---------- schemă ----------
export const QUIZ_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS qz_questions (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL DEFAULT '',
  year        INTEGER NOT NULL DEFAULT 1,
  semester    INTEGER NOT NULL DEFAULT 1,
  text        TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  options     TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS qz_questions_subject_idx ON qz_questions (subject)`,
  `CREATE TABLE IF NOT EXISTS qz_proposals (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'NEW',
  target_id   TEXT,
  subject     TEXT NOT NULL DEFAULT '',
  year        INTEGER NOT NULL DEFAULT 1,
  semester    INTEGER NOT NULL DEFAULT 1,
  text        TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  options     TEXT NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  likes       INTEGER NOT NULL DEFAULT 0,
  dislikes    INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS qz_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
)`,
];

let schemaReady = false;
export async function ensureQuizSchema(db) {
  if (schemaReady) return;
  const [row] = await db(
    `SELECT (to_regclass('qz_questions') IS NOT NULL
         AND to_regclass('qz_proposals') IS NOT NULL
         AND to_regclass('qz_settings') IS NOT NULL) AS ok`
  );
  if (!row?.ok) for (const statement of QUIZ_SCHEMA) await db(statement);
  schemaReady = true;
}

// ---------- criptografie simplă ----------
const enc = new TextEncoder();

export async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomHex(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Parola nouă se păstrează în baza de date ca „sare:semnătură”, semnată cu SESSION_SECRET
// (fără secretul din Cloudflare, o copie a bazei de date nu permite ghicirea parolei).
export async function makePasswordRecord(secret, password) {
  const salt = randomHex(16);
  return `${salt}:${await hmacHex(secret, `qzpw:${salt}:${password}`)}`;
}

export async function checkPasswordRecord(secret, record, password) {
  const [salt, hash] = String(record).split(':');
  if (!salt || !hash) return false;
  return safeEqual(await hmacHex(secret, `qzpw:${salt}:${password}`), hash);
}

// ---------- cookie ----------
export const COOKIE = 'quiz_session';
export const SESSION_SECONDS = 7 * 24 * 3600;
export const sessionCookie = token => `${COOKIE}=${token}; Path=/api/quiz; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
export const clearCookie = () => `${COOKIE}=; Path=/api/quiz; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

// ---------- validări ----------
const clean = (value, max) =>
  String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const clampInt = (value, min, max, fallback) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function normalizeSubject(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 30);
}

export function normalizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Întrebare invalidă.');
  const text = clean(raw.text, 2000);
  if (!text) throw new HttpError(400, 'Textul întrebării este obligatoriu.');
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map(o => ({ text: clean(o?.text, 1000), correct: o?.correct === true || o?.correct === 'true' }))
    .filter(o => o.text);
  if (options.length < 2) throw new HttpError(400, 'Introduceți cel puțin 2 variante de răspuns.');
  if (options.length > 6) throw new HttpError(400, 'Maximum 6 variante de răspuns.');
  if (!options.some(o => o.correct)) throw new HttpError(400, 'Bifați cel puțin o variantă corectă.');
  return {
    subject: normalizeSubject(raw.subject) || 'GENERAL',
    year: clampInt(raw.year, 1, 6, 1),
    semester: clampInt(raw.semester, 1, 2, 1),
    text,
    explanation: clean(raw.explanation, 4000),
    options,
  };
}

export const cleanNotes = value => clean(value, 500);

export function normalizeCategories(input) {
  const items = Array.isArray(input)
    ? input
    : (input && typeof input === 'object' ? Object.entries(input).map(([code, v]) => ({ code, ...(v || {}) })) : []);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const code = normalizeSubject(item?.code);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({
      code,
      label: clean(item.label ?? item.name, 120) || code,
      year: clampInt(item.year, 1, 6, 1),
      semester: ['1', '2', 'ALL'].includes(String(item.semester)) ? String(item.semester) : 'ALL',
    });
    if (out.length >= 200) break;
  }
  return out;
}

export const newId = prefix => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export const validId = id => typeof id === 'string' && ID_RE.test(id);

// ---------- rânduri -> obiecte ----------
const parseOptions = text => { try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; } };

export const toQuestion = r => ({
  id: r.id, subject: r.subject, year: Number(r.year), semester: Number(r.semester),
  text: r.text, explanation: r.explanation, options: parseOptions(r.options),
});

export const toProposal = r => ({
  id: r.id, type: r.type, targetQuestionId: r.target_id || null,
  subject: r.subject, year: Number(r.year), semester: Number(r.semester),
  text: r.text, explanation: r.explanation, options: parseOptions(r.options),
  proposalNotes: r.notes, likes: Number(r.likes), dislikes: Number(r.dislikes), createdAt: Number(r.created_at),
});
