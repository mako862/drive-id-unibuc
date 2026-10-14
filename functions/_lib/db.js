import { neon } from '';
import { HttpError } from './util.js';
import { SCHEMA_STATEMENTS } from './schema.js';

let schemaChecked = false;

// Returnează o funcție db(text, params) -> rânduri (array de obiecte).
export function getDb(env) {
  if (!env.DATABASE_URL) {
    throw new HttpError(500, 'Configurare incompletă: variabila DATABASE_URL lipsește.');
  }
  const sql = neon(env.DATABASE_URL);
  return (text, params = []) => sql.query(text, params);
}

// Creează tabelele la prima rulare (o singură interogare de verificare per instanță).
export async function ensureSchema(db) {
  if (schemaChecked) return;
  const [row] = await db(
    `SELECT (to_regclass('cd_items') IS NOT NULL
         AND to_regclass('cd_links') IS NOT NULL
         AND to_regclass('cd_tables') IS NOT NULL) AS ok`
  );
  if (!row?.ok) {
    for (const statement of SCHEMA_STATEMENTS) await db(statement);
  }
  schemaChecked = true;
}

export function getBucket(env) {
  if (!env.FILES) {
    throw new HttpError(500, 'Configurare incompletă: bucket-ul R2 (binding „FILES”) nu este conectat la proiect.');
  }
  return env.FILES;
}
