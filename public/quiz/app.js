// Quiz Drept — client (Cloudflare Pages + Neon).
// Interfața și logica de quiz sunt cele originale; aici s-au înlocuit serviciul vechi de date și parolele din cod
// cu API-ul /api/quiz și o sesiune de administrator (parola se schimbă din Setări, nu apare în cod).
'use strict';

const API_URL = '/api/quiz';
// Butoanele din meniu au ACEEAȘI dimensiune activ/inactiv (bordura există mereu, doar culoarea ei se schimbă).
const NAV_BASE = 'px-2.5 lg:px-3 py-1.5 rounded-lg text-sm font-medium border whitespace-nowrap transition-all';
const NAV_IDLE = NAV_BASE + ' border-transparent text-slate-300 hover:text-white hover:bg-slate-800';
const NAV_ACTIVE = NAV_BASE + ' bg-amber-500/10 text-amber-400 border-amber-500/30';
const CACHE_KEY = 'quiz_cache_v1';
const STATS_KEY = 'quiz_stats_v1';

window.questionsBank = [];
window.proposalsBank = [];
window.selectedQuestionIds = new Set();
window.isProposalModalMode = true;
window.isAdmin = false;
window.bankLimit = 50;
window.lastBankKey = '';
window.currentQuiz = { questions: [], currentIndex: 0, scoreCorrect: 0, scoreWrong: 0, userAnswers: {}, answered: false, log: [] };
let lastQuizConfig = null;
let lastLoadAt = 0;

// ---------- API ----------
async function api(action, payload = {}) {
    let res;
    try {
        res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ action, ...payload })
        });
    } catch (e) {
        const err = new Error('Nu mă pot conecta la server. Verifică conexiunea la internet.');
        err.status = 0;
        throw err;
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) {
        const err = new Error(`Răspuns neașteptat de la server (${res.status}).`);
        err.status = res.status;
        throw err;
    }
    if (!res.ok) {
        const err = new Error(data.error || `Eroare de server (${res.status}).`);
        err.status = res.status;
        throw err;
    }
    return data;
}

// ---------- autentificare administrator ----------
let loginResolver = null;

window.requireAdmin = function(message) {
    if (window.isAdmin) return Promise.resolve(true);
    return new Promise((resolve) => {
        if (loginResolver) loginResolver(false);
        loginResolver = resolve;
        document.getElementById('auth-prompt-message').textContent = message || 'Această acțiune este protejată. Introduceți parola de administrator.';
        document.getElementById('auth-password-input').value = '';
        document.getElementById('auth-prompt-modal').classList.remove('hidden');
        setTimeout(() => document.getElementById('auth-password-input')?.focus(), 50);
    });
};

window.closeAuthPrompt = function() {
    document.getElementById('auth-prompt-modal').classList.add('hidden');
    if (loginResolver) { loginResolver(false); loginResolver = null; }
};

window.submitAuthPrompt = async function(e) {
    e.preventDefault();
    const input = document.getElementById('auth-password-input');
    try {
        await api('signin', { password: input.value });
    } catch (err) {
        input.value = '';
        input.focus();
        showToast(err.message || 'Parolă incorectă!', 'error');
        return;
    }
    window.isAdmin = true;
    updateAdminUI();
    document.getElementById('auth-prompt-modal').classList.add('hidden');
    if (loginResolver) { const done = loginResolver; loginResolver = null; done(true); }
    showToast('Autentificat ca administrator.', 'success');
};

window.signOutAdmin = async function() {
    try { await api('signout'); } catch (e) { /* oricum ieșim local */ }
    window.isAdmin = false;
    updateAdminUI();
    closeSettings();
    showToast('Te-ai deconectat.', 'info');
};

window.adminButtonClick = async function() {
    if (window.isAdmin) {
        if (confirm('Te deconectezi din contul de administrator?')) await signOutAdmin();
    } else {
        await requireAdmin('Autentifică-te ca administrator pentru a edita baza de întrebări.');
    }
};

function updateAdminUI() {
    const btn = document.getElementById('btn-admin');
    const label = document.getElementById('btn-admin-label');
    if (!btn || !label) return;
    label.textContent = window.isAdmin ? 'Admin ✓' : 'Admin';
    btn.title = window.isAdmin ? 'Ești autentificat ca administrator (click pentru deconectare)' : 'Autentificare administrator';
    btn.className = window.isAdmin
        ? 'px-3 py-2 rounded-lg font-semibold text-sm hidden sm:flex items-center bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 transition-all'
        : 'px-3 py-2 rounded-lg font-semibold text-sm hidden sm:flex items-center bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-all';
}

// Rulează o acțiune de administrator: cere autentificarea dacă e nevoie și afișează erorile.
async function adminCall(message, action, payload) {
    if (!(await requireAdmin(message))) {
        showToast('Autentificare necesară pentru această acțiune.', 'error');
        return null;
    }
    try {
        return await api(action, payload);
    } catch (err) {
        if (err.status === 401) {
            window.isAdmin = false;
            updateAdminUI();
            showToast('Sesiunea a expirat. Autentifică-te din nou și reîncearcă.', 'warning');
        } else {
            showToast(err.message || 'Acțiunea nu a reușit.', 'error');
        }
        return null;
    }
}

window.changeAdminPassword = async function() {
    const current = document.getElementById('pw-current').value;
    const next = document.getElementById('pw-new').value;
    const again = document.getElementById('pw-new2').value;
    if (!current || !next) { showToast('Completează parola actuală și parola nouă.', 'warning'); return; }
    if (next.length < 8) { showToast('Parola nouă trebuie să aibă cel puțin 8 caractere.', 'warning'); return; }
    if (next !== again) { showToast('Cele două parole noi nu coincid.', 'warning'); return; }
    const res = await adminCall('', 'changePassword', { current, next });
    if (!res) return;
    ['pw-current', 'pw-new', 'pw-new2'].forEach(id => { document.getElementById(id).value = ''; });
    showToast('Parola a fost schimbată. Celelalte dispozitive vor trebui să se autentifice din nou.', 'success');
};

// ---------- utilitare ----------
function shuffleArray(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {              // Fisher–Yates: amestecare uniformă
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}


        const YEAR_OPTIONS = [1, 2, 3, 4, 5, 6];
        const DEFAULT_SUBJECT_CATEGORIES = [
            { code: "TGD",  label: "Teoria generală a dreptului", year: 1, semester: "ALL" },
            { code: "DCP",  label: "D. constituțional", year: 1, semester: "ALL" },
            { code: "IDC",  label: "D.C. introducere", year: 1, semester: "ALL" },
            { code: "DC",   label: "D.C. Persoanele", year: 1, semester: "ALL" },
            { code: "ISDR", label: "Istoria dreptului românesc", year: 1, semester: "ALL" }
        ];

        function normalizeCategoryConfig(config) {
            const result = [];
            const items = Array.isArray(config) ? config : (config && typeof config === 'object' ? Object.entries(config).map(([code, value]) => ({ code, ...(value || {}) })) : []);
            items.forEach(item => {
                if (!item || !item.code) return;
                const code = String(item.code).trim().toUpperCase().replace(/\s+/g, '_');
                if (!code) return;
                result.push({ code, label: String(item.label || item.name || code).trim(), year: Math.max(1, parseInt(item.year, 10) || 1), semester: ["1", "2", "ALL"].includes(String(item.semester)) ? String(item.semester) : "ALL" });
            });
            const seen = new Set();
            return result.filter(item => { if (!item.code || seen.has(item.code)) return false; seen.add(item.code); return true; });
        }

        function getDefaultCategories() {
            return DEFAULT_SUBJECT_CATEGORIES.map(item => ({ ...item }));
        }

        function serializeCategoryConfig(categories) {
            return categories.reduce((acc, item) => {
                acc[item.code] = { label: item.label, year: item.year, semester: item.semester };
                return acc;
            }, {});
        }

        window.subjectCategories = getDefaultCategories();

        function syncSubjectConfigMap() {
            window.subjectConfig = window.subjectCategories.reduce((acc, item) => {
                acc[item.code] = item.label;
                return acc;
            }, {});
        }
        syncSubjectConfigMap();

        function getSubjectLabel(subjectCode) {
            return window.subjectConfig?.[subjectCode] || subjectCode || "DREPT";
        }

        function getCategory(subjectCode) {
            return window.subjectCategories.find(item => item.code === subjectCode) || null;
        }

        function buildYearOptions(select, selectedValue, includeAll = false) {
            if (!select) return;
            const selected = String(selectedValue ?? (includeAll ? "ALL" : 1));
            const all = includeAll ? '<option value="ALL">Toți anii</option>' : '';
            select.innerHTML = all + YEAR_OPTIONS.map(year => `<option value="${year}">Anul ${year}</option>`).join('');
            select.value = [...select.options].some(o => o.value === selected) ? selected : (includeAll ? 'ALL' : '1');
        }

        function categoryMatchesFilters(category, year, semester) {
            if (!category) return false;
            const yearMatches = year === 'ALL' || String(category.year) === String(year);
            const semesterMatches = semester === 'ALL' || String(category.semester) === 'ALL' || String(category.semester) === String(semester);
            return yearMatches && semesterMatches;
        }

        function renderCategoryOptions(select, includeAll, year, semester, preferredValue) {
            if (!select) return;
            const previous = preferredValue ?? select.value;
            const available = window.subjectCategories.filter(category => categoryMatchesFilters(category, year, semester));
            const allOption = includeAll ? `<option value="ALL">${select.id === 'bank-subject-filter' ? 'Toate Materiile' : 'Toate Materiile (Mixat)'}</option>` : '';
            select.innerHTML = allOption + available.map(category => `<option value="${escapeHtml(category.code)}">${escapeHtml(category.code)} - ${escapeHtml(category.label)}</option>`).join('');

            if ([...select.options].some(o => o.value === previous)) {
                select.value = previous;
            } else if (includeAll) {
                select.value = 'ALL';
            } else if (available.length) {
                select.value = available[0].code;
            } else {
                select.value = '';
            }
        }

        function renderSubjectSelects() {
            buildYearOptions(document.getElementById('cfg-year'), document.getElementById('cfg-year')?.value || 1, false);
            buildYearOptions(document.getElementById('bank-year-filter'), document.getElementById('bank-year-filter')?.value || 'ALL', true);
            buildYearOptions(document.getElementById('form-q-year'), document.getElementById('form-q-year')?.value || 1, false);

            const cfgYear = document.getElementById('cfg-year')?.value || '1';
            const cfgSem = document.getElementById('cfg-semester')?.value || 'ALL';
            const bankYear = document.getElementById('bank-year-filter')?.value || 'ALL';
            const bankSem = document.getElementById('bank-sem-filter')?.value || 'ALL';
            const formYear = document.getElementById('form-q-year')?.value || '1';
            const formSem = document.getElementById('form-q-sem')?.value || '1';

            renderCategoryOptions(document.getElementById('cfg-subject'), true, cfgYear, cfgSem);
            renderCategoryOptions(document.getElementById('bank-subject-filter'), true, bankYear, bankSem);
            renderCategoryOptions(document.getElementById('form-q-subject'), false, formYear, formSem);
        }

        window.refreshCategorySelects = function() {
            renderSubjectSelects();
            renderQuestionsBank();
        };

        // Categoriile vin de la server (catalogul salvat + cele care apar în întrebări).
        function setSubjects(list) {
            const normalized = normalizeCategoryConfig(list);
            window.subjectCategories = normalized.length ? normalized : getDefaultCategories();
            syncSubjectConfigMap();
        }


        function renderSettingsSubjects() {
            const container = document.getElementById('settings-subjects-list');
            if (!container) return;
            buildYearOptions(document.getElementById('new-category-year'), document.getElementById('new-category-year')?.value || 1, false);

            if (!window.subjectCategories.length) {
                container.innerHTML = `<div class="bg-slate-950 border border-slate-800 rounded-xl p-6 text-center text-sm text-slate-500">Nu există categorii. Adaugă prima categorie mai jos.</div>`;
                return;
            }

            container.innerHTML = window.subjectCategories.map(category => `
                <div class="grid grid-cols-1 md:grid-cols-[120px_1fr_1fr_130px_150px_auto] gap-3 items-center bg-slate-950 border border-slate-800 rounded-xl p-3.5">
                    <div>
                        <span class="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Cod</span>
                        <input type="text" data-subject-code="${escapeHtml(category.code)}" value="${escapeHtml(category.code)}" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm font-bold uppercase text-amber-400 focus:ring-2 focus:ring-amber-500 outline-none" maxlength="30">
                    </div>
                    <div>
                        <span class="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Denumire / Label</span>
                        <input type="text" data-subject-label="${escapeHtml(category.code)}" value="${escapeHtml(category.label)}" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white focus:ring-2 focus:ring-amber-500 outline-none" maxlength="120">
                    </div>
                    <div>
                        <span class="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">An</span>
                        <select data-subject-year="${escapeHtml(category.code)}" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white focus:ring-2 focus:ring-amber-500 outline-none">
                            ${YEAR_OPTIONS.map(year => `<option value="${year}" ${String(category.year) === String(year) ? 'selected' : ''}>Anul ${year}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <span class="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Semestru</span>
                        <select data-subject-semester="${escapeHtml(category.code)}" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white focus:ring-2 focus:ring-amber-500 outline-none">
                            <option value="ALL" ${String(category.semester) === 'ALL' ? 'selected' : ''}>Ambele semestre</option>
                            <option value="1" ${String(category.semester) === '1' ? 'selected' : ''}>Semestrul 1</option>
                            <option value="2" ${String(category.semester) === '2' ? 'selected' : ''}>Semestrul 2</option>
                        </select>
                    </div>
                    <button type="button" onclick="deleteSubjectCategory('${escapeHtml(category.code)}')" class="p-2.5 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-all" title="Șterge categoria">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            `).join('');
        }



        // ---------- Setări (categorii + parola de administrator) ----------
        window.openSettings = async function() {
            if (!(await requireAdmin('Setările sunt protejate. Autentifică-te ca administrator:'))) return;
            renderSettingsSubjects();
            document.getElementById('settings-modal').classList.remove('hidden');
        };

        window.closeSettings = function() {
            document.getElementById("settings-modal").classList.add("hidden");
        };

        async function saveSubjectsToServer(renames = []) {
            const res = await adminCall('', 'saveSubjects', { subjects: window.subjectCategories, renames });
            if (res) await loadAll();
            return !!res;
        }

        window.addSubjectCategory = async function() {
            const codeInput = document.getElementById('new-category-code');
            const labelInput = document.getElementById('new-category-label');
            const yearInput = document.getElementById('new-category-year');
            const semesterInput = document.getElementById('new-category-semester');
            if (!codeInput || !labelInput || !yearInput || !semesterInput) return;

            const code = codeInput.value.trim().toUpperCase().replace(/\s+/g, '_');
            const label = labelInput.value.trim();
            const year = Math.max(1, parseInt(yearInput.value, 10) || 1);
            const semester = ['ALL', '1', '2'].includes(semesterInput.value) ? semesterInput.value : 'ALL';

            if (!code || !label) { showToast('Completează codul și denumirea categoriei!', 'warning'); return; }
            if (getCategory(code)) { showToast(`Categoria ${code} există deja.`, 'warning'); return; }

            window.subjectCategories = [...window.subjectCategories, { code, label, year, semester }];
            if (await saveSubjectsToServer()) {
                codeInput.value = '';
                labelInput.value = '';
                renderSettingsSubjects();
                showToast(`Categoria ${code} a fost adăugată.`, 'success');
            }
        };

        window.deleteSubjectCategory = async function(code) {
            const category = getCategory(code);
            if (!category) return;
            const used = window.questionsBank.filter(q => q.subject === code).length;
            const warn = used ? `\n\nAtenție: ${used} întrebări folosesc această categorie. Ele rămân în bază, iar categoria reapare cu denumirea egală cu codul.` : '';
            if (!confirm(`Ștergi categoria „${category.label}” (${code})?${warn}`)) return;
            window.subjectCategories = window.subjectCategories.filter(item => item.code !== code);
            if (await saveSubjectsToServer()) {
                renderSettingsSubjects();
                showToast(`Categoria ${code} a fost ștearsă.`, 'info');
            }
        };

        window.saveSubjectNames = async function() {
            const field = (attr, code) => [...document.querySelectorAll(`#settings-subjects-list [data-subject-${attr}]`)]
                .find(el => el.dataset['subject' + attr[0].toUpperCase() + attr.slice(1)] === code);
            const oldCategories = window.subjectCategories.map(category => ({ ...category }));
            const nextCategories = [];
            const usedCodes = new Set();

            for (const category of oldCategories) {
                const code = String(field('code', category.code)?.value ?? category.code).trim().toUpperCase().replace(/\s+/g, '_');
                const label = String(field('label', category.code)?.value ?? category.label).trim();
                const year = Math.max(1, parseInt(field('year', category.code)?.value, 10) || category.year || 1);
                const semValue = field('semester', category.code)?.value;
                const semester = ['ALL', '1', '2'].includes(semValue) ? semValue : category.semester;

                if (!code || !label) { showToast('Codul și denumirea tuturor categoriilor trebuie completate.', 'warning'); return; }
                if (usedCodes.has(code)) { showToast(`Codul ${code} este folosit de mai multe categorii.`, 'warning'); return; }
                usedCodes.add(code);
                nextCategories.push({ code, label, year, semester });
            }

            const renames = [];
            oldCategories.forEach((old, i) => {
                if (old.code !== nextCategories[i].code) renames.push({ from: old.code, to: nextCategories[i].code });
            });
            window.subjectCategories = nextCategories;
            if (await saveSubjectsToServer(renames)) {
                closeSettings();
                showToast('Catalogul categoriilor a fost salvat.', 'success');
            }
        };

        window.resetSubjectNames = async function() {
            if (!confirm('Revii la catalogul inițial?')) return;
            window.subjectCategories = getDefaultCategories();
            if (await saveSubjectsToServer()) {
                renderSettingsSubjects();
                showToast("Catalogul inițial a fost restaurat.", "success");
            }
        };



        // ---------- Încărcarea datelor ----------
        function readCache() {
            try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; }
        }
        function writeCache(data) {
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), questions: data.questions, subjects: data.subjects }));
            } catch (e) { /* bancă prea mare pentru memoria browserului: continuăm fără copie locală */ }
        }

        // O singură cerere aduce întrebările, propunerile, categoriile și starea de administrator.
        async function loadAll() {
            lastLoadAt = Date.now();
            try {
                const data = await api('bootstrap');
                window.questionsBank = data.questions;
                window.proposalsBank = data.proposals;
                setSubjects(data.subjects);
                window.isAdmin = !!data.isAdmin;
                writeCache(data);
                updateStatus(true, 'Conectat');
            } catch (err) {
                console.error('Încărcare eșuată:', err);
                const cached = readCache();
                if (cached && !window.questionsBank.length) {
                    window.questionsBank = cached.questions || [];
                    setSubjects(cached.subjects);
                    updateStatus(false, 'Offline (copie locală)');
                    showToast('Nu mă pot conecta la server. Folosesc ultima copie salvată pe acest dispozitiv.', 'warning');
                } else if (!cached) {
                    updateStatus(false, 'Offline');
                    showToast(err.message || 'Nu mă pot conecta la server.', 'error');
                } else {
                    updateStatus(false, 'Offline (copie locală)');
                }
            }
            renderSubjectSelects();
            updateAdminUI();
            updateUIState();
            updateProposalsUI();
        }

        // Reîmprospătare când te întorci pe pagină după mult timp (fără interogări în fundal).
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && Date.now() - lastLoadAt > 5 * 60 * 1000) loadAll();
        });

        function updateStatus(online, text) {
            const dot = document.getElementById('status-dot');
            const txt = document.getElementById('status-text');
            if (dot && txt) {
                txt.textContent = text;
                dot.className = online ? "w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse mr-2" : "w-2.5 h-2.5 rounded-full bg-amber-400 mr-2";
            }
        }

        function updateUIState() {
            const totalBadge = document.getElementById('total-q-badge');
            if (totalBadge) totalBadge.textContent = window.questionsBank.length;
            renderQuestionsBank();
        }

        function updateProposalsUI() {
            const badge = document.getElementById('total-p-badge');
            if (badge) badge.textContent = window.proposalsBank.length;
            renderProposalsList();
        }

        window.deleteQuestion = async function(qId) {
            if (!(await requireAdmin("Ștergerea întrebării este protejată. Introduceți parola de administrator:"))) {
                showToast("Autentificare necesară. Întrebarea NU a fost ștearsă.", "error");
                return;
            }
            if (!confirm("Sigur doriți să ștergeți această întrebare?")) return;
            const res = await adminCall('', 'deleteQuestions', { ids: [qId] });
            if (!res) return;
            window.selectedQuestionIds.delete(qId);
            await loadAll();
            showToast("Întrebarea a fost ștearsă.", "info");
        };

        window.bulkDeleteQuestions = async function() {
            const count = window.selectedQuestionIds.size;
            if (count === 0) return;
            if (!(await requireAdmin(`Ștergerea a ${count} întrebări este protejată. Introduceți parola de administrator:`))) {
                showToast("Autentificare necesară. Întrebările NU au fost șterse.", "error");
                return;
            }
            if (!confirm(`Sigur doriți să ștergeți ${count} întrebări selectate deodată?`)) return;
            const ids = Array.from(window.selectedQuestionIds);
            const res = await adminCall('', 'deleteQuestions', { ids });
            if (!res) return;
            window.selectedQuestionIds.clear();
            await loadAll();
            showToast(`Au fost șterse ${res.removed} întrebări!`, "success");
        };


        window.toggleSelectQuestion = function(qId, isChecked) {
            if (isChecked) {
                window.selectedQuestionIds.add(qId);
            } else {
                window.selectedQuestionIds.delete(qId);
            }
            updateBulkSelectionUI();
        };

        window.toggleSelectAllQuestions = function(isChecked) {
            const filtered = getFilteredQuestions();
            if (isChecked) {
                filtered.forEach(q => window.selectedQuestionIds.add(q.id));
            } else {
                filtered.forEach(q => window.selectedQuestionIds.delete(q.id));
            }
            renderQuestionsBank();
        };

        function updateBulkSelectionUI() {
            const count = window.selectedQuestionIds.size;
            const badge = document.getElementById('selected-count-badge');
            const deleteBtn = document.getElementById('btn-bulk-delete');
            const countSpan = document.getElementById('bulk-delete-count');
            const selectAllBox = document.getElementById('select-all-q-checkbox');

            if (badge) {
                if (count > 0) {
                    badge.classList.remove('hidden');
                    badge.textContent = `${count} selectate`;
                } else {
                    badge.classList.add('hidden');
                }
            }

            if (deleteBtn && countSpan) {
                countSpan.textContent = count;
                deleteBtn.disabled = count === 0;
            }

            const filtered = getFilteredQuestions();
            if (selectAllBox && filtered.length > 0) {
                selectAllBox.checked = filtered.every(q => window.selectedQuestionIds.has(q.id));
            }
        }



        // ---------- Import / Export ----------
        window.triggerImportJSON = async function() {
            if (!(await requireAdmin("Importul fișierelor JSON este protejat. Introduceți parola de administrator:"))) {
                showToast("Autentificare necesară pentru import.", "error");
                return;
            }
            document.getElementById('import-json-input').click();
        };

        function downloadJSON(data, name) {
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        }
        const today = () => new Date().toISOString().slice(0, 10);

        // Lista de întrebări, în același format ca fișierul tău (se poate importa înapoi).
        window.exportJSON = function() {
            downloadJSON(window.questionsBank, `quiz_drept_intrebari_${today()}.json`);
            showToast("Fișierul JSON a fost descărcat cu succes!", "success");
        };

        // Backup complet: întrebări + propuneri + categorii.
        window.exportFullBackup = function() {
            downloadJSON({
                format: 'quiz-backup-v1',
                exportedAt: new Date().toISOString(),
                subjects: window.subjectCategories,
                questions: window.questionsBank,
                proposals: window.proposalsBank
            }, `quiz_drept_backup_complet_${today()}.json`);
            showToast("Backup-ul complet a fost descărcat.", "success");
        };

        window.importJSON = function(event) {
            const file = event.target.files[0];
            event.target.value = '';
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async function(e) {
                let payload;
                try {
                    const parsed = JSON.parse(e.target.result);
                    if (Array.isArray(parsed)) payload = { questions: parsed };
                    else if (parsed && Array.isArray(parsed.questions)) payload = { questions: parsed.questions, proposals: parsed.proposals, subjects: parsed.subjects };
                    else throw new Error("Format invalid.");
                } catch (err) {
                    showToast("Eroare la citirea fișierului JSON. Asigurați-vă că formatul este corect.", "error");
                    return;
                }
                const res = await adminCall('', 'importData', payload);
                if (!res) return;
                await loadAll();
                const extra = [];
                if (res.updated) extra.push(`${res.updated} actualizate`);
                if (res.skipped) extra.push(`${res.skipped} sărite (invalide)`);
                if (res.proposals) extra.push(`${res.proposals} propuneri`);
                showToast(`Import reușit: ${res.added} întrebări noi${extra.length ? ', ' + extra.join(', ') : ''}.`, res.skipped ? 'warning' : 'success');
            };
            reader.readAsText(file);
        };



        window.showToast = function(msg, type = "info") {
            const container = document.getElementById('toast-container');
            if (!container) return;
            const toast = document.createElement('div');

            let bgClass = "bg-slate-800 text-slate-100 border-slate-700";
            if (type === "success") bgClass = "bg-emerald-900 border-emerald-700 text-emerald-200";
            if (type === "warning") bgClass = "bg-amber-900 border-amber-700 text-amber-200";
            if (type === "error") bgClass = "bg-red-900 border-red-700 text-red-200 shadow-2xl ring-2 ring-red-500/50";

            toast.className = `p-4 rounded-xl border shadow-xl text-xs sm:text-sm font-medium flex items-center justify-between gap-3 transform transition-all duration-300 translate-x-10 opacity-0 ${bgClass}`;
            const body = document.createElement('div');
            body.className = 'flex items-center gap-2';
            if (type === 'error') {
                const icon = document.createElement('i');
                icon.className = 'fa-solid fa-triangle-exclamation text-red-400 text-base';
                body.appendChild(icon);
            }
            const span = document.createElement('span');
            span.textContent = msg;               // text simplu: nimic din mesaj nu e interpretat ca HTML
            body.appendChild(span);
            const close = document.createElement('button');
            close.className = 'text-slate-400 hover:text-white p-1';
            close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            close.onclick = () => toast.remove();
            toast.append(body, close);
            container.appendChild(toast);

            setTimeout(() => toast.classList.remove('translate-x-10', 'opacity-0'), 10);
            setTimeout(() => {
                toast.classList.add('opacity-0');
                setTimeout(() => toast.remove(), 300);
            }, 5000);
        };

        window.switchTab = function(tabName) {
            const tabs = ['quiz-setup', 'quiz-active', 'quiz-results', 'questions-bank', 'proposals', 'backup', 'stats'];
            tabs.forEach(t => {
                const el = document.getElementById(`tab-${t}`);
                if (el) el.classList.add('hidden');
                const navBtn = document.getElementById(`nav-${t}`);
                if (navBtn) {
                    navBtn.className = NAV_IDLE;
                }
            });

            const activeEl = document.getElementById(`tab-${tabName}`);
            if (activeEl) activeEl.classList.remove('hidden');

            const activeNavBtn = document.getElementById(`nav-${tabName}`);
            if (activeNavBtn) {
                activeNavBtn.className = NAV_ACTIVE;
                if (activeNavBtn.scrollIntoView) activeNavBtn.scrollIntoView({ inline: 'nearest', block: 'nearest' });
            }

            if (tabName === 'questions-bank') renderQuestionsBank();
            if (tabName === 'proposals') renderProposalsList();
            if (tabName === 'stats') renderStats();
            window.scrollTo({ top: 0 });
        };



        // ---------- Sesiunea de quiz ----------
        // Pregătește o sesiune: amestecă întrebările și ordinea variantelor (altfel de fiecare dată).
        function beginQuiz(pool, cfg) {
            let list = cfg.shuffleQ ? shuffleArray(pool) : [...pool];
            if (cfg.count && cfg.count !== 'ALL') list = list.slice(0, parseInt(cfg.count, 10));

            const prepared = list.map(q => {
                let opts = q.options.map((opt, idx) => ({ ...opt, originalIdx: idx }));
                if (cfg.shuffleO) opts = shuffleArray(opts);
                return { ...q, preparedOptions: opts };
            });

            window.currentQuiz = {
                questions: prepared, currentIndex: 0, scoreCorrect: 0, scoreWrong: 0,
                userAnswers: {}, answered: false, log: [], cfg
            };
            switchTab('quiz-active');
            renderCurrentQuestion();
        }

        function readQuizConfig() {
            return {
                subject: document.getElementById('cfg-subject').value,
                year: document.getElementById('cfg-year').value,
                semester: document.getElementById('cfg-semester').value,
                count: document.getElementById('cfg-count').value,
                shuffleQ: document.getElementById('cfg-shuffle-questions').checked,
                shuffleO: document.getElementById('cfg-shuffle-options').checked
            };
        }

        function poolFor(cfg) {
            let pool = [...window.questionsBank];
            if (cfg.subject !== 'ALL') pool = pool.filter(q => q.subject === cfg.subject);
            pool = pool.filter(q => String(q.year || 1) === String(cfg.year));
            if (cfg.semester !== 'ALL') pool = pool.filter(q => String(q.semester) === String(cfg.semester));
            return pool;
        }

        window.startQuiz = function() {
            const cfg = readQuizConfig();
            const pool = poolFor(cfg);
            if (pool.length === 0) {
                showToast("Nu există întrebări disponibile pentru filtrele selectate!", "warning");
                return;
            }
            lastQuizConfig = cfg;
            beginQuiz(pool, cfg);
        };

        // Aceeași configurare, amestecată din nou (întrebări și variante în altă ordine).
        window.restartSession = function() {
            const cfg = lastQuizConfig;
            const pool = cfg ? poolFor(cfg) : [];
            if (!pool.length) { switchTab('quiz-setup'); return; }
            beginQuiz(pool, cfg);
        };

        // Doar întrebările la care s-a greșit în sesiunea tocmai terminată.
        window.repeatMissed = function() {
            const quiz = window.currentQuiz;
            const missedIds = new Set(quiz.log.filter(x => !x.correct).map(x => x.id));
            const pool = quiz.questions.filter(q => missedIds.has(q.id));
            if (!pool.length) return;
            beginQuiz(pool, { ...(quiz.cfg || {}), subject: quiz.cfg?.subject || 'ALL', count: 'ALL', shuffleQ: true, shuffleO: true });
        };

        // ---------- Statistici (pe acest dispozitiv) ----------
        function loadStats() {
            try {
                const s = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
                if (s && s.v === 1) return s;
            } catch (e) { /* statistici corupte: pornim de la zero */ }
            return { v: 1, sessions: [], questions: {}, subjects: {} };
        }
        function saveStats(s) {
            try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (e) { /* memorie plină */ }
        }
        function recordSession(quiz) {
            if (!quiz.log.length) return;
            const s = loadStats();
            const now = Date.now();
            s.sessions.push({ t: now, total: quiz.log.length, correct: quiz.log.filter(x => x.correct).length, subject: quiz.cfg?.subject || 'ALL' });
            if (s.sessions.length > 200) s.sessions = s.sessions.slice(-200);
            for (const x of quiz.log) {
                const e = s.questions[x.id] || { s: 0, w: 0 };
                e.s++; if (!x.correct) e.w++;
                e.t = now;
                s.questions[x.id] = e;
                const sub = s.subjects[x.subject] || { s: 0, c: 0 };
                sub.s++; if (x.correct) sub.c++;
                s.subjects[x.subject] = sub;
            }
            saveStats(s);
        }

        const pctOf = (a, b) => (b ? Math.round((a / b) * 100) : 0);

        window.renderStats = function() {
            const box = document.getElementById('stats-content');
            if (!box) return;
            const s = loadStats();
            const answered = s.sessions.reduce((n, x) => n + x.total, 0);
            const correct = s.sessions.reduce((n, x) => n + x.correct, 0);

            if (!s.sessions.length) {
                box.innerHTML = `<div class="bg-slate-950 border border-slate-800 rounded-2xl p-8 text-center text-slate-400 text-sm">
                    <i class="fa-solid fa-chart-column text-3xl text-slate-600 mb-2"></i>
                    <p>Nu ai încă nicio sesiune terminată. Termină o sesiune de exersare și statisticile apar aici.</p></div>`;
                return;
            }

            const subjectRows = Object.entries(s.subjects)
                .map(([code, v]) => ({ code, ...v, pct: pctOf(v.c, v.s) }))
                .sort((a, b) => a.pct - b.pct)
                .map(v => `
                    <div class="space-y-1">
                        <div class="flex justify-between text-xs text-slate-300 gap-3">
                            <span class="truncate">${escapeHtml(getSubjectLabel(v.code))}</span>
                            <span class="shrink-0 font-semibold ${v.pct >= 70 ? 'text-emerald-400' : v.pct >= 50 ? 'text-amber-400' : 'text-red-400'}">${v.c}/${v.s} · ${v.pct}%</span>
                        </div>
                        <div class="h-2 rounded-full bg-slate-800 overflow-hidden"><div class="h-full ${v.pct >= 70 ? 'bg-emerald-500' : v.pct >= 50 ? 'bg-amber-500' : 'bg-red-500'}" style="width:${v.pct}%"></div></div>
                    </div>`).join('');

            const hardest = Object.entries(s.questions)
                .filter(([id, v]) => v.w > 0 && window.questionsBank.some(q => q.id === id))
                .sort((a, b) => (b[1].w / b[1].s) - (a[1].w / a[1].s) || b[1].w - a[1].w)
                .slice(0, 10);
            const allMissed = Object.entries(s.questions).filter(([id, v]) => v.w > 0 && window.questionsBank.some(q => q.id === id)).length;
            const hardestRows = hardest.map(([id, v]) => {
                const q = window.questionsBank.find(item => item.id === id);
                const text = q.text.length > 170 ? q.text.slice(0, 170) + '…' : q.text;
                return `<li class="bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-300 space-y-1">
                    <div class="break-words">${escapeHtml(text)}</div>
                    <div class="text-red-400 font-semibold">greșită de ${v.w} din ${v.s} ori</div></li>`;
            }).join('');

            const recent = [...s.sessions].reverse().slice(0, 8).map(x => `
                <li class="flex justify-between gap-3 text-xs text-slate-300 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2">
                    <span class="truncate">${new Date(x.t).toLocaleString('ro-RO', { dateStyle: 'medium', timeStyle: 'short' })} · ${x.subject === 'ALL' ? 'Toate materiile' : escapeHtml(getSubjectLabel(x.subject))}</span>
                    <span class="shrink-0 font-semibold text-amber-300">${x.correct}/${x.total} · ${pctOf(x.correct, x.total)}%</span>
                </li>`).join('');

            box.innerHTML = `
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div class="bg-slate-950 border border-slate-800 rounded-2xl p-4 text-center"><span class="text-xs text-slate-500 uppercase tracking-wider font-semibold">Sesiuni</span><p class="text-3xl font-black text-white">${s.sessions.length}</p></div>
                    <div class="bg-slate-950 border border-slate-800 rounded-2xl p-4 text-center"><span class="text-xs text-slate-500 uppercase tracking-wider font-semibold">Întrebări rezolvate</span><p class="text-3xl font-black text-amber-400">${answered}</p></div>
                    <div class="bg-slate-950 border border-slate-800 rounded-2xl p-4 text-center"><span class="text-xs text-slate-500 uppercase tracking-wider font-semibold">Acuratețe</span><p class="text-3xl font-black text-emerald-400">${pctOf(correct, answered)}%</p></div>
                </div>
                <div class="space-y-3"><h3 class="font-bold text-white text-sm flex items-center gap-2"><i class="fa-solid fa-layer-group text-amber-400"></i> Pe materii (de la cele mai slabe)</h3>${subjectRows}</div>
                ${hardestRows ? `<div class="space-y-3">
                    <div class="flex flex-wrap items-center justify-between gap-3"><h3 class="font-bold text-white text-sm flex items-center gap-2"><i class="fa-solid fa-circle-xmark text-red-400"></i> Cele mai greșite întrebări</h3>
                    <button onclick="practiceMissedFromStats()" class="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-xl text-xs transition-all"><i class="fa-solid fa-rotate-right mr-1.5"></i> Exersează toate greșitele (${allMissed})</button></div>
                    <ul class="space-y-2">${hardestRows}</ul></div>` : ''}
                <div class="space-y-3"><h3 class="font-bold text-white text-sm flex items-center gap-2"><i class="fa-solid fa-clock-rotate-left text-amber-400"></i> Ultimele sesiuni</h3><ul class="space-y-2">${recent}</ul></div>`;
        };

        window.practiceMissedFromStats = function() {
            const s = loadStats();
            const pool = window.questionsBank.filter(q => s.questions[q.id]?.w > 0);
            if (!pool.length) { showToast('Nu ai întrebări greșite de repetat.', 'info'); return; }
            const cfg = { subject: 'ALL', year: 'ALL', semester: 'ALL', count: 'ALL', shuffleQ: true, shuffleO: true };
            lastQuizConfig = null;
            beginQuiz(pool, cfg);
        };

        window.resetStats = function() {
            if (!confirm('Ștergi toate statisticile de pe acest dispozitiv?')) return;
            try { localStorage.removeItem(STATS_KEY); } catch (e) { /* ignorat */ }
            renderStats();
            showToast('Statisticile au fost șterse.', 'info');
        };


        window.renderCurrentQuestion = function() {
            const quiz = window.currentQuiz;
            const q = quiz.questions[quiz.currentIndex];
            if (!q) return;

            quiz.answered = false;
            quiz.userAnswers = {};

            document.getElementById('quiz-subject-badge').textContent = getSubjectLabel(q.subject);
            document.getElementById('quiz-sem-badge').textContent = `SEM ${q.semester || 1}`;
            document.getElementById('quiz-counter').textContent = `Întrebarea ${quiz.currentIndex + 1} din ${quiz.questions.length}`;
            
            document.getElementById('quiz-progress-fill').style.width = `${((quiz.currentIndex + 1) / quiz.questions.length) * 100}%`;
            document.getElementById('quiz-score-correct').textContent = quiz.scoreCorrect;
            document.getElementById('quiz-score-wrong').textContent = quiz.scoreWrong;
            document.getElementById('quiz-question-text').textContent = q.text;

            const correctCount = q.options.filter(o => o.correct).length;
            const multiBadge = document.getElementById('badge-multi-correct');
            if (correctCount > 1) multiBadge.classList.remove('hidden');
            else multiBadge.classList.add('hidden');

            document.getElementById('quiz-explanation-box').classList.add('hidden');

            const container = document.getElementById('quiz-options-container');
            container.innerHTML = '';
            const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F'];

            q.preparedOptions.forEach((opt, idx) => {
                const letter = optionLetters[idx] || (idx + 1);
                const optBtn = document.createElement('div');
                optBtn.id = `opt-btn-${idx}`;
                optBtn.onclick = () => toggleOptionSelection(idx);
                optBtn.className = "p-4 rounded-xl border border-slate-800 bg-slate-950/70 hover:bg-slate-800/80 cursor-pointer transition-all flex items-start gap-3.5 group select-none";

                optBtn.innerHTML = `
                    <div id="opt-box-${idx}" class="w-6 h-6 rounded-lg border border-slate-600 bg-slate-900 flex items-center justify-center text-xs font-bold text-slate-400 group-hover:border-amber-400 transition-all shrink-0 mt-0.5">
                        ${letter}
                    </div>
                    <div class="flex-1 text-sm text-slate-200 leading-snug font-medium pt-0.5 break-words">${escapeHtml(opt.text)}</div>
                    <div id="opt-status-icon-${idx}" class="shrink-0 text-lg hidden"></div>
                `;
                container.appendChild(optBtn);
            });

            document.getElementById('btn-submit-answer').classList.remove('hidden');
            document.getElementById('btn-next-question').classList.add('hidden');
        };

        window.toggleOptionSelection = function(index) {
            if (window.currentQuiz.answered) return;
            const quiz = window.currentQuiz;
            quiz.userAnswers[index] = !quiz.userAnswers[index];

            const optBtn = document.getElementById(`opt-btn-${index}`);
            const optBox = document.getElementById(`opt-box-${index}`);

            if (quiz.userAnswers[index]) {
                optBtn.className = "p-4 rounded-xl border-2 border-amber-500 bg-amber-500/10 cursor-pointer transition-all flex items-start gap-3.5 group select-none shadow-md";
                optBox.className = "w-6 h-6 rounded-lg bg-amber-500 text-slate-950 font-bold flex items-center justify-center text-xs shrink-0 mt-0.5";
            } else {
                optBtn.className = "p-4 rounded-xl border border-slate-800 bg-slate-950/70 hover:bg-slate-800/80 cursor-pointer transition-all flex items-start gap-3.5 group select-none";
                optBox.className = "w-6 h-6 rounded-lg border border-slate-600 bg-slate-900 flex items-center justify-center text-xs font-bold text-slate-400 group-hover:border-amber-400 transition-all shrink-0 mt-0.5";
            }
        };


        window.submitCurrentAnswer = function() {
            const quiz = window.currentQuiz;
            if (quiz.answered) return;

            const selectedIndices = Object.keys(quiz.userAnswers).filter(k => quiz.userAnswers[k]);
            if (selectedIndices.length === 0) {
                showToast("Bifați cel puțin o opțiune de răspuns pentru a valida!", "warning");
                return;
            }

            quiz.answered = true;
            const q = quiz.questions[quiz.currentIndex];
            let isFullyCorrect = true;

            q.preparedOptions.forEach((opt, idx) => {
                const userChecked = !!quiz.userAnswers[idx];
                const optBtn = document.getElementById(`opt-btn-${idx}`);
                const optBox = document.getElementById(`opt-box-${idx}`);
                const optIcon = document.getElementById(`opt-status-icon-${idx}`);
                optIcon.classList.remove('hidden');

                if (opt.correct) {
                    if (userChecked) {
                        optBtn.className = "p-4 rounded-xl border-2 border-emerald-500 bg-emerald-500/15 flex items-start gap-3.5 transition-all";
                        optBox.className = "w-6 h-6 rounded-lg bg-emerald-500 text-slate-950 font-bold flex items-center justify-center text-xs shrink-0 mt-0.5";
                        optIcon.innerHTML = `<i class="fa-solid fa-circle-check text-emerald-400"></i>`;
                    } else {
                        isFullyCorrect = false;
                        optBtn.className = "p-4 rounded-xl border-2 border-amber-500/60 bg-amber-500/10 flex items-start gap-3.5 transition-all";
                        optIcon.innerHTML = `<i class="fa-solid fa-triangle-exclamation text-amber-400"></i>`;
                    }
                } else {
                    if (userChecked) {
                        isFullyCorrect = false;
                        optBtn.className = "p-4 rounded-xl border-2 border-red-500 bg-red-500/15 flex items-start gap-3.5 transition-all";
                        optBox.className = "w-6 h-6 rounded-lg bg-red-500 text-white font-bold flex items-center justify-center text-xs shrink-0 mt-0.5";
                        optIcon.innerHTML = `<i class="fa-solid fa-circle-xmark text-red-400"></i>`;
                    } else {
                        optBtn.className = "p-4 rounded-xl border border-slate-800/50 bg-slate-950/30 opacity-60 flex items-start gap-3.5";
                    }
                }
            });

            if (isFullyCorrect) quiz.scoreCorrect++;
            else quiz.scoreWrong++;
            quiz.log.push({ id: q.id, subject: q.subject, correct: isFullyCorrect });

            document.getElementById('quiz-score-correct').textContent = quiz.scoreCorrect;
            document.getElementById('quiz-score-wrong').textContent = quiz.scoreWrong;

            const expBox = document.getElementById('quiz-explanation-box');
            const expText = document.getElementById('quiz-explanation-text');
            if (q.explanation && q.explanation.trim() !== '') {
                expText.textContent = q.explanation;
                expBox.classList.remove('hidden');
            }

            document.getElementById('btn-submit-answer').classList.add('hidden');
            document.getElementById('btn-next-question').classList.remove('hidden');
        };


        window.nextQuestion = function() {
            const quiz = window.currentQuiz;
            quiz.currentIndex++;
            if (quiz.currentIndex < quiz.questions.length) {
                renderCurrentQuestion();
            } else {
                finishQuiz();
            }
        };

        window.confirmExitQuiz = function() {
            if (confirm("Sigur doriți să părăsiți sesiunea de quiz curentă?")) {
                switchTab('quiz-setup');
            }
        };


        window.finishQuiz = function() {
            const quiz = window.currentQuiz;
            const total = quiz.questions.length;
            const pct = total > 0 ? Math.round((quiz.scoreCorrect / total) * 100) : 0;
            const grade = (1 + (pct / 100) * 9).toFixed(2);

            document.getElementById('res-score-percent').textContent = `${pct}%`;
            document.getElementById('res-correct-count').textContent = `${quiz.scoreCorrect} / ${total}`;
            document.getElementById('res-grade').textContent = grade;

            let feedback = "Continuați să exersați pentru a vă aprofunda cunoștințele juridice!";
            if (pct >= 90) feedback = "Excelente cunoștințe juridice!";
            else if (pct >= 70) feedback = "Rezultat foarte bun!";
            document.getElementById('res-feedback-text').textContent = feedback;

            recordSession(quiz);

            // întrebările greșite, cu răspunsurile corecte și explicațiile lor
            const missed = quiz.log.filter(x => !x.correct).map(x => quiz.questions.find(q => q.id === x.id)).filter(Boolean);
            const wrap = document.getElementById('res-missed-wrap');
            document.getElementById('res-missed-count').textContent = missed.length;
            document.getElementById('res-missed-list').innerHTML = missed.map(q => `
                <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2 text-sm">
                    <p class="text-white font-medium break-words">${escapeHtml(q.text)}</p>
                    <div class="space-y-1">${q.options.filter(o => o.correct).map(o => `<div class="text-xs text-emerald-400 flex items-start gap-2 break-words"><i class="fa-solid fa-square-check mt-0.5 shrink-0"></i><span>${escapeHtml(o.text)}</span></div>`).join('')}</div>
                    ${q.explanation ? `<div class="text-xs text-slate-400 italic break-words"><strong class="text-amber-400 not-italic">Explicație:</strong> ${escapeHtml(q.explanation)}</div>` : ''}
                </div>`).join('');
            wrap.classList.toggle('hidden', missed.length === 0);
            document.getElementById('btn-repeat-missed').classList.toggle('hidden', missed.length === 0);
            document.getElementById('btn-restart-session').classList.toggle('hidden', !lastQuizConfig);

            switchTab('quiz-results');
        };


        function getFilteredQuestions() {
            const searchVal = (document.getElementById('bank-search')?.value || '').toLowerCase();
            const subjectVal = document.getElementById('bank-subject-filter')?.value || 'ALL';
            const yearVal = document.getElementById('bank-year-filter')?.value || 'ALL';
            const semVal = document.getElementById('bank-sem-filter')?.value || 'ALL';

            return window.questionsBank.filter(q => {
                const matchesSearch = q.text.toLowerCase().includes(searchVal) || (q.explanation && q.explanation.toLowerCase().includes(searchVal));
                const matchesSubject = subjectVal === 'ALL' || q.subject === subjectVal;
                const matchesYear = yearVal === 'ALL' || String(q.year || 1) === String(yearVal);
                const matchesSem = semVal === 'ALL' || String(q.semester) === String(semVal);
                return matchesSearch && matchesSubject && matchesYear && matchesSem;
            });
        }


        window.renderQuestionsBank = function() {
            const container = document.getElementById('questions-list-container');
            if (!container) return;

            const filtered = getFilteredQuestions();
            updateBulkSelectionUI();
            // paginare: afișăm câte 50 odată (bancă mare = pagină rapidă)
            const bankKey = ['bank-search', 'bank-subject-filter', 'bank-year-filter', 'bank-sem-filter']
                .map(id => document.getElementById(id)?.value || '').join('|');
            if (bankKey !== window.lastBankKey) { window.lastBankKey = bankKey; window.bankLimit = 50; }
            const shown = filtered.slice(0, window.bankLimit);

            if (filtered.length === 0) {
                container.innerHTML = `
                    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center text-slate-400">
                        <i class="fa-solid fa-folder-open text-3xl text-slate-600 mb-2"></i>
                        <p>Nu s-au găsit întrebări conform filtrelor selectate.</p>
                    </div>
                `;
                return;
            }

            container.innerHTML = shown.map(q => {
                const correctCount = q.options.filter(o => o.correct).length;
                const isSelected = window.selectedQuestionIds.has(q.id);

                return `
                    <div class="bg-slate-900 border ${isSelected ? 'border-amber-500' : 'border-slate-800'} rounded-2xl p-4 sm:p-5 space-y-4 hover:border-slate-700 transition-all shadow-md overflow-hidden">
                        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                            <div class="flex items-center gap-2 flex-wrap">
                                <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleSelectQuestion('${q.id}', this.checked)" class="w-4 h-4 rounded border-slate-700 text-amber-500 focus:ring-amber-500 accent-amber-500 cursor-pointer">
                                <span class="px-2.5 py-1 rounded-md text-xs font-bold uppercase bg-amber-500/20 text-amber-300 border border-amber-500/30">${escapeHtml(getSubjectLabel(q.subject))}</span>
                                <span class="px-2.5 py-1 rounded-md text-xs font-bold bg-slate-800 text-slate-300">Anul ${q.year || 1}</span>
                                <span class="px-2.5 py-1 rounded-md text-xs font-bold bg-slate-800 text-slate-300">Semestrul ${q.semester || 1}</span>
                                ${correctCount > 1 ? '<span class="px-2 py-0.5 rounded text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20 font-semibold"><i class="fa-solid fa-bolt mr-1"></i> Multi</span>' : ''}
                            </div>
                            <div class="flex items-center space-x-1.5 w-full sm:w-auto justify-end flex-wrap gap-y-1">
                                <button onclick="proposeEditQuestionModal('${q.id}')" class="px-2.5 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-lg border border-slate-700 transition-colors flex items-center gap-1" title="Propune o modificare">
                                    <i class="fa-solid fa-lightbulb"></i> <span class="hidden sm:inline">Propune</span>
                                </button>
                                <button onclick="editQuestionModal('${q.id}')" class="px-2.5 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition-colors flex items-center gap-1" title="Editează direct">
                                    <i class="fa-solid fa-pen-to-square"></i> <span class="hidden sm:inline">Editează</span>
                                </button>
                                <button onclick="deleteQuestion('${q.id}')" class="px-2.5 py-1.5 text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg border border-red-500/30 transition-colors flex items-center gap-1" title="Șterge">
                                    <i class="fa-solid fa-trash-can"></i>
                                </button>
                            </div>
                        </div>

                        <p class="text-white font-medium text-sm sm:text-base break-words">${escapeHtml(q.text)}</p>

                        <div class="space-y-1.5 pl-2 border-l-2 border-slate-800">
                            ${q.options.map((opt, oIdx) => `
                                <div class="text-xs flex items-start gap-2 ${opt.correct ? 'text-emerald-400 font-semibold' : 'text-slate-400'} break-words">
                                    <i class="fa-solid ${opt.correct ? 'fa-square-check text-emerald-400' : 'fa-square text-slate-600'} mt-0.5 shrink-0"></i>
                                    <span class="break-words">${String.fromCharCode(65 + oIdx)}. ${escapeHtml(opt.text)}</span>
                                </div>
                            `).join('')}
                        </div>

                        ${q.explanation ? `
                            <div class="text-xs text-slate-400 bg-slate-950/60 p-3 rounded-xl border border-slate-800/80 italic break-words">
                                <strong class="text-amber-400 not-italic">Explicație:</strong> ${escapeHtml(q.explanation)}
                            </div>
                        ` : ''}
                    </div>
                `;
            }).join('') + (filtered.length > shown.length ? `
                <div class="text-center pt-2">
                    <button onclick="showMoreQuestions()" class="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-amber-400 rounded-xl text-sm font-semibold border border-slate-700">
                        Arată încă ${Math.min(50, filtered.length - shown.length)} (mai sunt ${filtered.length - shown.length})
                    </button>
                </div>` : '');
        };

        window.showMoreQuestions = function() {
            window.bankLimit += 50;
            renderQuestionsBank();
        };


        window.renderProposalDiff = function(p) {
            if (p.type !== 'EDIT' || !p.targetQuestionId) {
                return `<div class="text-xs text-emerald-400 font-medium"><i class="fa-solid fa-plus-circle mr-1"></i> Propunere întrebare nouă completă.</div>`;
            }
            const original = window.questionsBank.find(q => q.id === p.targetQuestionId);
            if (!original) return '<div class="text-xs text-slate-400 italic">Întrebarea originală a fost ștearsă sau nu mai există în baza de date.</div>';

            let diffHtml = '<div class="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 space-y-3 text-xs overflow-x-auto"><div class="font-bold text-amber-400 mb-1 flex items-center gap-1.5"><i class="fa-solid fa-code-compare"></i> Comparație modificări față de varianta originală:</div>';

            let hasChanges = false;

            if (original.text !== p.text) {
                hasChanges = true;
                diffHtml += `<div class="space-y-1 bg-slate-900/60 p-2.5 rounded-lg border border-slate-800 break-words"><div class="text-amber-300 font-semibold">Text întrebare:</div>`;
                diffHtml += `<div class="break-words"><span class="text-slate-500">Vechi:</span> <span class="text-red-400 line-through">${escapeHtml(original.text)}</span></div>`;
                diffHtml += `<div class="break-words"><span class="text-slate-500">Nou:</span> <span class="text-emerald-400 font-semibold">${escapeHtml(p.text)}</span></div></div>`;
            }

            const origExp = original.explanation || '';
            const propExp = p.explanation || '';
            if (origExp !== propExp) {
                hasChanges = true;
                diffHtml += `<div class="space-y-1 bg-slate-900/60 p-2.5 rounded-lg border border-slate-800 break-words"><div class="text-amber-300 font-semibold">Explicație juridică:</div>`;
                diffHtml += `<div class="break-words"><span class="text-slate-500">Veche:</span> <span class="text-red-400 line-through">${escapeHtml(origExp || '(fără explicație)')}</span></div>`;
                diffHtml += `<div class="break-words"><span class="text-slate-500">Nouă:</span> <span class="text-emerald-400 font-semibold">${escapeHtml(propExp || '(fără explicație)')}</span></div></div>`;
            }

            const origOpts = original.options || [];
            const propOpts = p.options || [];
            let optionsChanged = origOpts.length !== propOpts.length;
            if (!optionsChanged) {
                for (let i = 0; i < origOpts.length; i++) {
                    if (origOpts[i].text !== propOpts[i].text || origOpts[i].correct !== propOpts[i].correct) {
                        optionsChanged = true;
                        break;
                    }
                }
            }

            if (optionsChanged) {
                hasChanges = true;
                diffHtml += `<div class="space-y-1.5 bg-slate-900/60 p-2.5 rounded-lg border border-slate-800 break-words"><div class="text-amber-300 font-semibold">Variante de răspuns:</div>`;
                const maxLen = Math.max(origOpts.length, propOpts.length);
                for (let i = 0; i < maxLen; i++) {
                    const optLetter = String.fromCharCode(65 + i);
                    const oOpt = origOpts[i];
                    const pOpt = propOpts[i];

                    if (!oOpt) {
                        diffHtml += `<div class="text-emerald-400 break-words">+ Adăugată [${optLetter}]: ${escapeHtml(pOpt.text)} (${pOpt.correct ? 'Corectă' : 'Greșită'})</div>`;
                    } else if (!pOpt) {
                        diffHtml += `<div class="text-red-400 break-words">- Ștearsă [${optLetter}]: ${escapeHtml(oOpt.text)}</div>`;
                    } else {
                        let optChanges = [];
                        if (oOpt.text !== pOpt.text) {
                            optChanges.push(`Text: <span class="text-red-400 line-through">${escapeHtml(oOpt.text)}</span> -> <span class="text-emerald-400">${escapeHtml(pOpt.text)}</span>`);
                        }
                        if (oOpt.correct !== pOpt.correct) {
                            const oldStatus = oOpt.correct ? 'Corectă' : 'Greșită';
                            const newStatus = pOpt.correct ? 'Corectă' : 'Greșită';
                            optChanges.push(`Status: <span class="text-amber-400">${oldStatus}</span> -> <span class="text-emerald-400 font-bold">${newStatus}</span>`);
                        }
                        if (optChanges.length > 0) {
                            diffHtml += `<div class="break-words"><span class="text-slate-300 font-bold">[${optLetter}]</span> ${optChanges.join(' | ')}</div>`;
                        }
                    }
                }
                diffHtml += `</div>`;
            }

            if (!hasChanges) {
                diffHtml += `<div class="text-slate-400 italic">Nu s-au detectat modificări ale textului sau variantelor față de original.</div>`;
            }

            diffHtml += '</div>';
            return diffHtml;
        };

        function getFilteredProposals() {
            const searchVal = (document.getElementById('proposals-search')?.value || '').toLowerCase();
            return window.proposalsBank.filter(p => {
                const matchesText = p.text.toLowerCase().includes(searchVal);
                const matchesExpl = p.explanation && p.explanation.toLowerCase().includes(searchVal);
                const matchesNotes = p.proposalNotes && p.proposalNotes.toLowerCase().includes(searchVal);
                const matchesSubject = p.subject && p.subject.toLowerCase().includes(searchVal);
                return matchesText || matchesExpl || matchesNotes || matchesSubject;
            });
        }

        window.renderProposalsList = function() {
            const container = document.getElementById('proposals-list-container');
            if (!container) return;

            const filteredProposals = getFilteredProposals();

            if (!filteredProposals || filteredProposals.length === 0) {
                container.innerHTML = `
                    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center text-slate-400">
                        <i class="fa-solid fa-lightbulb text-3xl text-amber-500/30 mb-2"></i>
                        <p>Nu există propuneri de întrebări în așteptare conform căutării.</p>
                    </div>
                `;
                return;
            }

            container.innerHTML = filteredProposals.map(p => {
                const isEdit = p.type === 'EDIT';
                const likes = p.likes || 0;
                const dislikes = p.dislikes || 0;
                const votedState = localStorage.getItem(`quiz_voted_proposal_${p.id}`);

                return `
                    <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4 hover:border-amber-500/30 transition-all shadow-md overflow-hidden">
                        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                            <div class="flex items-center gap-2 flex-wrap">
                                <span class="px-2.5 py-1 rounded-md text-xs font-bold uppercase bg-amber-500/20 text-amber-300 border border-amber-500/30">${escapeHtml(getSubjectLabel(p.subject))}</span>
                                <span class="px-2.5 py-1 rounded-md text-xs font-bold bg-slate-800 text-slate-300">Anul ${p.year || 1}</span>
                                <span class="px-2.5 py-1 rounded-md text-xs font-bold bg-slate-800 text-slate-300">Semestrul ${p.semester || 1}</span>
                                <span class="px-2.5 py-1 rounded-md text-xs font-bold ${isEdit ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'}">
                                    ${isEdit ? '<i class="fa-solid fa-pen-to-square mr-1"></i> Modif.' : '<i class="fa-solid fa-plus mr-1"></i> Nouă'}
                                </span>
                            </div>
                            <!-- Butoane acțiune responsive pe telefon -->
                            <div class="flex items-center space-x-1.5 w-full sm:w-auto justify-end flex-wrap gap-y-1">
                                <button onclick="editProposalModal('${p.id}')" class="px-2.5 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-lg border border-slate-700 transition-colors flex items-center gap-1" title="Editează propunerea">
                                    <i class="fa-solid fa-pen-to-square"></i> <span class="hidden sm:inline">Editează</span>
                                </button>
                                <button onclick="approveProposal('${p.id}')" class="px-2.5 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-bold rounded-lg transition-colors flex items-center gap-1" title="Aprobă">
                                    <i class="fa-solid fa-check"></i> <span class="hidden sm:inline">Aprobă</span>
                                </button>
                                <button onclick="rejectProposal('${p.id}')" class="px-2.5 py-1.5 text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg border border-red-500/30 transition-colors flex items-center gap-1" title="Respinge">
                                    <i class="fa-solid fa-xmark"></i> <span class="hidden sm:inline">Respinge</span>
                                </button>
                            </div>
                        </div>

                        ${renderProposalDiff(p)}

                        <p class="text-white font-medium text-sm sm:text-base break-words">${escapeHtml(p.text)}</p>

                        <div class="space-y-1.5 pl-2 border-l-2 border-amber-500/40">
                            ${p.options ? p.options.map((opt, oIdx) => `
                                <div class="text-xs flex items-start gap-2 ${opt.correct ? 'text-emerald-400 font-semibold' : 'text-slate-400'} break-words">
                                    <i class="fa-solid ${opt.correct ? 'fa-square-check text-emerald-400' : 'fa-square text-slate-600'} mt-0.5 shrink-0"></i>
                                    <span class="break-words">${String.fromCharCode(65 + oIdx)}. ${escapeHtml(opt.text)}</span>
                                </div>
                            `).join('') : ''}
                        </div>

                        ${p.explanation ? `
                            <div class="text-xs text-slate-400 bg-slate-950/60 p-3 rounded-xl border border-slate-800/80 italic break-words">
                                <strong class="text-amber-400 not-italic">Explicație propusă:</strong> ${escapeHtml(p.explanation)}
                            </div>
                        ` : ''}

                        ${p.proposalNotes ? `
                            <div class="text-xs text-amber-200 bg-amber-950/40 p-3 rounded-xl border border-amber-500/30 break-words">
                                <strong class="text-amber-400"><i class="fa-solid fa-note-sticky mr-1"></i> Notițe / Motiv:</strong> ${escapeHtml(p.proposalNotes)}
                            </div>
                        ` : ''}

                        <div class="flex items-center justify-between pt-3 border-t border-slate-800 text-xs flex-wrap gap-2">
                            <div class="flex items-center gap-2">
                                <button onclick="voteProposal('${p.id}', 'LIKE')" class="px-3 py-1.5 rounded-lg border transition-all flex items-center gap-1.5 ${votedState === 'LIKE' ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 font-bold' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}">
                                    <i class="fa-solid fa-thumbs-up"></i> Like (${likes})
                                </button>
                                <button onclick="voteProposal('${p.id}', 'DISLIKE')" class="px-3 py-1.5 rounded-lg border transition-all flex items-center gap-1.5 ${votedState === 'DISLIKE' ? 'bg-red-500/20 border-red-500 text-red-300 font-bold' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}">
                                    <i class="fa-solid fa-thumbs-down"></i> Dislike (${dislikes})
                                </button>
                            </div>
                            ${votedState ? `<span class="text-amber-400 italic"><i class="fa-solid fa-circle-check mr-1"></i> Ai votat (${votedState})</span>` : '<span class="text-slate-500">O singură votare</span>'}
                        </div>
                    </div>
                `;
            }).join('');
        };



        window.voteProposal = async function(pId, voteType) {
            const voteKey = `quiz_voted_proposal_${pId}`;
            const existingVote = localStorage.getItem(voteKey);
            if (existingVote) {
                showToast(`Ai votat deja (${existingVote}) la această propunere!`, "warning");
                return;
            }
            try {
                const res = await api('voteProposal', { id: pId, vote: voteType });
                const proposal = window.proposalsBank.find(p => p.id === pId);
                if (proposal) { proposal.likes = res.likes; proposal.dislikes = res.dislikes; }
                localStorage.setItem(voteKey, voteType);
                renderProposalsList();
                showToast("Votul tău a fost înregistrat!", "success");
            } catch (err) {
                showToast(err.message || 'Votul nu a putut fi înregistrat.', 'error');
            }
        };

        window.saveQuestionForm = async function(e) {
            e.preventDefault();
            const year = parseInt(document.getElementById('form-q-year').value, 10);
            const semester = parseInt(document.getElementById('form-q-sem').value, 10);
            const subject = document.getElementById('form-q-subject').value;
            const text = document.getElementById('form-q-text').value.trim();
            const explanation = document.getElementById('form-q-explanation').value.trim();
            const proposalNotes = document.getElementById('form-q-proposal-notes').value.trim();
            const targetEditId = document.getElementById('form-target-edit-id').value;
            const existingProposalId = document.getElementById('form-proposal-id').value;

            const options = [];
            let hasCorrect = false;
            document.querySelectorAll('.option-row-item').forEach(row => {
                const t = row.querySelector('.opt-text-input').value.trim();
                const c = row.querySelector('.opt-correct-checkbox').checked;
                if (t) {
                    options.push({ text: t, correct: c });
                    if (c) hasCorrect = true;
                }
            });

            if (options.length < 2) { showToast("Introduceți cel puțin 2 variante de răspuns!", "warning"); return; }
            if (!hasCorrect) { showToast("Bifați cel puțin o variantă corectă!", "warning"); return; }
            if (!subject) { showToast("Alege o categorie pentru întrebare.", "warning"); return; }

            const submitBtn = document.getElementById('modal-submit-btn');
            const label = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Se salvează…';
            try {
                if (!window.isProposalModalMode) {
                    // Modificare directă (administrator)
                    const qId = document.getElementById('form-q-id').value;
                    const res = await adminCall("Modificarea directă a întrebării este protejată. Introduceți parola de administrator:",
                        'saveQuestion', { question: { id: qId || undefined, subject, year, semester, text, options, explanation } });
                    if (!res) return;
                    closeQuestionModal();
                    await loadAll();
                    showToast("Întrebarea a fost actualizată cu succes!", "success");
                    return;
                }

                // Propunere (oricine); administratorul o aprobă
                try {
                    await api('saveProposal', { proposal: {
                        id: existingProposalId || undefined, subject, year, semester, text, options, explanation,
                        proposalNotes, targetQuestionId: targetEditId || null
                    } });
                } catch (err) {
                    showToast(err.message || 'Propunerea nu a putut fi trimisă.', 'error');
                    return;
                }
                closeQuestionModal();
                await loadAll();
                showToast("Propunerea ta a fost trimisă cu succes spre moderare!", "success");
                switchTab('proposals');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = label;
            }
        };

        window.proposeEditQuestionModal = function(qId) {
            const q = window.questionsBank.find(item => item.id === qId);
            if (!q) return;
            window.openQuestionModal(true, q, null, qId);
            document.getElementById('modal-title').innerHTML = `<i class="fa-solid fa-lightbulb text-amber-400"></i> Propune Modificare pentru Această Grilă`;
        };


        window.openQuestionModal = function(isNew = true, questionData = null, proposalId = null, targetEditId = null) {
            window.isProposalModalMode = isNew;
            const modal = document.getElementById('question-modal');
            const titleEl = document.getElementById('modal-title');
            const submitBtn = document.getElementById('modal-submit-btn');

            document.getElementById('form-q-id').value = questionData?.id || '';
            document.getElementById('form-target-edit-id').value = targetEditId || '';
            document.getElementById('form-proposal-id').value = proposalId || '';

            buildYearOptions(document.getElementById('form-q-year'), questionData?.year || document.getElementById('cfg-year')?.value || 1, false);
            document.getElementById('form-q-sem').value = questionData?.semester || 1;
            renderCategoryOptions(document.getElementById('form-q-subject'), false, document.getElementById('form-q-year').value, document.getElementById('form-q-sem').value, questionData?.subject);

            document.getElementById('form-q-text').value = questionData?.text || '';
            document.getElementById('form-q-explanation').value = questionData?.explanation || '';
            document.getElementById('form-q-proposal-notes').value = questionData?.proposalNotes || '';

            const optionsContainer = document.getElementById('modal-options-list');
            optionsContainer.innerHTML = '';

            const initialOptions = questionData?.options || [
                { text: "", correct: false },
                { text: "", correct: false },
                { text: "", correct: false }
            ];

            initialOptions.forEach((opt, idx) => {
                addOptionRowModal(opt.text, opt.correct);
            });

            if (isNew) {
                titleEl.innerHTML = `<i class="fa-solid fa-lightbulb text-amber-400"></i> Propune Întrebare Grilă / Modificare`;
                submitBtn.textContent = "Trimite Propunerea";
            } else {
                titleEl.innerHTML = `<i class="fa-solid fa-pen-to-square text-amber-400"></i> Editează Întrebarea`;
                submitBtn.textContent = "Salvează Modificările";
            }

            modal.classList.remove('hidden');
        };

        window.closeQuestionModal = function() {
            document.getElementById('question-modal').classList.add('hidden');
        };

        window.addOptionRowModal = function(text = "", correct = false) {
            const container = document.getElementById('modal-options-list');
            const currentRows = container.children.length;
            if (currentRows >= 6) {
                showToast("Maximum 6 variante de răspuns permise.", "warning");
                return;
            }

            const rowIdx = currentRows;
            const letter = String.fromCharCode(65 + rowIdx);
            const rowDiv = document.createElement('div');
            rowDiv.className = "flex items-center gap-2 option-row-item";
            rowDiv.innerHTML = `
                <span class="w-7 h-7 rounded-lg bg-slate-950 border border-slate-700 flex items-center justify-center text-xs font-bold text-amber-400 shrink-0">${letter}</span>
                <input type="text" value="${escapeHtml(text)}" placeholder="Text variantă ${letter}..." class="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-white focus:ring-2 focus:ring-amber-500 outline-none opt-text-input" required>
                <label class="flex items-center gap-1.5 px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl cursor-pointer hover:border-emerald-500 transition-colors shrink-0">
                    <input type="checkbox" ${correct ? 'checked' : ''} class="w-4 h-4 rounded border-slate-700 text-emerald-500 focus:ring-emerald-500 accent-emerald-500 opt-correct-checkbox">
                    <span class="text-xs text-slate-300 font-medium">Corectă</span>
                </label>
                ${currentRows >= 2 ? `<button type="button" onclick="this.parentElement.remove(); updateOptionsCountLabel();" class="p-2 text-red-400 hover:text-red-300 transition-colors"><i class="fa-solid fa-trash-can"></i></button>` : '<div class="w-8"></div>'}
            `;
            container.appendChild(rowDiv);
            updateOptionsCountLabel();
        };

        function updateOptionsCountLabel() {
            const count = document.querySelectorAll('.option-row-item').length;
            const label = document.getElementById('options-count-label');
            if (label) label.textContent = `${count} / 6 opțiuni`;
        }


        window.proposeCurrentQuizQuestion = function() {
            const quiz = window.currentQuiz;
            const q = quiz.questions[quiz.currentIndex];
            if (!q) return;
            window.openQuestionModal(true, q, null, q.id);
        };



        window.editQuestionModal = async function(qId) {
            if (!(await requireAdmin("Editarea directă este protejată. Introduceți parola de administrator:"))) {
                showToast("Autentificare necesară.", "error");
                return;
            }
            const q = window.questionsBank.find(item => item.id === qId);
            if (!q) return;
            window.isProposalModalMode = false;
            window.openQuestionModal(false, q);
        };


        window.editProposalModal = function(pId) {
            const p = window.proposalsBank.find(item => item.id === pId);
            if (!p) return;
            window.openQuestionModal(true, p, pId, p.targetQuestionId);
        };



        window.approveProposal = async function(pId) {
            const res = await adminCall("Aprobarea propunerilor este protejată. Introduceți parola de administrator:", 'approveProposal', { id: pId });
            if (!res) return;
            await loadAll();
            showToast("Propunerea a fost aprobată și integrată în baza de date!", "success");
        };

        window.rejectProposal = async function(pId) {
            if (!(await requireAdmin("Respingerea propunerilor este protejată. Introduceți parola de administrator:"))) {
                showToast("Autentificare necesară.", "error");
                return;
            }
            if (!confirm("Sigur doriți să respingeți această propunere?")) return;
            const res = await adminCall('', 'rejectProposal', { id: pId });
            if (!res) return;
            await loadAll();
            showToast("Propunerea a fost respinsă și ștearsă.", "info");
        };



        // Keyboard Shortcuts Handler (1-6, A-F, Enter)
        document.addEventListener('keydown', (e) => {
            const activeTab = document.getElementById('tab-quiz-active');
            if (!activeTab || activeTab.classList.contains('hidden')) return;

            const targetTag = e.target.tagName.toLowerCase();
            if (targetTag === 'input' || targetTag === 'textarea' || targetTag === 'select') return;

            const key = e.key.toUpperCase();
            
            if (e.key === 'Enter') {
                e.preventDefault();
                if (!window.currentQuiz.answered) {
                    submitCurrentAnswer();
                } else {
                    nextQuestion();
                }
                return;
            }

            let index = -1;
            if (['1', '2', '3', '4', '5', '6'].includes(key)) {
                index = parseInt(key, 10) - 1;
            } else if (['A', 'B', 'C', 'D', 'E', 'F'].includes(key)) {
                index = key.charCodeAt(0) - 65;
            }

            if (index >= 0) {
                const quiz = window.currentQuiz;
                const currentQ = quiz.questions[quiz.currentIndex];
                if (currentQ && index < currentQ.preparedOptions.length) {
                    e.preventDefault();
                    toggleOptionSelection(index);
                }
            }
        });


        function escapeHtml(str) {
            if (!str) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }


        // ---------- Pornire ----------
        renderSubjectSelects();
        updateAdminUI();
        loadAll();
