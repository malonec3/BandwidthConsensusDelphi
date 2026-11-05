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
  INSTRUMENT_VERSION: '2026-10-29',
  CSV_PATH: './delphi_statements.csv',

  // From Supabase > Project Settings > API (the publishable / anon key).
  SUPABASE_URL: 'https://kxkzbydqtdzvkkzlvylf.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_HW2LexdXVvl7Kef9fTjvHw_y1gM6CfT',
  SUPABASE_TABLE: 'delphi_responses',

  // Require a rating (1-5 or U) for every rated statement before moving on.
  REQUIRE_RATING: true,
  COMMENT_MAX_LENGTH: 3000
};
const STORAGE_KEY = `delphi_contours_round${CONFIG.ROUND}_v1`;

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
let items = []; // [{ id, order, section, sectionTitle, sectionIntro, type, text, options, consensus, feedback }]
let sections = []; // [{ id, title, intro, items: [] }]
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
  document.getElementById('loading-state').classList.add('hidden');

  const saved = loadState();
  if (saved) state = saved;
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
      feedback: (r.feedback || '').trim()
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
    if (r.choice === 'Other') return `Other: ${(r.other || '').trim() || '(not specified)'}`;
    return r.choice;
  }
  return '';
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
      <h2 class="text-lg sm:text-xl font-semibold text-slate-900 leading-snug">${escapeHTML(item.text)}</h2>
    </div>
    ${item.feedback ? `<div class="mt-4 text-sm bg-sky-50 border border-sky-200 rounded-xl px-4 py-3 text-brand-navy"><span class="font-bold block text-xs uppercase tracking-wider mb-1">Previous round — group result</span>${escapeHTML(item.feedback)}</div>` : ''}
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
    const opts = item.options.map((o) => ({ value: o, label: o }));
    opts.push({ value: 'U', label: 'Unable to answer' });
    body += `
      <fieldset class="mt-6">
        <legend class="text-sm font-semibold text-slate-800 mb-2">Choose one</legend>
        <div class="space-y-2" role="radiogroup">
          ${opts.map((o) => choiceButton(o, r.choice === o.value)).join('')}
        </div>
        <div id="other-wrap" class="${r.choice === 'Other' ? '' : 'hidden'} mt-3">
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
      card.querySelector('#other-wrap').classList.toggle('hidden', btn.dataset.choice !== 'Other');
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
              <p class="text-sm text-slate-800"><span class="font-bold text-brand-navy mr-1">${escapeHTML(it.id)}</span>${escapeHTML(it.text)}</p>
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
      rating: it.type === 'rating' ? r.rating || null : null,
      text: it.type === 'open' ? (r.text || '').trim() || null : null,
      choice: it.type === 'choice' ? r.choice || null : null,
      other: it.type === 'choice' && r.choice === 'Other' ? (r.other || '').trim() || null : null,
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
