# Quiz Drept — adaos pentru site-ul Drive (Cloudflare Pages + Neon)

Quiz-ul rulează pe **același site** ca Drive-ul, la adresa `https://SITE-UL-TAU.pages.dev/quiz/`.
Folosește aceeași bază de date Neon (tabele separate, `qz_*`) și aceleași secrete deja puse: `DATABASE_URL` și `SESSION_SECRET`.
Nu e nevoie de proiect nou, de R2 sau de Firebase.

## Ce conține
```
public/quiz/index.html   interfața ta, aceeași (cu fila nouă „Statistici")
public/quiz/app.js       logica de quiz (codul tău, fără Firebase și fără parole în cod)
functions/api/quiz.js    API-ul quiz-ului
functions/_lib/quiz.js   validări + parola de administrator
```
Fișierele comune (`util.js`, `auth.js`, `db.js`) există deja în proiectul Drive și nu se ating.

## Instalare
1. **Secretul pentru parola de administrator** (o singură dată): în Cloudflare, proiectul Pages, **Settings → Variables and Secrets → Add**, tip **Secret**, nume `QUIZ_ADMIN_PASSWORD`, valoarea = parola de administrator dorită.
2. **GitHub**: dezarhivează arhiva, apoi în repository **Add file → Upload files** și trage folderele `functions` și `public` (se adaugă la cele existente, nu șterge nimic). **Commit changes.**
3. Cloudflare publică singur în 1–2 minute (**Deployments**). Dacă ai adăugat secretul DUPĂ commit: **Deployments → ⋯ → Retry deployment**.
4. Deschide `/quiz/`, apasă **Admin**, autentifică-te, apoi **Setări → Parola de administrator → schimb-o** (parola din secret e doar cea de pornire).
5. **Import / Export → Încarcă JSON** și alege fișierul cu întrebări (cel exportat din vechiul quiz). Categoriile (materiile) apar singure din întrebări.

## Cum se folosește
- **Colegii** exersează, propun grile noi sau modificări (butonul „Propune"), votează propunerile.
- **Administratorul** aprobă/respinge propunerile, editează sau șterge întrebări (și în lot), importă fișiere, schimbă categoriile și parola.
- **Amestecare**: la fiecare sesiune ordinea întrebărilor și a variantelor este alta. La final: „Repetă greșitele" și „Reia sesiunea (amestecat)".
- **Statistici** (fila „Statistici"): sesiuni, acuratețe pe materii, cele mai greșite întrebări. Se păstrează doar în browserul fiecăruia, nu pe server.
- **Backup**: **Import / Export → Descarcă întrebările (JSON)** sau **Backup complet** (cu propuneri și categorii). Același fișier se poate reîncărca oricând; întrebările cu același id se actualizează, nu se dublează.

## Parola de administrator
- Nu apare în cod. La pornire se citește din secretul `QUIZ_ADMIN_PASSWORD`; după ce o schimbi din Setări, se păstrează în baza de date (cifrată cu `SESSION_SECRET`) și secretul nu mai contează.
- După schimbare, celelalte dispozitive conectate ca administrator sunt deconectate.
- **Ai uitat parola schimbată?** În Neon → SQL Editor rulează: `DELETE FROM qz_settings WHERE key = 'admin_hash';` Revine parola din secretul `QUIZ_ADMIN_PASSWORD`.

## Probleme frecvente
- **„Parola de administrator nu este configurată"**: lipsește secretul `QUIZ_ADMIN_PASSWORD` (sau nu ai făcut redeploy după ce l-ai adăugat).
- **„Configurare incompletă: DATABASE_URL / SESSION_SECRET"**: acestea sunt secretele de la Drive; verifică să existe în același proiect.
- **Pagina nu se actualizează**: apasă Ctrl+F5.
- **Apare „Offline (copie locală)"**: serverul nu răspunde; quiz-ul merge cu ultima copie salvată pe dispozitiv, dar modificările nu se pot salva până revine conexiunea.
