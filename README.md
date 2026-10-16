# Drept UniBuc — Cloud Drive

Site găzduit pe **Cloudflare Pages** (sau Workers, vezi mai jos), cu fișierele în **Cloudflare R2** și metadatele (foldere, linkuri, tabele) în **Neon PostgreSQL**. Codul stă pe **GitHub**. Totul poate rula pe planurile gratuite.

## Ce conține

```
public/                  ← ce vede publicul (site-ul)
  index.html             interfața (neschimbată, în afară de o linie: scriptul tables.js)
  drive.js               clientul: încărcare în fragmente cu reluare, descărcare, cititor PDF/DOCX/XLSX/text
  tables.js, tables.css  „Tabele publice": editor tip Excel, linkuri în celule, propuneri cu aprobare
  download-feedback.js   mesajul „Se pregătește descărcarea…"
  reader.html            „Deschide documentul în filă nouă"
  _headers               antete de securitate
functions/api/           ← backend-ul (Cloudflare Pages Functions)
  drive.js               acțiunile JSON: autentificare, foldere, linkuri, tabele, pornirea încărcărilor
  upload.js              primește fragmentele de fișier și le pune în R2
  file/[id].js           servește fișierele din R2 (descărcare, previzualizare, audio/video cu derulare)
functions/_lib/          cod comun (sesiuni semnate, conexiune Neon, schema)
vendor/                  ← biblioteca Neon inclusă în proiect, ca build-ul să nu aibă nimic de instalat
src/worker.js            intrarea pentru varianta Workers (la Pages nu se folosește)
schema.sql               schema bazei de date (se creează și singură la prima rulare)
wrangler.toml            configurația Pages: conectează bucket-ul R2 la proiect
wrangler.workers.toml    configurația alternativă pentru un proiect de tip Workers
package.json             doar scripturi; proiectul nu are dependențe de instalat
```

Doar conținutul din `public/` este public. `README.md`, `package.json`, `schema.sql`, `vendor/` etc. rămân în afara site-ului.

## Instalare — în ordine

### 1. Neon (baza de date)
1. Cont gratuit pe neon.com → **Create project**.
2. Pe pagina proiectului, apasă **Connect** și copiază **connection string**-ul (începe cu `postgresql://…` și se termină cu `?sslmode=require`). Îl vei folosi la pasul 5.
3. (Opțional) **SQL Editor** → lipește conținutul din `schema.sql` → **Run**. Dacă sari peste, aplicația creează tabelele singură la prima cerere.

### 2. Cloudflare R2 (fișierele)
1. Dashboard Cloudflare → **R2 Object Storage** → **Create bucket**.
2. Nume: **`drept-unibuc-files`** (exact așa, ca în `wrangler.toml`; dacă alegi alt nume, schimbă `bucket_name` din `wrangler.toml`).
3. Cloudflare poate cere un card sau PayPal ca să activeze R2, chiar dacă planul gratuit (10 GB) nu costă nimic.

### 3. GitHub
1. Repository nou, de preferat **Private**.
2. **Add file → Upload files** și trage înăuntru folderele `public`, `functions`, `vendor`, `src`, `scripts` și fișierele `package.json`, `wrangler.toml`, `wrangler.workers.toml`, `schema.sql`, `README.md` (și `.gitignore`, dacă browserul îl arată).
   Folderele trebuie să apară în **rădăcina** repository-ului, nu într-un subfolder.
3. **Nu încărca niciodată** un fișier `.dev.vars` sau parole.

### 4. Cloudflare Pages (site-ul)
1. **Workers & Pages → Create → Pages → Connect to Git** → alege repository-ul.
2. **Build command**: lasă gol · **Build output directory**: `public`. Nu e nimic de instalat sau de compilat.
3. **Save and Deploy**.

### 5. Secretele
În proiectul Pages: **Settings → Variables and Secrets → Add** (tip **Secret**), pentru *Production*:

| Nume | Valoare | Obligatoriu |
|---|---|---|
| `DATABASE_URL` | connection string-ul de la Neon | da |
| `ADMIN_PASSWORD` | o parolă **nouă**, lungă și unică (nu o refolosi pe cea din versiunea veche) | da |
| `SESSION_SECRET` | un șir aleator de cel puțin 32 de caractere. Îl generezi cu `openssl rand -hex 32` sau din managerul de parole | da |
| `ADMIN_EMAIL` | dacă îl pui, la autentificare trebuie scris și acest email | nu |
| `MEMBER_PASSWORD` | parolă pentru utilizatori care pot edita doar linkuri și tabele publice (nu pot aproba fișiere) | nu |
| `MAX_PENDING_ITEMS`, `MAX_PENDING_BYTES` | limite pentru fișierele neaprobate (implicit 1000 de elemente / 2 GB) | nu |

După ce adaugi secretele: **Deployments → ⋯ → Retry deployment**, ca să le preia.

### Dacă proiectul tău din Cloudflare este de tip *Workers*, nu *Pages*
Cloudflare creează uneori un proiect Workers (în log vezi `npx wrangler deploy`). Pachetul merge și așa:
1. În proiect, la **Settings → Build**, setează **Deploy command**: `npx wrangler@4 deploy -c wrangler.workers.toml`.
2. `name` din `wrangler.workers.toml` trebuie să fie identic cu numele proiectului din Cloudflare.
3. Secretele se adaugă la fel (**Settings → Variables and Secrets**, tip *Secret*).

### 6. Verificare
Deschide site-ul → **Autentificare** (parola de admin) → creează un folder → încarcă un fișier → aprobă-l din „În așteptare" → deschide-l și descarcă-l.

### 7. Domeniul tău
Proiectul Pages → **Custom domains** → adaugă domeniul și urmează instrucțiunile de DNS.

## Mutarea datelor de pe Netlify
Backend-ul vechi nu e inclus aici, deci fișierele nu se pot copia automat:
1. Pe site-ul vechi: în „Toate fișierele" selectează tot → **Descarcă**, sau folosește „Descarcă ZIP" pe folderele mari.
2. Pe site-ul nou, ca admin: creează folderele, apoi încarcă fișierele (se poate trage un folder întreg). Ele apar la „În așteptare": selectează-le pe toate → **Aprobă**.
3. Păstrează Netlify activ până verifici că totul e în regulă, apoi oprește-l.

Linkurile utile și tabelele publice se recreează manual din interfață.

## Limite gratuite (verificate în octombrie 2026)
- **R2**: 10 GB stocare, descărcări fără taxă de transfer.
- **Neon**: 0,5 GB și 100 CU-ore/lună. Aici stau doar metadate, deci ajunge.
- **Pages Functions**: 100.000 de cereri/zi. Interfața reține lista de fișiere 20 de secunde, ca să nu consume degeaba.
- **Dimensiunea unei cereri**: maximum 100 MB. De aceea fișierele se încarcă în fragmente de 16 MB, iar limita rămâne 5 GB/fișier. Încărcările întrerupte se reiau de la fragmentul la care au rămas.

## Ce s-a schimbat față de pachetul vechi
- Parola de admin **nu mai e în cod sau README**. Sesiunea e un cookie semnat; cookie-ul vechi `admin_session=true` putea fi falsificat de oricine.
- Fișierele nu mai sunt stocate ca text base64 în baza de date, ci în R2.
- Lista de fișiere nu mai trimite conținutul tuturor fișierelor la fiecare încărcare de pagină.
- Fișierele neaprobate sunt vizibile doar pentru admin. Un vizitator poate doar propune, nu poate modifica elemente existente.
- Ștergerea unui folder șterge și conținutul lui (inclusiv din R2).
- Fișierele încărcate sunt servite cu antete care împiedică rularea de scripturi în site.
- „Tabele publice": oricine poate apăsa „propune modificare" (mic, sub titlu); propunerea nu schimbă nimic până nu o aprobă cineva autentificat, care vede diferențele evidențiate. Utilizatorii autentificați editează tabelul ca într-un Excel: linkuri în celule (albastre, subliniate), lățimea coloanelor și înălțimea rândurilor se trag cu mouse-ul, se poate lipi direct din Excel / Google Sheets.
- Funcții care lipseau: descărcare multiplă și ZIP, linkuri propuse/aprobate/reordonate, cititor PDF/DOCX/XLSX cu zoom, „Tabele publice".

Dacă ai rulat deja versiunea veche pe Neon, poți șterge tabelele ei: `DROP TABLE IF EXISTS drive_items, useful_links;`. Versiunea nouă folosește tabele `cd_*`.

## Test local (opțional)
```
cp .dev.vars.example .dev.vars     # completează valorile
npm run dev
```
R2 este simulat local; baza de date rămâne cea de pe Neon.

## Probleme frecvente
- **„Configurare incompletă: DATABASE_URL / SESSION_SECRET lipsește"**: lipsește un secret sau nu ai făcut redeploy după ce l-ai adăugat.
- **Build eșuat cu „Could not resolve …"**: lipsește un folder din repository (de obicei `vendor`). Verifică pe GitHub că `functions`, `public` și `vendor` sunt în rădăcină.
- **Build Workers eșuat cu „Missing entry-point" / cere `--assets`**: proiectul e de tip Workers; folosește comanda de mai sus cu `-c wrangler.workers.toml`.
- **„bucket-ul R2 (binding FILES) nu este conectat"**: bucket-ul nu există sau numele diferă de `bucket_name` din `wrangler.toml`.
- **„Sunt prea multe fișiere în așteptare"**: s-a atins limita pentru vizitatori. Aprobă sau respinge fișierele din coadă.
