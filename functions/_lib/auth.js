// Sesiuni semnate cu HMAC-SHA256. Cookie-ul NU poate fi falsificat fără SESSION_SECRET.
import { HttpError } from './util.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
export const COOKIE_NAME = 'drive_session';
export const SESSION_SECONDS = 7 * 24 * 3600;

function toB64u(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64u(text) {
  const pad = '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function getSecret(env) {
  const secret = String(env.SESSION_SECRET || '');
  if (secret.length < 24) {
    throw new HttpError(500, 'Configurare incompletă: variabila SESSION_SECRET lipsește sau este prea scurtă (minim 24 de caractere).');
  }
  return secret;
}

export async function signToken(payload, secret) {
  const body = toB64u(enc.encode(JSON.stringify(payload)));
  const sig = toB64u(await hmac(secret, body));
  return `${body}.${sig}`;
}

// Returnează payload-ul doar dacă semnătura este corectă, tipul se potrivește și nu a expirat.
export async function verifyToken(token, secret, type) {
  if (typeof token !== 'string') return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  try {
    const expected = await hmac(secret, body);
    if (!constantTimeEqual(expected, fromB64u(sig))) return null;
    const payload = JSON.parse(dec.decode(fromB64u(body)));
    if (payload.t !== type) return null;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Compară două parole fără scurgeri de timp (compară HMAC-urile lor).
export async function passwordsMatch(input, expected, secret) {
  if (!expected) return false;
  const a = await hmac(secret, 'pw:' + String(input ?? ''));
  const b = await hmac(secret, 'pw:' + String(expected));
  return constantTimeEqual(a, b);
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

export async function getSession(request, env) {
  const anonymous = { isAuthenticated: false, isAdmin: false, role: null };
  const secret = String(env.SESSION_SECRET || '');
  if (secret.length < 24) return anonymous;
  const payload = await verifyToken(readCookie(request, COOKIE_NAME), secret, 'session');
  if (!payload || (payload.r !== 'admin' && payload.r !== 'member')) return anonymous;
  return { isAuthenticated: true, isAdmin: payload.r === 'admin', role: payload.r };
}

export function sessionCookie(token, maxAge = SESSION_SECONDS) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
