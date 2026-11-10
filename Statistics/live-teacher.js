// Live polling for the review pages' Class mode (teacher side).
// The review page's own script calls window.LIVE; this module owns the
// live bar, the join panel and the results panel.
import { firebaseConfig, FIREBASE_VERSION } from './live-config.js';

const LETTERS = ['A', 'B', 'C', 'D', 'E'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I or O, which look like 1 and 0
const SAVE_KEY = 'liveSessionV1';
const LIVE = window.LIVE = {
  ready: false, error: '', user: null, code: null, open: false,
  joined: 0, answered: 0, counts: {}, log: {}, order: [], qn: -1, lastKey: null
};
let F = null;            // Firebase functions once loaded
let auth = null, db = null, sessionRef = null, endedRef = null;
let unsubAnswers = null, unsubMembers = null;
const $ = id => document.getElementById(id);
const changed = () => window.dispatchEvent(new Event('live-change'));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function load() {
  try {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
    const [app, au, fs] = await Promise.all([
      import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')
    ]);
    F = { ...au, ...fs };
    const a = app.initializeApp(firebaseConfig);
    auth = au.getAuth(a);
    db = fs.getFirestore(a);
    au.onAuthStateChanged(auth, u => { LIVE.user = u && !u.isAnonymous ? u : null; changed(); });
    LIVE.ready = true;
  } catch (e) {
    LIVE.error = 'Live polling is unavailable: this computer could not reach Firebase.';
  }
  changed();
}

function explain(e) {
  if (e && e.code === 'permission-denied') return 'Firebase refused the request. Check that your Google email is in the security rules (setup doc, Step 4) and that the rules are published.';
  if (e && e.code === 'auth/popup-blocked') return 'The browser blocked the sign-in window. Allow pop-ups for this site and try again.';
  if (e && e.code === 'auth/unauthorized-domain') return 'This website is not on the Authorized domains list in Firebase (setup doc, Step 5).';
  if (e && (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) return 'Sign-in was cancelled.';
  return 'Something went wrong talking to Firebase' + (e && e.code ? ' (' + e.code + ')' : '') + '.';
}
function setMsg(text) { LIVE.error = text || ''; changed(); }

LIVE.isActive = () => !!sessionRef;

LIVE.signIn = async function () {
  try { const r = await F.signInWithPopup(auth, new F.GoogleAuthProvider()); LIVE.user = r.user; changed(); return true; }
  catch (e) { setMsg(explain(e)); return false; }
};

function newCode() { let s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }

// Start (or resume) a live session. Resolves true when students can join.
LIVE.start = async function () {
  if (!LIVE.ready) return false;
  setMsg('');
  if (!LIVE.user && !(await LIVE.signIn())) return false;
  try {
    let saved = null;
    try { saved = localStorage.getItem(SAVE_KEY); } catch (e) {}
    if (saved) {
      const ref = F.doc(db, 'sessions', saved), snap = await F.getDoc(ref);
      const d = snap.exists() ? snap.data() : null;
      if (d && d.host === LIVE.user.uid && !d.ended) { sessionRef = ref; LIVE.code = saved; LIVE.qn = (d.asked || 0) - 1; }
    }
    if (!sessionRef) {
      let code = null;
      for (let tries = 0; tries < 8 && !code; tries++) {
        const c = newCode(), snap = await F.getDoc(F.doc(db, 'sessions', c));
        if (!snap.exists()) code = c;
      }
      if (!code) throw new Error('no free code');
      sessionRef = F.doc(db, 'sessions', code);
      await F.setDoc(sessionRef, { host: LIVE.user.uid, created: F.serverTimestamp(), open: false, q: -1, asked: 0, qtext: '', opts: [], label: '', ended: false });
      LIVE.code = code; LIVE.qn = -1; LIVE.log = {}; LIVE.order = [];
      try { localStorage.setItem(SAVE_KEY, code); } catch (e) {}
    }
    LIVE.lastKey = null;
    if (unsubMembers) unsubMembers();
    unsubMembers = F.onSnapshot(F.collection(sessionRef, 'members'), s => { LIVE.joined = s.size; drawBar(); });
    showJoin(true);
    drawBar();
    changed();
    return true;
  } catch (e) { setMsg(explain(e)); sessionRef = null; LIVE.code = null; return false; }
};

// Open a question for answers. `key` identifies it so a redraw does not reopen it.
LIVE.question = async function (q) {
  if (!sessionRef || q.key === LIVE.lastKey) return;
  LIVE.lastKey = q.key;
  LIVE.qn += 1;
  const n = LIVE.qn;
  LIVE.counts = {}; LIVE.answered = 0; LIVE.open = true;
  const oe = $('opts'); if (oe) oe.classList.remove('lvon');
  LIVE.log[n] = { text: q.text, opts: q.opts, correct: q.correct, label: q.label, counts: {}, total: 0 };
  LIVE.order.push(n);
  if (unsubAnswers) unsubAnswers();
  unsubAnswers = F.onSnapshot(F.query(F.collection(sessionRef, 'answers'), F.where('q', '==', n)), s => {
    const c = {}; s.forEach(d => { const ch = d.data().choice; c[ch] = (c[ch] || 0) + 1; });
    if (LIVE.qn !== n) return;
    LIVE.counts = c; LIVE.answered = s.size;
    if (LIVE.log[n]) { LIVE.log[n].counts = c; LIVE.log[n].total = s.size; }
    drawBar();
  }, () => {});
  drawBar();
  try { await F.updateDoc(sessionRef, { q: n, asked: n + 1, open: true, qtext: q.text, opts: q.opts, label: q.label }); }
  catch (e) { setMsg(explain(e)); }
};

// Close the current question. Resolves with the final counts.
LIVE.close = async function () {
  if (!sessionRef) return {};
  LIVE.open = false;
  drawBar();
  try { await F.updateDoc(sessionRef, { open: false }); } catch (e) { setMsg(explain(e)); }
  return LIVE.counts;
};

// After a reveal, draw a count bar inside each answer button.
LIVE.decorate = function (optsEl) {
  const e = LIVE.log[LIVE.qn];
  if (!e || !optsEl) return;
  const total = e.total || 0;
  optsEl.classList.add('lvon');
  optsEl.querySelectorAll('button.opt').forEach((b, i) => {
    const n = e.counts[LETTERS[i]] || 0, pct = total ? Math.round(100 * n / total) : 0;
    const wrap = document.createElement('span');
    wrap.className = 'lvwrap';
    wrap.innerHTML = '<span class="lvtrack"><span class="lvfill" style="width:' + pct + '%"></span></span><span class="lvnum">' + n + ' (' + pct + '%)</span>';
    b.appendChild(wrap);
    b.setAttribute('aria-label', (b.getAttribute('aria-label') || '') + ', ' + n + ' students, ' + pct + ' percent');
  });
};

LIVE.showBar = function (on) { const b = $('liveBar'); if (b) b.classList.toggle('hidden', !on || !sessionRef); if (!on) showJoin(false, true); };

function joinUrl() { return new URL('live.html?room=' + LIVE.code, location.href).href; }
let joinVisible = false;
function showJoin(on, keepState) {
  const p = $('liveJoin'); if (!p) return;
  if (!keepState) joinVisible = on;
  const show = on && !!sessionRef;
  p.classList.toggle('hidden', !show);
  if (!show) return;
  const url = joinUrl();
  p.innerHTML = '<div class="lvqr" id="liveQr" aria-hidden="true"></div><div class="lvjoin-text"><p class="lvlabel">Scan to answer on your phone</p>' +
    '<p class="lvcode" aria-label="Room code ' + esc(LIVE.code.split('').join(' ')) + '">' + esc(LIVE.code) + '</p>' +
    '<p class="lvurl">' + esc(url.replace(/^https?:\/\//, '')) + '</p></div>';
  try { new window.QRCode($('liveQr'), { text: url, width: 220, height: 220, correctLevel: window.QRCode.CorrectLevel.M }); }
  catch (e) { $('liveQr').textContent = ''; }
}
function drawBar() {
  const b = $('liveBar'); if (!b || !sessionRef) return;
  b.innerHTML = '<span><b>Room ' + esc(LIVE.code) + '</b></span><span>' + LIVE.joined + ' joined</span>' +
    '<span>' + LIVE.answered + ' answered' + (LIVE.open ? '' : ' · closed') + '</span>' +
    '<button type="button" class="btn quiet lvsmall" id="liveJoinBtn">' + (joinVisible ? 'Hide join code' : 'Show join code') + '</button>';
  $('liveJoinBtn').onclick = () => { showJoin(!joinVisible); drawBar(); };
  b.setAttribute('aria-live', 'polite');
}

// End the round: close answers, keep the results on screen.
LIVE.end = async function () {
  if (!sessionRef) return;
  if (unsubAnswers) { unsubAnswers(); unsubAnswers = null; }
  if (unsubMembers) { unsubMembers(); unsubMembers = null; }
  try { await F.updateDoc(sessionRef, { open: false, ended: true }); } catch (e) {}
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  LIVE.open = false;
  endedRef = sessionRef; sessionRef = null;
  renderResults();
  LIVE.showBar(false);
};

function rows() {
  return LIVE.order.map(n => {
    const e = LIVE.log[n], total = e.total || 0, right = e.counts[LETTERS[e.correct]] || 0;
    return { n, e, total, right, pct: total ? Math.round(100 * right / total) : null };
  });
}
function renderResults() {
  const box = $('liveResults'); if (!box) return;
  const list = rows().sort((a, b) => (a.pct === null ? 101 : a.pct) - (b.pct === null ? 101 : b.pct));
  let h = '<h2>Live results, room ' + esc(LIVE.code) + '</h2><p class="lede">Questions the class missed most come first. Counts are anonymous.</p>';
  if (!list.length) h += '<p class="lede">No questions were asked in this session.</p>';
  else {
    h += '<div class="lvtable"><table><caption class="sr">Live results by question</caption><thead><tr><th scope="col">Question</th><th scope="col">Answer</th>' +
      LETTERS.slice(0, Math.max(...list.map(r => r.e.opts.length))).map(l => '<th scope="col">' + l + '</th>').join('') +
      '<th scope="col">Correct</th></tr></thead><tbody>';
    list.forEach(r => {
      h += '<tr><th scope="row">' + esc(r.e.text) + '</th><td>' + LETTERS[r.e.correct] + '</td>' +
        r.e.opts.map((_, i) => '<td>' + (r.e.counts[LETTERS[i]] || 0) + '</td>').join('') +
        '<td>' + (r.pct === null ? 'no answers' : r.pct + '% of ' + r.total) + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }
  h += '<div class="btnrow"><button type="button" class="btn" id="liveCsv">Download results</button>' +
    '<button type="button" class="btn quiet" id="liveDelete">Delete session data</button>' +
    '<span class="lvmsg" id="liveDelMsg" role="status"></span></div>';
  box.innerHTML = h;
  box.classList.remove('hidden');
  $('liveCsv').onclick = downloadCsv;
  $('liveDelete').onclick = deleteData;
}
function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function downloadCsv() {
  const head = ['Order', 'Lesson', 'Question', 'Correct answer', 'A', 'B', 'C', 'D', 'E', 'Answered', 'Percent correct'];
  const lines = [head.join(',')].concat(rows().map(r => [r.n + 1, r.e.label, r.e.text, LETTERS[r.e.correct],
    ...LETTERS.map(l => r.e.counts[l] || 0), r.total, r.pct === null ? '' : r.pct].map(csvCell).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'live-results-' + LIVE.code + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function deleteData() {
  const msg = $('liveDelMsg');
  if (!endedRef) { msg.textContent = 'Already deleted.'; return; }
  const ref = endedRef;
  msg.textContent = 'Deleting…';
  try {
    for (const sub of ['answers', 'members']) {
      const snap = await F.getDocs(F.collection(ref, sub));
      const docs = []; snap.forEach(d => docs.push(d.ref));
      for (let i = 0; i < docs.length; i += 400) {
        const b = F.writeBatch(db); docs.slice(i, i + 400).forEach(r => b.delete(r)); await b.commit();
      }
    }
    await F.deleteDoc(ref);
    endedRef = null;
    msg.textContent = 'Deleted from Firebase. This summary stays until you leave the page.';
  } catch (e) { msg.textContent = explain(e); }
}

load();
