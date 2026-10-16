// GET /api/file/:id          -> previzualizare (inline, doar pentru tipuri sigure)
// GET /api/file/:id?dl=1     -> descărcare (attachment)
// Suportă Range (audio/video cu derulare, PDF cu încărcare parțială).
import { getDb, ensureSchema, getBucket } from '../../_lib/db.js';
import { getSession } from '../../_lib/auth.js';
import { HttpError, handle, ID_RE, fileKey } from '../../_lib/util.js';

const EXT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', csv: 'text/plain', tsv: 'text/plain',
  json: 'text/plain', log: 'text/plain',
};

// Doar aceste tipuri pot fi afișate direct în browser; restul se descarcă forțat.
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|bmp|avif|svg\+xml)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/pdf|text\/plain)$/;

function resolveType(row) {
  const ext = (String(row.name).match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
  const declared = String(row.type || '').toLowerCase();
  return EXT_TYPES[ext] || (declared && declared !== 'application/octet-stream' ? declared : 'application/octet-stream');
}

function contentDisposition(kind, name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

// Interpretează un antet Range de forma bytes=a-b | bytes=a- | bytes=-n (un singur interval).
// Returnează null (servește tot fișierul), 'invalid' (416) sau { offset, length }.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || size === 0 || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  if (start >= size) return 'invalid';
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}

export const onRequestGet = handle(async ({ request, env, params }) => {
  const id = String(params.id ?? '');
  if (!ID_RE.test(id)) throw new HttpError(404, 'Fișierul nu există.');

  const db = getDb(env);
  await ensureSchema(db);
  const [row] = await db(
    'SELECT id, name, is_folder, size::float8 AS size, type, status FROM cd_items WHERE id = $1',
    [id]
  );
  const session = await getSession(request, env);
  // Fișierele neaprobate sunt vizibile numai administratorului.
  if (!row || row.is_folder || (row.status !== 'approved' && !session.isAdmin)) {
    throw new HttpError(404, 'Fișierul nu există sau nu este disponibil.');
  }

  const total = Number(row.size);
  const range = parseRange(request.headers.get('Range'), total);
  if (range === 'invalid') {
    return new Response('Interval invalid', { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }
  const bucket = getBucket(env);
  const object = await bucket.get(fileKey(id), range ? { range } : undefined);
  if (!object) throw new HttpError(404, 'Conținutul fișierului lipsește din stocare.');

  const type = resolveType(row);
  const download = new URL(request.url).searchParams.get('dl') === '1';
  const inline = !download && INLINE_SAFE.test(type);

  const headers = new Headers({
    'Content-Type': inline ? (type === 'text/plain' ? 'text/plain; charset=utf-8' : type) : 'application/octet-stream',
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', row.name),
    'Accept-Ranges': 'bytes',
    'ETag': object.httpEtag,
    'Cache-Control': row.status === 'approved' ? 'private, max-age=3600' : 'private, no-store',
    // Un fișier încărcat de un vizitator nu are voie să ruleze scripturi în site-ul nostru.
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
  });

  headers.set('Content-Length', String(range ? range.length : total));
  if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${total}`);
  return new Response(object.body, { status: range ? 206 : 200, headers });
});
