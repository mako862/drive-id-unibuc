// Generează schema.sql din functions/_lib/schema.js (sursa unică).
import { writeFileSync } from 'node:fs';
import { SCHEMA_STATEMENTS } from '../functions/_lib/schema.js';

const header = `-- Schema Drept UniBuc Drive (Neon / PostgreSQL)
-- Se rulează O SINGURĂ DATĂ în Neon -> SQL Editor. (Aplicația o creează singură la prima rulare,
-- dar e bine s-o rulezi manual ca să vezi că totul e în regulă.)
-- Generat automat: nu edita; modifică functions/_lib/schema.js și rulează npm run schema.

`;
writeFileSync(new URL('../schema.sql', import.meta.url), header + SCHEMA_STATEMENTS.join(';\n\n') + ';\n');
console.log('schema.sql generat.');
