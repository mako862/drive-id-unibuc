// PUT /api/upload?token=...&part=N   (corpul cererii = bytes-ii fragmentului)
// Tokenul este semnat de server la uploadInit și leagă încărcarea de un fișier, o dimensiune și un id anume.
import { getBucket } from '../_lib/db.js';
import { getSecret, verifyToken } from '../_lib/auth.js';
import { HttpError, json, handle, checkOrigin, PART_SIZE, fileKey } from '../_lib/util.js';

export const onRequestPut = handle(async ({ request, env }) => {
  checkOrigin(request);
  const bucket = getBucket(env);
  const url = new URL(request.url);

  const payload = await verifyToken(url.searchParams.get('token'), getSecret(env), 'up');
  if (!payload) throw new HttpError(410, 'Sesiunea de încărcare a expirat. Pornește încărcarea din nou.');

  const totalParts = Math.ceil(payload.size / PART_SIZE);
  const part = Number(url.searchParams.get('part'));
  if (!Number.isInteger(part) || part < 1 || part > totalParts) throw new HttpError(400, 'Număr de fragment invalid.');

  const expected = part < totalParts ? PART_SIZE : payload.size - PART_SIZE * (totalParts - 1);
  const length = Number(request.headers.get('Content-Length'));
  if (!request.body || length !== expected) {
    throw new HttpError(400, 'Dimensiunea fragmentului nu corespunde. Reia încărcarea.');
  }

  let uploaded;
  try {
    uploaded = await bucket.resumeMultipartUpload(fileKey(payload.id), payload.uid).uploadPart(part, request.body);
  } catch {
    throw new HttpError(410, 'Încărcarea nu mai este activă. Pornește încărcarea din nou.');
  }
  return json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
});
