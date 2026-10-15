// Punctul de intrare pentru Cloudflare Workers.
// Fișierele din public/ sunt servite direct de Cloudflare (gratuit, fără să pornească acest cod);
// aici ajung doar cererile către /api/*.
import * as driveApi from '../functions/api/drive.js';
import * as uploadApi from '../functions/api/upload.js';
import * as fileApi from '../functions/api/file/[id].js';

const jsonError = (status, message, headers = {}) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (pathname === '/api/drive') {
      return method === 'POST' ? driveApi.onRequestPost({ request, env }) : jsonError(405, 'Metodă nepermisă.', { Allow: 'POST' });
    }
    if (pathname === '/api/upload') {
      return method === 'PUT' ? uploadApi.onRequestPut({ request, env }) : jsonError(405, 'Metodă nepermisă.', { Allow: 'PUT' });
    }
    const file = /^\/api\/file\/([^/]+)$/.exec(pathname);
    if (file) {
      if (method !== 'GET' && method !== 'HEAD') return jsonError(405, 'Metodă nepermisă.', { Allow: 'GET, HEAD' });
      let id;
      try { id = decodeURIComponent(file[1]); } catch { return jsonError(404, 'Fișierul nu există.'); }
      return fileApi.onRequestGet({ request, env, params: { id } });
    }
    if (pathname.startsWith('/api/')) return jsonError(404, 'Adresă necunoscută.');

    // Rezervă: dacă ajunge aici o cerere ne-API, o servim ca fișier static.
    return env.ASSETS ? env.ASSETS.fetch(request) : jsonError(404, 'Nu există.');
  },
};
