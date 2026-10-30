// Pairwise video comparison study (user-study smoke run). Adapted from the owner's pairwise_comparison.js:
// same layout, video sync manager, progress saving and navigation; the Formspree submit is replaced by the pluggable
// StudyCore.submit (CONFIG.submit = 'download' | 'mock' | 'worker'); no names or emails; per-rater order and sides from StudyCore.

const CONFIG = Object.assign({ submit: 'download', endpoint: '' }, window.STUDY_CONFIG || {});
const Core = window.StudyCore;
const STORE = 'ustudy-smoke-v1:';
const AUTO_SAVE_INTERVAL = 30000;

let studyData = null;
let state = null;
let items = {};
let saveTimeout = null;
let onSubmissionForm = false;
let preloaded = {};

const comparisonContainer = document.getElementById('comparison-container');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const progressBar = document.getElementById('progress-bar');
const progressCount = document.getElementById('progress-count');
const saveStatus = document.getElementById('save-status');
const submissionForm = document.getElementById('submission-form');
const submitBtn = document.getElementById('submit-btn');
const submitStatus = document.getElementById('submit-status');
const submitExplain = document.getElementById('submit-explain');
const submissionSuccess = document.getElementById('submission-success');
const successDetail = document.getElementById('success-detail');
const exportBtn = document.getElementById('export-btn');
const replayBtn = document.getElementById('replay-btn');
const instructionsBtn = document.getElementById('instructions-btn');
const instructionsPanel = document.getElementById('instructions');

const QTEXT = {
    q1_edit: 'Compared with the reference, which video makes the change the instruction asks for?',
    q1_copy: 'Which video reproduces the reference performance more faithfully?',
    q2: 'Apart from the requested change, which video keeps the reference performance better (steps, rhythm, posture, arm swing)?',
    q3: 'Which is the better result overall: the person and scene of the photo, natural motion, image quality?'
};
const OPTIONS = [['A', 'A better'], ['S', 'About the same'], ['B', 'B better']];

function nowIso() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }

function safeGet(k) { try { return window.localStorage.getItem(STORE + k); } catch (e) { return null; } }
function safeSet(k, v) { try { window.localStorage.setItem(STORE + k, v); return true; } catch (e) { return false; } }

function escapeHTML(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

// Rater id: ?rid=... (anonymous code) or a random id kept in this browser.
function resolveRid() {
    let param = null;
    try { param = new URLSearchParams(window.location.search).get('rid'); } catch (e) { param = null; }
    const fromUrl = Core.sanitizeRid(param);
    if (fromUrl) { return { rid: fromUrl, source: 'url', note: '' }; }
    let rid = Core.sanitizeRid(safeGet('rid'));
    if (!rid) {
        const bytes = new Uint8Array(10);
        if (window.crypto && window.crypto.getRandomValues) { window.crypto.getRandomValues(bytes); }
        else { for (let i = 0; i < bytes.length; i++) { bytes[i] = Math.floor(Math.random() * 256); } }
        rid = Core.newRid(bytes);
        safeSet('rid', rid);
    }
    return { rid: rid, source: 'generated', note: param ? '(the rid in the link was not valid; a random id is used)' : '' };
}

async function loadStudyData() {
    try {
        const response = await fetch('study_data.json', { cache: 'no-cache' });
        if (!response.ok) { throw new Error('HTTP ' + response.status); }
        return await response.json();
    } catch (error) {
        comparisonContainer.innerHTML = `<div class="alert alert-danger"><strong>Error:</strong> Failed to load the study data. Please refresh the page.
            <br><small>${escapeHTML(error.message)}</small></div>`;
        return null;
    }
}

function saveProgress(isAutoSave = false) {
    if (!state) { return; }
    const ok = safeSet('state:' + state.rid, JSON.stringify(state));
    if (!isAutoSave && ok) { showSaveStatus('Progress saved', 'saved'); }
    scheduleAutoSave();
}

function scheduleAutoSave() {
    if (saveTimeout) { clearTimeout(saveTimeout); }
    saveTimeout = setTimeout(() => saveProgress(true), AUTO_SAVE_INTERVAL);
}

function loadProgress(rid) {
    const saved = safeGet('state:' + rid);
    if (!saved) { return null; }
    try {
        const s = JSON.parse(saved);
        if (!Core.stateMatches(s, studyData, rid)) { return null; }
        s.shownCmp = null; s.shownAt = null;           // a visit from an earlier page load is closed
        return s;
    } catch (e) {
        return null;
    }
}

function showSaveStatus(message, type) {
    saveStatus.textContent = message;
    saveStatus.className = `save-status visible ${type}`;
    setTimeout(() => { saveStatus.classList.remove('visible'); }, 2000);
}

function currentPlan() { return state.plan[state.idx]; }

function optionButtons(q, current) {
    return OPTIONS.map(([v, label]) => `
        <button class="btn option-button ${current === v ? 'selected btn-primary' : 'btn-outline-primary'}" data-question="${q}" data-value="${v}">${label}</button>`).join('');
}

function renderComparison(index) {
    const p = state.plan[index];
    const item = items[p.item];
    const ans = state.answers[p.cmp] || {};
    const qs = Core.questionsFor(item);
    const urlA = item.clips[p.left];
    const urlB = item.clips[p.right];
    // no per-video controls: the three videos are driven together (sync manager + the one "Play from start" control)
    const vid = (id, src) => `<video id="${id}" autoplay muted playsinline preload="auto" disablepictureinpicture>
                        <source src="${escapeHTML(src)}" type="video/mp4">
                    </video>`;
    const rowHTML = `
        <div class="t-line" title="${escapeHTML(item.T)}"><i class="bi bi-chat-left-text"></i> Text instruction: <span class="t-text">${escapeHTML(item.T)}</span></div>
        <div class="row4">
            <div class="tile"><div class="tile-label in">Photo (first frame)</div><div class="video-wrapper"><img src="${escapeHTML(item.I)}" alt="photo"></div></div>
            <div class="tile"><div class="tile-label in">Reference video</div><div class="video-wrapper">${vid('reference-video', item.R)}</div></div>
            <div class="tile"><div class="tile-label">Video A</div><div class="video-wrapper">${vid('video-a', urlA)}</div></div>
            <div class="tile"><div class="tile-label">Video B</div><div class="video-wrapper">${vid('video-b', urlB)}</div></div>
        </div>`;
    const rows = qs.map(q => {
        const text = q === 'q1' ? (item.kind === 'copy' ? QTEXT.q1_copy : QTEXT.q1_edit) : QTEXT[q];
        return `<div class="qrow"><div class="qtext">${escapeHTML(text)}</div><div class="qbtns">${optionButtons(q, ans[q])}</div></div>`;
    }).join('');
    comparisonContainer.innerHTML = `${rowHTML}<div class="qblock">${rows}</div>`;

    document.querySelectorAll('.option-button').forEach(button => {
        button.addEventListener('click', function () { selectAnswer(this.dataset.question, this.dataset.value); });
    });

    synchronizeVideos();
    updateUIState();
    if (document.visibilityState !== 'hidden') { Core.enter(state, p.cmp, nowMs()); }
}

// One play/restart control: the reference and both outputs restart together from the first frame.
function replayAll() {
    const vids = ['reference-video', 'video-a', 'video-b'].map(id => document.getElementById(id)).filter(Boolean);
    const m = window._pairwiseSync && window._pairwiseSync.manager;
    if (m) m.isRestarting = true;
    vids.forEach(v => { try { v.pause(); v.currentTime = 0; } catch (e) {} });
    vids.forEach(v => { try { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {} });
    setTimeout(() => { if (m) m.isRestarting = false; }, 300);
}

function toggleInstructions(show) {
    const open = typeof show === 'boolean' ? show : instructionsPanel.style.display === 'none';
    instructionsPanel.style.display = open ? 'block' : 'none';
    instructionsBtn.textContent = open ? 'Hide instructions' : 'Instructions';
}

function selectAnswer(question, value) {
    const p = currentPlan();
    Core.setAnswer(state, p.cmp, question, value, nowIso());
    const selected = document.querySelector(`[data-question="${question}"][data-value="${value}"]`);
    if (selected) {
        const card = selected.closest('.qrow');
        if (card) {
            card.querySelectorAll('.option-button').forEach(btn => {
                btn.classList.remove('selected', 'btn-primary');
                btn.classList.add('btn-outline-primary');
            });
        }
        selected.classList.add('selected', 'btn-primary');
        selected.classList.remove('btn-outline-primary');
    }
    saveProgress();
    updateUIState();
}

// Video sync manager (owner's code, unchanged apart from the element list): all videos of a comparison play, end and restart together.
function synchronizeVideos() {
    if (!window._pairwiseSync) window._pairwiseSync = {};
    const existing = window._pairwiseSync.manager;
    if (existing && typeof existing.cleanup === 'function') {
        try { existing.cleanup(); } catch (e) { console.warn('[synchronizeVideos] cleanup error', e); }
    }
    const currentVideos = [
        document.getElementById('reference-video'),
        document.getElementById('video-a'),
        document.getElementById('video-b')
    ].filter(Boolean);
    if (currentVideos.length === 0) {
        window._pairwiseSync.manager = { cleanup: () => {} };
        return;
    }
    const manager = {
        videos: currentVideos.slice(),
        handlers: new Map(),
        intervalId: null,
        visibilityHandler: null,
        isRestarting: false,
        cleanup() {
            this.videos.forEach(v => {
                const map = this.handlers.get(v);
                if (map) {
                    for (const [ev, fn] of Object.entries(map)) { try { v.removeEventListener(ev, fn); } catch (e) {} }
                    this.handlers.delete(v);
                }
                try { delete v.dataset._syncAttached; } catch (e) {}
            });
            if (this.visibilityHandler) {
                try { document.removeEventListener('visibilitychange', this.visibilityHandler); } catch (e) {}
                this.visibilityHandler = null;
            }
            if (this.intervalId) { try { clearInterval(this.intervalId); } catch (e) {} this.intervalId = null; }
        }
    };
    const endedMap = new Map();
    manager.videos.forEach(v => endedMap.set(v, false));
    function isNearEnd(video) {
        try {
            const duration = video.duration;
            if (!isFinite(duration) || duration <= 0) return false;
            return video.currentTime >= (duration - 0.2);
        } catch (e) { return false; }
    }
    function playAllWithRetry(attempt = 0) {
        const MAX_ATTEMPT = 4;
        let anyRejected = false;
        manager.videos.forEach(v => {
            try {
                try { v.muted = true; v.playsInline = true; } catch (e) {}
                const p = v.play();
                if (p && typeof p.then === 'function') { p.catch(() => { anyRejected = true; }); }
            } catch (err) { anyRejected = true; }
        });
        if (anyRejected && attempt < MAX_ATTEMPT) {
            setTimeout(() => playAllWithRetry(attempt + 1), 200 * Math.pow(2, attempt));
        }
    }
    function restartAll() {
        try {
            if (manager.isRestarting) return;
            manager.isRestarting = true;
            manager.videos.forEach(v => {
                endedMap.set(v, false);
                try {
                    v.pause();
                    try { v.currentTime = 0.001; } catch (e) { try { v.currentTime = 0; } catch (ee) {} }
                } catch (e) {}
            });
            setTimeout(() => {
                playAllWithRetry(0);
                setTimeout(() => { manager.isRestarting = false; }, 100);
            }, 120);
        } catch (e) { manager.isRestarting = false; }
    }
    function allEndedOrNear() {
        for (const v of manager.videos) { if (!(v.ended || endedMap.get(v) || isNearEnd(v))) return false; }
        return true;
    }
    manager.videos.forEach(v => {
        const handlers = {};
        handlers.ended = () => {
            endedMap.set(v, true);
            if (!manager.isRestarting && allEndedOrNear()) {
                setTimeout(() => { if (!manager.isRestarting && allEndedOrNear()) restartAll(); }, 0);
            }
        };
        v.addEventListener('ended', handlers.ended);
        handlers.play = () => { manager.videos.forEach(o => { if (o !== v) { o.play && o.play().catch(() => {}); } }); };
        v.addEventListener('play', handlers.play);
        handlers.pause = () => {
            if (manager.isRestarting) return;
            if (v.ended || isNearEnd(v)) return;
            manager.videos.forEach(o => { if (o !== v && !o.paused) o.pause && o.pause(); });
        };
        v.addEventListener('pause', handlers.pause);
        handlers.error = () => { playAllWithRetry(0); };
        v.addEventListener('error', handlers.error);
        v.addEventListener('stalled', handlers.error);
        v.addEventListener('suspend', handlers.error);
        try { v.dataset._syncAttached = '1'; } catch (e) {}
        manager.handlers.set(v, handlers);
    });
    manager.visibilityHandler = () => {
        if (document.visibilityState === 'visible') {
            const noneEnded = manager.videos.every(vid => !vid.ended);
            const allPaused = manager.videos.every(vid => vid.paused);
            if (allPaused && noneEnded) playAllWithRetry(0);
        }
    };
    document.addEventListener('visibilitychange', manager.visibilityHandler);
    manager.intervalId = setInterval(() => {
        try {
            const vids = manager.videos.filter(Boolean);
            if (vids.length === 0 || manager.isRestarting) return;
            const allPaused = vids.every(v => v.paused);
            const anyEnded = vids.some(v => v.ended || isNearEnd(v));
            const allEnded = vids.every(v => v.ended || isNearEnd(v));
            const somePaused = vids.some(v => v.paused);
            const somePlaying = vids.some(v => !v.paused);
            if (allEnded) { restartAll(); return; }
            if (allPaused && anyEnded) { restartAll(); return; }
            if (somePaused && somePlaying && !anyEnded) { playAllWithRetry(0); return; }
            if (allPaused && !anyEnded) { playAllWithRetry(0); }
        } catch (e) {}
    }, 500);
    manager.videos.forEach(v => {
        try {
            v.muted = true; v.playsInline = true; v.preload = 'auto';
            if (!endedMap.has(v)) endedMap.set(v, false);
            try { v.currentTime = 0.001; } catch (e) { try { v.currentTime = 0; } catch (ee) {} }
        } catch (e) {}
    });
    setTimeout(() => playAllWithRetry(0), 150);
    window._pairwiseSync.manager = manager;
}

function updateUIState() {
    const p = currentPlan();
    const allAnswered = Core.isComplete(state, studyData, p.cmp);
    nextBtn.disabled = !allAnswered;
    const hint = document.getElementById('next-btn-hint');
    const last = state.idx === state.plan.length - 1;
    nextBtn.innerHTML = last ? 'Finish <i class="bi bi-check-circle"></i>' : 'Next <i class="bi bi-arrow-right"></i>';
    if (hint) {
        hint.innerHTML = `<i class="bi bi-exclamation-circle"></i> Please answer every question to ${last ? 'finish' : 'proceed'}`;
        if (allAnswered) { hint.classList.remove('show'); } else { hint.classList.add('show'); }
    }
    prevBtn.disabled = state.idx === 0;
}

function updateProgressBar() {
    const n = state.plan.length;
    progressBar.style.width = `${((state.idx + 1) / n) * 100}%`;
    progressCount.textContent = `Comparison ${state.idx + 1} of ${n}`;
}

function showComparisonView() {
    onSubmissionForm = false;
    submissionForm.style.display = 'none';
    comparisonContainer.style.display = 'block';
    prevBtn.style.display = 'inline-block';
    prevBtn.innerHTML = '<i class="bi bi-arrow-left"></i> Previous';
    nextBtn.style.display = 'inline-block';
    replayBtn.style.display = 'inline-block';
    const hint = document.getElementById('next-btn-hint');
    if (hint) hint.style.display = '';
}

function goToPrevious() {
    if (onSubmissionForm) {
        showComparisonView();
        renderComparison(state.idx);
        updateProgressBar();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        saveProgress();
        return;
    }
    if (state.idx > 0) {
        Core.leave(state, nowMs());
        state.idx--;
        renderComparison(state.idx);
        updateProgressBar();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        saveProgress();
    }
}

function goToNext() {
    const p = currentPlan();
    if (!Core.isComplete(state, studyData, p.cmp)) {
        alert('Please answer every question before continuing.');
        return;
    }
    Core.leave(state, nowMs());
    if (state.idx < state.plan.length - 1) {
        state.idx++;
        toggleInstructions(false);
        renderComparison(state.idx);
        updateProgressBar();
        preloadNextVideos(state.idx + 1);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        saveProgress();
    } else {
        saveProgress();
        showSubmissionForm();
    }
}

function preloadNextVideos(nextIndex) {
    if (nextIndex >= state.plan.length) return;
    const p = state.plan[nextIndex];
    if (preloaded[p.cmp]) return;
    preloaded[p.cmp] = true;
    const item = items[p.item];
    [item.R, item.clips[p.left], item.clips[p.right]].forEach(url => {
        const v = document.createElement('video');
        v.style.display = 'none'; v.muted = true; v.preload = 'metadata'; v.src = url;
        document.body.appendChild(v);
        setTimeout(() => { if (document.body.contains(v)) document.body.removeChild(v); }, 15000);
    });
}

function showSubmissionForm() {
    onSubmissionForm = true;
    comparisonContainer.style.display = 'none';
    nextBtn.style.display = 'none';
    replayBtn.style.display = 'none';
    const hint = document.getElementById('next-btn-hint');
    if (hint) hint.style.display = 'none';
    prevBtn.style.display = 'inline-block';
    prevBtn.innerHTML = '<i class="bi bi-arrow-left"></i> Back to review';
    prevBtn.disabled = false;
    if (CONFIG.submit === 'download') {
        submitBtn.textContent = 'Download answers (JSON)';
        submitExplain.textContent = 'Click the button to save your answers as a JSON file, then send the file to the study organiser.';
    } else {
        submitBtn.textContent = 'Submit answers';
        submitExplain.textContent = 'Click the button to send your answers.';
    }
    submissionForm.style.display = 'block';
}

function downloadText(name, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { if (document.body.contains(a)) document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

function currentPayload(mode) {
    return Core.buildPayload(state, studyData, { userAgent: navigator.userAgent, nowIso: nowIso(), mode: mode });
}

function submitResponses() {
    const payload = currentPayload(CONFIG.submit);
    submitBtn.disabled = true;
    submitStatus.textContent = CONFIG.submit === 'download' ? '' : 'Submitting...';
    Core.submit(payload, CONFIG, { fetch: (u, o) => window.fetch(u, o), download: downloadText })
        .then(res => {
            state.finished = true;
            saveProgress(true);
            submissionForm.style.display = 'none';
            submissionSuccess.style.display = 'block';
            successDetail.textContent = res.mode === 'download'
                ? `Your answers were saved as ${Core.payloadFilename(payload)}. Please send this file to the study organiser.`
                : 'Your responses have been recorded.';
        })
        .catch(error => {
            submitBtn.disabled = false;
            submitStatus.textContent = 'Submission failed (' + error.message + '). Your answers are kept in this browser; use "Export answers so far" below to save them as a file.';
        });
}

function exportAnswers() {
    if (!state) return;
    Core.leave(state, nowMs());
    const payload = currentPayload('export');
    downloadText(Core.payloadFilename(payload), JSON.stringify(payload, null, 1));
    if (!onSubmissionForm && document.visibilityState !== 'hidden') { Core.enter(state, currentPlan().cmp, nowMs()); }
}

document.addEventListener('visibilitychange', () => {
    if (!state || onSubmissionForm) return;
    if (document.visibilityState === 'hidden') { Core.leave(state, nowMs()); saveProgress(true); }
    else { Core.enter(state, currentPlan().cmp, nowMs()); }
});

document.addEventListener('DOMContentLoaded', async function () {
    const r = resolveRid();
    document.getElementById('rater-id').textContent = r.rid;
    document.getElementById('rater-hint').textContent = r.source === 'generated'
        ? (r.note || '') + ' To resume on another device, open this page with ?rid=' + r.rid
        : '';
    studyData = await loadStudyData();
    if (!studyData) return;
    items = Core.itemIndex(studyData);
    state = loadProgress(r.rid) || Core.newState(studyData, r.rid, r.source, nowIso());
    if (state.idx >= state.plan.length) state.idx = state.plan.length - 1;
    prevBtn.addEventListener('click', goToPrevious);
    nextBtn.addEventListener('click', goToNext);
    submitBtn.addEventListener('click', submitResponses);
    exportBtn.addEventListener('click', exportAnswers);
    replayBtn.addEventListener('click', replayAll);
    instructionsBtn.addEventListener('click', () => toggleInstructions());
    toggleInstructions(Object.keys(state.answers).length === 0);
    renderComparison(state.idx);
    updateProgressBar();
    preloadNextVideos(state.idx + 1);
    saveProgress(true);
});

window.addEventListener('beforeunload', function (e) {
    if (!state) return;
    if (!onSubmissionForm) { Core.leave(state, nowMs()); }
    saveProgress(true);
    if (!onSubmissionForm && document.visibilityState !== 'hidden') { Core.enter(state, currentPlan().cmp, nowMs()); }   // rater may stay
    const started = Object.keys(state.answers).length > 0;
    if (started && !state.finished) {
        e.preventDefault();
        e.returnValue = 'Your answers are saved in this browser, but not submitted yet.';
        return e.returnValue;
    }
});
