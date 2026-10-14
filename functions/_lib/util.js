// Utilitare comune pentru funcțiile API.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

// Împachetează un handler: transformă HttpError în răspuns JSON curat
// și ascunde detaliile interne ale erorilor neașteptate.
export function handle(fn) {
  return async context => {
    try {
      return await fn(context);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('Eroare neașteptată:', error);
      return json({ error: 'Eroare internă de server. Reîncearcă peste câteva secunde.' }, 500);
    }
  };
}

// Protecție CSRF: cererile care modifică date trebuie să vină de pe același site.
export function checkOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'Cerere respinsă (origine nepermisă).');
  }
}

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function requireId(value, label = 'id') {
  const id = String(value ?? '');
  if (!ID_RE.test(id)) throw new HttpError(400, `Valoare invalidă pentru ${label}.`);
  return id;
}

export function cleanName(value) {
  const name = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 255);
  if (!name) throw new HttpError(400, 'Numele nu poate fi gol.');
  return name;
}

export function cleanType(value) {
  const type = String(value ?? '').trim().toLowerCase().slice(0, 127);
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : '';
}

export function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const MB = 1024 * 1024;
export const GB = 1024 * MB;
export const PART_SIZE = 16 * MB;        // dimensiunea unui fragment la încărcare (R2 multipart)
export const MAX_FILE_SIZE = 5 * GB;     // aceeași limită ca în interfață
export const fileKey = id => `files/${id}`;
