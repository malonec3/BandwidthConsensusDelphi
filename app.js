/**
 * Delphi survey — clinical equivalence of target contours.
 * Static site: statements come from a CSV; responses go to Supabase.
 */

// ============================================================================
// 1. CONFIGURATION
// ============================================================================
const CONFIG = {
  // Change for Round 2. Responses from each round are stored separately.
  ROUND: 1,
  // Change whenever you edit the statements CSV, so each response records
  // which wording was answered.
  INSTRUMENT_VERSION: '2026-11-02',
  CSV_PATH: './delphi_statements.csv',

  // Round 2 onwards: the previous round's group results, written by
  // `python delphi_report.py <export.csv> --feedback-json`. 'auto' looks for
  // round<ROUND-1>_feedback.json next to index.html; '' turns it off.
  FEEDBACK_PATH: 'auto',
  // Optional link to the full previous-round report, shown on the welcome page.
  REPORT_URL: '',

  // From Supabase > Project Settings > API (the publishable / anon key).
  SUPABASE_URL: 'https://kxkzbydqtdzvkkzlvylf.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_HW2LexdXVvl7Kef9fTjvHw_y1gM6CfT',
  SUPABASE_TABLE: 'delphi_responses',

  // Require a rating (1-5 or U) for every rated statement before moving on.
  REQUIRE_RATING: true,
  COMMENT_MAX_LENGTH: 3000
};
// Keep drafts separate when wording or question IDs change within a round.
const STORAGE_KEY = `delphi_contours_round${CONFIG.ROUND}_${CONFIG.INSTRUMENT_VERSION}`;

const SCALE = [
  { value: '1', label: 'Strongly disagree' },
  { value: '2', label: 'Disagree' },
  { value: '3', label: 'Neither agree nor disagree' },
  { value: '4', label: 'Agree' },
  { value: '5', label: 'Strongly agree' }
];
const UNABLE = { value: 'U', label: 'Unable to judge because of insufficient information or expertise' };

// ============================================================================
// 2. STATE
// ============================================================================
let items = []; // [{ id, order, section, sectionTitle, sectionIntro, type, text, options, consensus, feedback, revisedFrom }]
let sections = []; // [{ id, title, intro, items: [] }]
let previous = null; // previous round's group results (round<N>_feedback.json), or null
let previousError = '';
let supabaseClient = null;
let progressInFlight = false;
let saveTimer = null;
let state = initialState();

function initialState() {
  return {
    stage: 'welcome', // welcome | survey | review | done
    attemptId: makeId(),
    round: CONFIG.ROUND,
    participant: { name: '', email: '', profession: '', profession_other: '', years: '', country: '', consent: false },
    idx: 0,
    returnToReview: false,
    responses: {}, // { [itemId]: { rating, comment, text, unable, choice, other } }
    times: {}, // { [itemId]: { first, last } }
    startedAt: null,
    submittedAt: null,
    progress: { seq: 0, dirty: false, unconfirmedSeq: 0 }
  };
}

function makeId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(10);
  (window.crypto || window.msCrypto).getRandomValues(buf);
  return 'DLP-' + Array.from(buf, (v) => chars[v % chars.length]).join('');
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    flashSaved();
  } catch (e) {
    console.warn('Could not save to this browser:', e);
  }
}

function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 400);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    const base = initialState();
    return {
      ...base,
      ...saved,
      participant: { ...base.participant, ...(saved.participant || {}) },
      progress: { ...base.progress, ...(saved.progress || {}) },
      responses: saved.responses || {},
      times: saved.times || {}
    };
  } catch (e) {
    console.warn('Could not read the saved copy:', e);
    return null;
  }
}

function flashSaved() {
  const el = document.getElementById('save-indicator');
  if (!el || state.stage === 'welcome' || state.stage === 'done') return;
  el.textContent = 'Saved in this browser';
  el.classList.remove('hidden');
}

// ============================================================================
// 3. START-UP
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('.js-round').forEach((el) => (el.textContent = CONFIG.ROUND));
  document.querySelectorAll('.js-prev-round').forEach((el) => (el.textContent = CONFIG.ROUND - 1));
  // Text marked data-show-round="1" appears in Round 1 only; "2" appears from Round 2 on.
  document.querySelectorAll('[data-show-round]').forEach((el) => {
    const forRound1 = el.dataset.showRound === '1';
    el.classList.toggle('hidden', forRound1 ? CONFIG.ROUND !== 1 : CONFIG.ROUND < 2);
  });
  initSupabase();
  bindEvents();
  try {
    const res = await fetch(CONFIG.CSV_PATH, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${CONFIG.CSV_PATH}`);
    parseItems(await res.text());
  } catch (err) {
    showError(`${err.message}. If you opened index.html directly from your computer, use a web server or GitHub Pages instead.`);
    return;
  }
  await loadPreviousRound();
  document.getElementById('loading-state').classList.add('hidden');

  const saved = loadState();
  if (saved) state = saved;
  else prefillFromPreviousRound();
  if (state.idx >= items.length) state.idx = 0;
  renderScaleTable();
  renderCounts();
  showStage(state.stage);
});

function initSupabase() {
  const configured =
    CONFIG.SUPABASE_URL && !CONFIG.SUPABASE_URL.startsWith('YOUR_') &&
    CONFIG.SUPABASE_ANON_KEY && !CONFIG.SUPABASE_ANON_KEY.startsWith('YOUR_');
  if (window.supabase && configured) {
    try {
      supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
    } catch (err) {
      console.warn('Supabase could not be initialised:', err);
    }
  }
}

function parseItems(csvText) {
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  items = (parsed.data || [])
    .filter((r) => (r.id || '').trim())
    .map((r, i) => ({
      id: r.id.trim(),
      order: i + 1,
      section: (r.section || '').trim(),
      sectionTitle: (r.section_title || '').trim(),
      sectionIntro: (r.section_intro || '').trim(),
      type: ['rating', 'open', 'choice'].includes((r.type || '').trim()) ? r.type.trim() : 'rating',
      text: (r.text || '').trim(),
      options: (r.options || '').split('|').map((s) => s.trim()).filter(Boolean),
      consensus: ['1', 'true', 'yes', 'y'].includes(String(r.consensus || '').trim().toLowerCase()),
      feedback: (r.feedback || '').trim(),
      // For a reworded statement: the id of the original, whose results are shown
      revisedFrom: (r.revised_from || '').trim()
    }));
  if (items.length === 0) throw new Error('The statements file has no rows');

  sections = [];
  items.forEach((it) => {
    let sec = sections.find((s) => s.id === it.section);
    if (!sec) {
      sec = { id: it.section, title: it.sectionTitle, intro: it.sectionIntro, items: [] };
      sections.push(sec);
    }
    sec.items.push(it);
  });
}

async function loadPreviousRound() {
  if (CONFIG.ROUND < 2 || !CONFIG.FEEDBACK_PATH) return;
  const path = CONFIG.FEEDBACK_PATH === 'auto' ? `./round${CONFIG.ROUND - 1}_feedback.json` : CONFIG.FEEDBACK_PATH;
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || typeof data.items !== 'object') throw new Error('unexpected format');
    previous = data;
  } catch (err) {
    previousError = `The Round ${CONFIG.ROUND - 1} group results could not be loaded (${path}: ${err.message}).`;
    console.warn(previousError);
  }
}

// In a new round, copy the participant's details from the previous round if it
// was completed in this browser (consent must be given again).
function prefillFromPreviousRound() {
  if (CONFIG.ROUND < 2) return;
  try {
    const prefix = `delphi_contours_round${CONFIG.ROUND - 1}_`;
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(prefix)).sort();
    for (let i = keys.length - 1; i >= 0; i--) {
      const old = JSON.parse(localStorage.getItem(keys[i]) || 'null');
      if (old && old.participant && old.participant.email) {
        state.participant = { ...state.participant, ...old.participant, consent: false };
        return;
      }
    }
  } catch (e) {
    /* nothing to prefill */
  }
}

function showError(msg) {
  document.getElementById('loading-state').classList.add('hidden');
  document.getElementById('error-state').classList.remove('hidden');
  document.getElementById('error-message').textContent = msg;
}

// ============================================================================
// 4. HELPERS
// ============================================================================
const resp = (id) => state.responses[id] || {};
const sectionOf = (item) => sections.find((s) => s.id === item.section);

function isOtherChoice(value) {
  return String(value ?? '').trim().toLowerCase() === 'other';
}

function isAnswered(item) {
  const r = resp(item.id);
  if (item.type === 'rating') return Boolean(r.rating);
  if (item.type === 'open') return Boolean((r.text || '').trim()) || Boolean(r.unable);
  if (item.type === 'choice') return Boolean(r.choice);
  return false;
}
const isRequired = (item) => item.type === 'rating' && CONFIG.REQUIRE_RATING;

function updateResponse(id, patch) {
  state.responses[id] = { ...resp(id), ...patch };
  const now = new Date().toISOString();
  const t = state.times[id];
  state.times[id] = { first: t ? t.first : now, last: now };
  state.progress.dirty = true;
}

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function answerSummary(item) {
  const r = resp(item.id);
  if (item.type === 'rating') {
    if (!r.rating) return '';
    if (r.rating === 'U') return 'U — Unable to judge';
    const s = SCALE.find((x) => x.value === r.rating);
    return `${r.rating} — ${s ? s.label : ''}`;
  }
  if (item.type === 'open') {
    if (r.unable) return 'Unable to answer';
    return (r.text || '').trim();
  }
  if (item.type === 'choice') {
    if (!r.choice) return '';
    if (r.choice === 'U') return 'Unable to answer';
    if (isOtherChoice(r.choice)) return `Other: ${(r.other || '').trim() || '(not specified)'}`;
    return r.choice;
  }
  return '';
}

// ============================================================================
// 4b. PREVIOUS-ROUND GROUP RESULTS (Round 2 onwards)
// ============================================================================
const LIKERT_COLOURS = { 1: '#b93a39', 2: '#ee9d97', 3: '#cfcdc6', 4: '#8db6e8', 5: '#2a6fc4' };
const SHORT_LABELS = { 1: 'Strongly disagree', 2: 'Disagree', 3: 'Neutral', 4: 'Agree', 5: 'Strongly agree', U: 'Unable to judge' };
const U_PATTERN = 'repeating-linear-gradient(135deg,#c3c2b7 0 1.5px,#f0efec 1.5px 6px)';

const previousFor = (item) => (previous && previous.items ? previous.items[item.revisedFrom || item.id] : null);
const pctText = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
const numText = (x) => (x === null || x === undefined ? '–' : Number.isInteger(x) ? String(x) : String(Math.round(x * 10) / 10));

function resultSentence(fb) {
  const d = fb.denominator;
  let detail = '';
  if (fb.result_key === 'agree') detail = `${pctText(fb.pct_agree)} rated 4–5 (${fb.agree_n} of ${d})`;
  else if (fb.result_key === 'disagree') detail = `${pctText(fb.pct_disagree)} rated 1–2 (${fb.disagree_n} of ${d})`;
  else if (fb.result_key === 'none') detail = `${pctText(fb.pct_agree)} agree, ${pctText(fb.pct_disagree)} disagree (n = ${d})`;
  return `<span class="font-bold">${escapeHTML(fb.result)}</span>${detail ? ` · ${escapeHTML(detail)}` : ''}${
    fb.borderline ? ' <span class="text-slate-500 italic">· one vote from changing</span>' : ''
  }`;
}

function ratingChartHTML(fb) {
  const total = Math.max(1, previous.respondents || 0, ...['1', '2', '3', '4', '5', 'U'].map((k) => fb.counts[k] || 0));
  const keys = ['1', '2', '3', '4', '5', 'U'];
  const aria = keys.map((k) => `${k} ${SHORT_LABELS[k]}: ${fb.counts[k] || 0}`).join(', ');
  const cols = keys
    .map((k) => {
      const n = fb.counts[k] || 0;
      const h = n ? Math.max(3, Math.round((n / total) * 110)) : 0;
      const bg = k === 'U' ? `background:${U_PATTERN};box-shadow:inset 0 0 0 1px #898781` : `background:${LIKERT_COLOURS[k]}`;
      return `
        <div class="flex-1 flex flex-col items-center ${k === 'U' ? 'ml-2 sm:ml-4 pl-2 sm:pl-4 border-l border-slate-200' : ''}">
          <div class="h-[132px] w-full flex flex-col items-center justify-end">
            <span class="text-xs font-semibold text-slate-800 mb-1">${n}</span>
            <div class="w-full max-w-[46px] rounded-t-[4px]" style="height:${h}px;${bg}"></div>
          </div>
          <div class="w-full border-t border-slate-300 pt-1 text-center leading-tight">
            <span class="block text-[11px] font-bold text-slate-700">${k}</span>
            <span class="block text-[10px] text-slate-500">${escapeHTML(SHORT_LABELS[k])}</span>
          </div>
        </div>`;
    })
    .join('');
  return `<div class="mt-3 flex items-stretch gap-1 sm:gap-2" role="img" aria-label="Round ${escapeHTML(previous.source_round)} ratings. ${escapeHTML(aria)}">${cols}</div>`;
}

function choiceChartHTML(fb) {
  const entries = Object.entries(fb.counts || {}).filter(([k, v]) => v > 0 || (k !== 'Other' && k !== 'U'));
  const top = Math.max(1, ...entries.map(([, v]) => v));
  return `<div class="mt-3 space-y-1.5">${entries
    .map(([k, v]) => `
      <div class="flex items-center gap-2 text-xs">
        <span class="w-40 sm:w-56 shrink-0 text-right text-slate-700">${escapeHTML(k === 'U' ? 'Unable to answer' : k)}</span>
        <span class="h-3.5 rounded-r-[4px]" style="width:${Math.max(v ? 2 : 0, (v / top) * 60)}%;${k === 'U' ? `background:${U_PATTERN}` : 'background:#2a6fc4'}"></span>
        <span class="font-semibold text-slate-800">${v}</span>
      </div>`)
    .join('')}</div>`;
}

function listDetailsHTML(title, entries) {
  if (!entries.length) return '';
  return `
    <details class="mt-3 rounded-lg border border-slate-200 bg-white">
      <summary class="px-3 py-2 text-sm font-semibold text-brand-navy cursor-pointer select-none">${escapeHTML(title)}</summary>
      <ul class="px-3 pb-3 space-y-2 text-sm text-slate-700">${entries.map((e) => `<li class="whitespace-pre-line border-t border-slate-100 pt-2">${e}</li>`).join('')}</ul>
    </details>`;
}

function feedbackPanelHTML(item) {
  const fb = previousFor(item);
  if (!fb) {
    return item.feedback
      ? `<div class="mt-4 text-sm bg-sky-50 border border-sky-200 rounded-xl px-4 py-3 text-brand-navy"><span class="font-bold block text-xs uppercase tracking-wider mb-1">Previous round — group result</span>${escapeHTML(item.feedback)}</div>`
      : '';
  }
  const prev = escapeHTML(previous.source_round);
  let inner = '';
  if (item.revisedFrom) {
    inner += `<p class="text-xs text-slate-600 bg-white border border-slate-200 rounded-lg px-3 py-2 mb-3">These are the Round ${prev} results for the original wording (${escapeHTML(item.revisedFrom)}): <span class="italic">“${escapeHTML(fb.text)}”</span></p>`;
  }
  if (fb.type === 'rating') {
    inner += `
      <p class="text-sm text-slate-900">${resultSentence(fb)}</p>
      <p class="text-xs text-slate-500 mt-0.5">Neutral (3): ${pctText(fb.pct_neutral)} · Median ${numText(fb.median)} (IQR ${numText(fb.q1)}–${numText(fb.q3)}) · Unable to judge: ${fb.counts.U || 0}</p>
      ${ratingChartHTML(fb)}`;
  } else if (fb.type === 'choice') {
    inner += choiceChartHTML(fb);
  }
  if (fb.summary) {
    inner += `<p class="mt-4 text-sm text-slate-800 leading-relaxed"><span class="font-semibold">Summary of ${fb.type === 'open' ? 'responses' : 'comments'}.</span> ${escapeHTML(fb.summary)}</p>`;
  }
  if (fb.type === 'open') {
    inner += listDetailsHTML(`Round ${previous.source_round} responses (${(fb.responses || []).length})`, (fb.responses || []).map((t) => escapeHTML(t)));
  } else {
    const comments = fb.comments || [];
    const label = (c) => (c.rating ? `Rated ${c.rating}` : c.choice ? `Chose ${c.choice}` : '');
    inner += listDetailsHTML(
      `Comments from Round ${previous.source_round} (${comments.length})`,
      comments.map((c) => `${label(c) ? `<span class="font-semibold text-slate-500">${escapeHTML(label(c))}:</span> ` : ''}${escapeHTML(c.text)}`)
    );
    if (!comments.length) inner += `<p class="mt-3 text-xs italic text-slate-500">No comments were received.</p>`;
  }
  return `
    <section class="mt-5 rounded-xl border border-sky-200 bg-sky-50/60 px-4 py-4" aria-label="Round ${prev} group result">
      <p class="text-xs font-bold uppercase tracking-wider text-brand-navy mb-2">Round ${prev} group result · ${escapeHTML(previous.respondents)} respondents</p>
      ${inner}
    </section>`;
}

function renderPreviousRound() {
  const box = document.getElementById('previous-round');
  if (!box) return;
  if (CONFIG.ROUND < 2 || (!previous && !previousError)) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (!previous) {
    box.innerHTML = `<p class="text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3">${escapeHTML(previousError)} Please let the study team know.</p>`;
    return;
  }
  const rated = Object.entries(previous.items).filter(([, v]) => v.type === 'rating');
  const accepted = rated.filter(([id, v]) => ['agree', 'disagree'].includes(v.result_key) && !items.some((i) => i.id === id));
  const nCons = rated.filter(([, v]) => ['agree', 'disagree'].includes(v.result_key)).length;
  const prev = escapeHTML(previous.source_round);
  const rows = accepted
    .map(([id, v]) => `
      <li class="py-2 border-t border-slate-100 flex gap-3">
        <span class="shrink-0 w-10 font-bold text-brand-navy">${escapeHTML(id)}</span>
        <span class="flex-1 text-slate-700">${escapeHTML(v.text)}</span>
        <span class="shrink-0 w-28 text-right text-xs font-semibold ${v.result_key === 'agree' ? 'text-brand-teal' : 'text-red-700'}">${escapeHTML(v.result)}<span class="block font-normal text-slate-500">${pctText(v.result_key === 'agree' ? v.pct_agree : v.pct_disagree)}</span></span>
      </li>`)
    .join('');
  box.innerHTML = `
    <h3 class="text-lg font-bold text-brand-navy">Round ${prev} results</h3>
    <p class="text-sm text-slate-700 mt-2 leading-relaxed">${escapeHTML(previous.respondents)} panel members responded to Round ${prev}. Consensus was reached on ${nCons} of ${rated.length} statements. ${escapeHTML(previous.rule || '')}</p>
    <p class="text-sm text-slate-700 mt-2 leading-relaxed">In this round you will rate ${items.filter((i) => i.type === 'rating' && !i.revisedFrom).length} statements again${
      items.some((i) => i.revisedFrom) ? ` and ${items.filter((i) => i.revisedFrom).length} revised ${items.filter((i) => i.revisedFrom).length === 1 ? 'statement' : 'statements'}` : ''
    }, each shown with the Round ${prev} results and comments.${
      accepted.length ? ` The ${accepted.length} statements below reached consensus and are not being rated again.` : ''
    }${CONFIG.REPORT_URL ? ` <a class="font-semibold text-brand-teal underline" href="${escapeHTML(CONFIG.REPORT_URL)}" target="_blank" rel="noopener">Read the full Round ${prev} report</a>.` : ''}</p>
    ${accepted.length ? `
    <details class="mt-4 rounded-xl border border-slate-200">
      <summary class="px-4 py-3 text-sm font-semibold text-slate-700 cursor-pointer select-none">Statements that reached consensus in Round ${prev} (${accepted.length})</summary>
      <ul class="px-4 pb-3 text-sm">${rows}</ul>
    </details>` : ''}`;
}

// ============================================================================
// 5. STAGES
// ============================================================================
function showStage(stage) {
  state.stage = stage;
  saveState(); // persist the stage so a refresh returns to the same place
  ['welcome', 'survey', 'review', 'done'].forEach((s) =>
    document.getElementById(`stage-${s}`).classList.toggle('hidden', s !== stage)
  );
  document.getElementById('save-indicator').classList.toggle('hidden', stage === 'welcome' || stage === 'done');
  if (stage === 'welcome') renderWelcome();
  if (stage === 'survey') renderItem();
  if (stage === 'review') renderReview();
  if (stage === 'done') renderDone();
  window.scrollTo({ top: 0 });
}

function renderScaleTable() {
  const rows = [...SCALE, UNABLE].map(
    (s) => `<tr><td class="px-4 py-2 w-14 font-bold text-brand-navy">${s.value}</td><td class="px-4 py-2 text-slate-700">${escapeHTML(s.label)}</td></tr>`
  );
  document.getElementById('scale-table').innerHTML = rows.join('');
}

function renderCounts() {
  document.getElementById('count-statements').textContent = items.filter((i) => i.type === 'rating').length;
  document.getElementById('count-questions').textContent = items.filter((i) => i.type !== 'rating').length;
}

function renderWelcome() {
  const p = state.participant;
  document.getElementById('input-name').value = p.name;
  document.getElementById('input-email').value = p.email;
  document.getElementById('input-profession').value = p.profession;
  document.getElementById('input-profession-other').value = p.profession_other;
  document.getElementById('input-years').value = p.years;
  document.getElementById('input-country').value = p.country;
  document.getElementById('input-consent').checked = p.consent;
  toggleProfessionOther();
  renderPreviousRound();
}

function toggleProfessionOther() {
  const other = document.getElementById('input-profession').value === 'Other';
  document.getElementById('profession-other-wrap').classList.toggle('hidden', !other);
  document.getElementById('profession-other-wrap').classList.toggle('block', other);
}

// ---------------------------------------------------------------------------
// One item at a time
// ---------------------------------------------------------------------------
function renderItem() {
  const item = items[state.idx];
  const sec = sectionOf(item);
  const r = resp(item.id);
  document.getElementById('item-warning').classList.add('hidden');

  // progress
  const answered = items.filter(isAnswered).length;
  document.getElementById('progress-text').textContent = `Item ${state.idx + 1} of ${items.length} · ${answered} answered`;
  document.getElementById('progress-bar').style.width = `${Math.round((answered / items.length) * 100)}%`;
  document.getElementById('section-chips').innerHTML = sections
    .map((s) => {
      const done = s.items.filter(isAnswered).length;
      const current = s.id === sec.id;
      return `<button type="button" data-section="${escapeHTML(s.id)}" class="px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${
        current ? 'bg-brand-navy text-white border-brand-navy' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
      }" title="${escapeHTML(s.title)}">${escapeHTML(s.id)} · ${done}/${s.items.length}</button>`;
    })
    .join('');

  // body
  const pos = sec.items.indexOf(item) + 1;
  let body = `
    <p class="text-xs font-bold uppercase tracking-wider text-brand-teal">Section ${escapeHTML(sec.id)} · ${escapeHTML(sec.title)}</p>
    <p class="text-[11px] text-slate-400 mt-0.5">${pos} of ${sec.items.length} in this section</p>
    ${sec.intro ? `<p class="mt-3 text-sm italic text-slate-600 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5">${escapeHTML(sec.intro)}</p>` : ''}
    <div class="mt-5 flex items-start gap-3">
      <span class="shrink-0 px-2 py-1 rounded-md bg-brand-light text-brand-navy text-xs font-bold">${escapeHTML(item.id)}</span>
      <div>
        ${item.revisedFrom ? `<span class="inline-block mb-1.5 px-2 py-0.5 rounded-md bg-amber-100 text-amber-900 text-[11px] font-bold uppercase tracking-wider">Revised in Round ${CONFIG.ROUND}</span>` : ''}
        <h2 class="text-lg sm:text-xl font-semibold text-slate-900 leading-snug">${escapeHTML(item.text)}</h2>
      </div>
    </div>
    ${feedbackPanelHTML(item)}
  `;

  if (item.type === 'rating') {
    body += `
      <fieldset class="mt-6">
        <legend class="text-sm font-semibold text-slate-800 mb-2">Your rating${isRequired(item) ? ' <span class="text-red-500">*</span>' : ''}</legend>
        <div class="grid grid-cols-1 sm:grid-cols-5 gap-2" role="radiogroup">
          ${SCALE.map((s) => scaleButton(s, r.rating === s.value, 'rating')).join('')}
        </div>
        <p class="text-[11px] font-medium text-slate-500 mt-3 mb-1.5">Or, if you cannot judge this statement:</p>
        <div>${scaleButton(UNABLE, r.rating === 'U', 'rating', true)}</div>
      </fieldset>
      ${commentBox(item, r, 'Comments (optional)', 'Caveats, conditions, or perspectives to consider for this statement…')}`;
  } else if (item.type === 'open') {
    body += `
      ${commentBox(item, r, 'Your response', 'A brief response is sufficient…', 'text', r.unable)}
      <label class="mt-3 flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
        <input type="checkbox" data-unable class="h-4 w-4 rounded border-slate-300" ${r.unable ? 'checked' : ''} />
        Unable to answer because of insufficient information or expertise
      </label>`;
  } else if (item.type === 'choice') {
    const opts = item.options.map((o) => ({
      value: o,
      label: o === 'U' ? 'Unable to answer' : o
    }));
    if (!opts.some((o) => o.value === 'U')) {
      opts.push({ value: 'U', label: 'Unable to answer' });
    }
    body += `
      <fieldset class="mt-6">
        <legend class="text-sm font-semibold text-slate-800 mb-2">Choose one</legend>
        <div class="space-y-2" role="radiogroup">
          ${opts.map((o) => choiceButton(o, r.choice === o.value)).join('')}
        </div>
        <div id="other-wrap" class="${isOtherChoice(r.choice) ? '' : 'hidden'} mt-3">
          <label class="block text-sm font-medium text-slate-700 mb-1" for="other-input">Your suggested name</label>
          <input id="other-input" type="text" maxlength="200" value="${escapeHTML(r.other || '')}" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-teal" />
        </div>
      </fieldset>
      ${commentBox(item, r, 'Comments (optional)', 'Why this name, or any other thoughts…')}`;
  }

  const card = document.getElementById('item-card');
  card.innerHTML = body;

  card.querySelectorAll('[data-rating]').forEach((btn) =>
    btn.addEventListener('click', () => {
      updateResponse(item.id, { rating: btn.dataset.rating });
      saveState();
      refreshButtons(card, 'rating', btn.dataset.rating);
      updateProgressOnly();
    })
  );
  card.querySelectorAll('[data-choice]').forEach((btn) =>
    btn.addEventListener('click', () => {
      updateResponse(item.id, { choice: btn.dataset.choice });
      saveState();
      refreshButtons(card, 'choice', btn.dataset.choice);
      card.querySelector('#other-wrap').classList.toggle('hidden', !isOtherChoice(btn.dataset.choice));
      updateProgressOnly();
    })
  );
  const other = card.querySelector('#other-input');
  if (other) other.addEventListener('input', () => { updateResponse(item.id, { other: other.value }); saveStateSoon(); });
  card.querySelectorAll('textarea[data-field]').forEach((ta) =>
    ta.addEventListener('input', () => {
      updateResponse(item.id, { [ta.dataset.field]: ta.value });
      saveStateSoon();
      updateProgressOnly();
    })
  );
  const unable = card.querySelector('[data-unable]');
  if (unable) {
    unable.addEventListener('change', () => {
      updateResponse(item.id, { unable: unable.checked });
      saveState();
      const ta = card.querySelector('textarea[data-field="text"]');
      if (ta) ta.disabled = unable.checked;
      updateProgressOnly();
    });
  }

  document.getElementById('btn-prev').disabled = state.idx === 0;
  const next = document.getElementById('btn-next');
  next.textContent = state.returnToReview ? 'Back to review ✓' : state.idx === items.length - 1 ? 'Review answers →' : 'Next →';
}

function updateProgressOnly() {
  const answered = items.filter(isAnswered).length;
  document.getElementById('progress-text').textContent = `Item ${state.idx + 1} of ${items.length} · ${answered} answered`;
  document.getElementById('progress-bar').style.width = `${Math.round((answered / items.length) * 100)}%`;
  const sec = sectionOf(items[state.idx]);
  const chip = document.querySelector(`#section-chips [data-section="${CSS.escape(sec.id)}"]`);
  if (chip) chip.textContent = `${sec.id} · ${sec.items.filter(isAnswered).length}/${sec.items.length}`;
}

function scaleButton(s, selected, kind, wide = false) {
  return `<button type="button" data-${kind}="${s.value}" role="radio" aria-checked="${selected}"
      class="scale-btn w-full ${wide ? 'flex items-center gap-3 text-left' : 'flex sm:flex-col items-center sm:justify-center gap-3 sm:gap-1 text-left sm:text-center'} px-3 py-3 rounded-xl border-2 ${
        selected ? 'border-brand-teal bg-brand-light text-brand-navy' : 'border-slate-200 bg-white hover:border-slate-400 text-slate-700'
      }">
      <span class="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-sm font-bold ${selected ? 'bg-brand-teal text-white' : 'bg-slate-100 text-slate-700'}">${s.value}</span>
      <span class="text-xs sm:text-[11px] font-medium leading-tight">${escapeHTML(s.label)}</span>
    </button>`;
}

function choiceButton(o, selected) {
  return `<button type="button" data-choice="${escapeHTML(o.value)}" role="radio" aria-checked="${selected}"
      class="scale-btn w-full text-left px-4 py-3 rounded-xl border-2 text-sm font-medium ${
        selected ? 'border-brand-teal bg-brand-light text-brand-navy' : 'border-slate-200 bg-white hover:border-slate-400 text-slate-700'
      }">${escapeHTML(o.label)}</button>`;
}

function commentBox(item, r, label, placeholder, field = 'comment', disabled = false) {
  return `
    <label class="block mt-6">
      <span class="block text-sm font-semibold text-slate-800 mb-1.5">${escapeHTML(label)}</span>
      <textarea data-field="${field}" rows="4" maxlength="${CONFIG.COMMENT_MAX_LENGTH}" ${disabled ? 'disabled' : ''}
        placeholder="${escapeHTML(placeholder)}"
        class="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-teal disabled:bg-slate-100">${escapeHTML(r[field] || '')}</textarea>
    </label>`;
}

function refreshButtons(card, kind, value) {
  card.querySelectorAll(`[data-${kind}]`).forEach((b) => {
    const sel = b.dataset[kind] === value;
    b.setAttribute('aria-checked', sel);
    b.classList.toggle('border-brand-teal', sel);
    b.classList.toggle('bg-brand-light', sel);
    b.classList.toggle('text-brand-navy', sel);
    b.classList.toggle('border-slate-200', !sel);
    b.classList.toggle('bg-white', !sel);
    const badge = b.querySelector('span');
    if (badge && kind === 'rating') {
      badge.classList.toggle('bg-brand-teal', sel);
      badge.classList.toggle('text-white', sel);
      badge.classList.toggle('bg-slate-100', !sel);
      badge.classList.toggle('text-slate-700', !sel);
    }
  });
}

function goTo(newIdx) {
  const from = items[state.idx];
  const to = items[newIdx];
  if (from && to && from.section !== to.section) maybeSaveProgress();
  state.idx = newIdx;
  saveState();
  renderItem();
  window.scrollTo({ top: 0 });
}

function handleNext() {
  const item = items[state.idx];
  if (isRequired(item) && !isAnswered(item)) {
    const w = document.getElementById('item-warning');
    w.textContent = 'Please choose a rating, or U if you cannot judge this statement.';
    w.classList.remove('hidden');
    return;
  }
  if (state.returnToReview || state.idx === items.length - 1) {
    state.returnToReview = false;
    maybeSaveProgress();
    saveState();
    showStage('review');
    return;
  }
  goTo(state.idx + 1);
}

// ---------------------------------------------------------------------------
// Review, submission and copy
// ---------------------------------------------------------------------------
function responseListHTML(editable) {
  return sections
    .map(
      (sec) => `
    <div>
      <h3 class="text-sm font-bold text-brand-navy uppercase tracking-wider">${escapeHTML(sec.id)} · ${escapeHTML(sec.title)}</h3>
      <div class="mt-2 divide-y divide-slate-100 border border-slate-200 rounded-xl">
        ${sec.items
          .map((it) => {
            const r = resp(it.id);
            const ans = answerSummary(it);
            const missing = !isAnswered(it);
            const comment = it.type === 'open' ? '' : (r.comment || '').trim();
            return `
          <div class="print-item px-4 py-3 ${missing && isRequired(it) ? 'bg-amber-50' : ''}">
            <div class="flex items-start justify-between gap-3">
              <p class="text-sm text-slate-800"><span class="font-bold text-brand-navy mr-1">${escapeHTML(it.id)}</span>${it.revisedFrom ? '<span class="text-[10px] font-bold uppercase text-amber-800 mr-1">Revised</span>' : ''}${escapeHTML(it.text)}</p>
              ${editable ? `<button type="button" data-edit="${escapeHTML(it.id)}" class="no-print shrink-0 text-xs font-semibold text-brand-teal hover:underline">Edit</button>` : ''}
            </div>
            <p class="text-sm mt-1.5 ${missing ? 'text-amber-800 italic' : 'font-semibold text-slate-900'}">${missing ? (isRequired(it) ? 'Not yet rated' : 'No response') : escapeHTML(ans)}</p>
            ${comment ? `<p class="text-xs text-slate-600 mt-1 whitespace-pre-line"><span class="font-semibold">Comment:</span> ${escapeHTML(comment)}</p>` : ''}
          </div>`;
          })
          .join('')}
      </div>
    </div>`
    )
    .join('');
}

function missingRequired() {
  return items.filter((it) => isRequired(it) && !isAnswered(it));
}

function renderReview() {
  document.getElementById('review-list').innerHTML = responseListHTML(true);
  document.getElementById('submit-error').classList.add('hidden');
  const missing = missingRequired();
  const box = document.getElementById('review-missing');
  box.classList.toggle('hidden', missing.length === 0);
  box.textContent = missing.length
    ? `Please rate ${missing.length === 1 ? 'statement' : 'statements'} ${missing.map((m) => m.id).join(', ')} before submitting (choose U if you cannot judge).`
    : '';
  document.getElementById('btn-submit').disabled = missing.length > 0;
  document.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      state.idx = items.findIndex((i) => i.id === b.dataset.edit);
      state.returnToReview = true;
      saveState();
      showStage('survey');
    })
  );
}

function renderDone() {
  const p = state.participant;
  const when = state.submittedAt ? new Date(state.submittedAt).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' }) : '';
  document.getElementById('done-meta').textContent =
    `${p.name} · Round ${CONFIG.ROUND} · submitted ${when} · reference ${state.attemptId}`;
  document.getElementById('done-list').innerHTML = responseListHTML(false);
}

// ============================================================================
// 6. SAVING TO SUPABASE
// Rows are only ever inserted, never updated. A snapshot is sent when the
// participant leaves a section having changed something, and a final row on
// submission. Each row holds all responses so far, so a failed or interrupted
// snapshot is covered by the next one. Analysis uses the latest submitted row
// per email address and round.
// ============================================================================
function buildRow(event) {
  const responses = {};
  items.forEach((it) => {
    const r = state.responses[it.id];
    if (!r) return;
    responses[it.id] = {
      order: it.order,
      section: it.section,
      type: it.type,
      consensus: it.consensus,
      revised_from: it.revisedFrom || null,
      rating: it.type === 'rating' ? r.rating || null : null,
      text: it.type === 'open' ? (r.text || '').trim() || null : null,
      choice: it.type === 'choice' ? r.choice || null : null,
      other: it.type === 'choice' && isOtherChoice(r.choice) ? (r.other || '').trim() || null : null,
      unable: it.type === 'open' ? Boolean(r.unable) : it.type === 'rating' ? r.rating === 'U' : r.choice === 'U',
      comment: (r.comment || '').trim() || null,
      first_answered_at: state.times[it.id]?.first || null,
      last_answered_at: state.times[it.id]?.last || null
    };
  });
  const p = state.participant;
  return {
    attempt_id: state.attemptId,
    round: CONFIG.ROUND,
    instrument_version: CONFIG.INSTRUMENT_VERSION,
    event,
    seq: state.progress.seq,
    participant_name: p.name,
    participant_email: p.email,
    profession: p.profession,
    profession_other: p.profession === 'Other' ? p.profession_other : null,
    years_experience: p.years,
    country: p.country,
    started_at: state.startedAt,
    client_saved_at: new Date().toISOString(),
    answered_count: items.filter(isAnswered).length,
    total_items: items.length,
    responses
  };
}

function maybeSaveProgress() {
  if (!supabaseClient || state.stage === 'done') return;
  const pr = state.progress;
  const needsResend = pr.unconfirmedSeq > 0 && !progressInFlight;
  if (!pr.dirty && !needsResend) return;

  pr.seq += 1;
  pr.dirty = false;
  pr.unconfirmedSeq = pr.seq;
  const seq = pr.seq;
  const attempt = state.attemptId;
  const row = buildRow('section_complete');
  saveState();

  progressInFlight = true;
  Promise.resolve()
    .then(() => supabaseClient.from(CONFIG.SUPABASE_TABLE).insert([row]))
    .then((res) => {
      if (res && res.error) throw res.error;
      if (state.attemptId === attempt && state.progress.unconfirmedSeq === seq) {
        state.progress.unconfirmedSeq = 0;
        saveState();
      }
    })
    .catch((err) => console.warn('Progress not saved to the database yet; it will be resent:', err))
    .finally(() => { progressInFlight = false; });
}

async function submitResponses() {
  const btn = document.getElementById('btn-submit');
  const errBox = document.getElementById('submit-error');
  errBox.classList.add('hidden');
  if (missingRequired().length) return renderReview();

  if (!supabaseClient) {
    errBox.textContent = 'Your responses could not be sent because the database connection is not set up. Your answers are still saved in this browser. Please contact the study team.';
    errBox.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Submitting…';
  state.progress.seq += 1;
  const row = buildRow('submitted');
  try {
    const { error } = await supabaseClient.from(CONFIG.SUPABASE_TABLE).insert([row]);
    if (error) throw error;
    state.progress.unconfirmedSeq = 0;
    state.progress.dirty = false;
    state.submittedAt = new Date().toISOString();
    saveState();
    showStage('done');
  } catch (err) {
    console.error('Submission failed:', err);
    saveState();
    errBox.textContent = 'Your responses could not be sent. Please check your internet connection and try again. Your answers are still saved in this browser.';
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = missingRequired().length > 0;
    btn.textContent = 'Submit my responses';
  }
}

// ============================================================================
// 7. EVENTS
// ============================================================================
function bindEvents() {
  document.getElementById('input-profession').addEventListener('change', toggleProfessionOther);

  document.getElementById('start-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = (id) => document.getElementById(id).value.trim();
    const p = {
      name: val('input-name'),
      email: val('input-email'),
      profession: val('input-profession'),
      profession_other: val('input-profession-other'),
      years: val('input-years'),
      country: val('input-country'),
      consent: document.getElementById('input-consent').checked
    };
    const err = document.getElementById('form-error');
    const problem =
      (!p.name && 'Please enter your name.') ||
      (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email) && 'Please enter a valid email address.') ||
      (!p.profession && 'Please select your profession.') ||
      (p.profession === 'Other' && !p.profession_other && 'Please specify your profession.') ||
      (!p.years && 'Please select your years in this profession.') ||
      (!p.country && 'Please enter your country of practice.') ||
      (!p.consent && 'Please confirm you have read the privacy notice and agree to take part.');
    if (problem) {
      err.textContent = problem;
      err.classList.remove('hidden');
      return;
    }
    err.classList.add('hidden');
    p.email = p.email.toLowerCase();
    state.participant = p;
    if (!state.startedAt) state.startedAt = new Date().toISOString();
    state.progress.dirty = true;
    saveState();
    showStage('survey');
  });

  document.getElementById('section-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-section]');
    if (!b) return;
    const idx = items.findIndex((i) => i.section === b.dataset.section);
    if (idx >= 0) { state.returnToReview = false; goTo(idx); }
  });

  document.getElementById('btn-prev').addEventListener('click', () => {
    if (state.idx > 0) { state.returnToReview = false; goTo(state.idx - 1); }
  });
  document.getElementById('btn-next').addEventListener('click', handleNext);
  document.getElementById('btn-to-review').addEventListener('click', () => {
    state.returnToReview = false;
    maybeSaveProgress();
    saveState();
    showStage('review');
  });
  document.getElementById('btn-review-back').addEventListener('click', () => {
    const firstMissing = missingRequired()[0];
    state.idx = firstMissing ? items.indexOf(firstMissing) : 0;
    saveState();
    showStage('survey');
  });
  document.getElementById('btn-submit').addEventListener('click', submitResponses);
  document.getElementById('btn-print').addEventListener('click', () => window.print());
  document.getElementById('btn-clear').addEventListener('click', () =>
    document.getElementById('clear-confirm').classList.remove('hidden')
  );
  document.getElementById('btn-clear-yes').addEventListener('click', () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    state = initialState();
    document.getElementById('clear-confirm').classList.add('hidden');
    showStage('welcome');
  });
}
