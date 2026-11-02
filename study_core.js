/* User-study smoke page: core logic with no DOM, shared by the page (window.StudyCore) and by node (require) for the scripted round-trip.
   Per-rater seeded comparison order and A/B sides, answers, watch time, the submission payload and a pluggable submit
   (CONFIG.submit = 'download' | 'mock' | 'worker'). Methods appear only as opaque codes. */
(function (root, factory) {
    var m = factory();
    if (typeof module === 'object' && module.exports) { module.exports = m; } else { root.StudyCore = m; }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var SCHEMA = 'ustudy-smoke-payload/v1';
    var STATE_SCHEMA = 'ustudy-smoke-state/v1';
    var QUESTIONS = ['q1', 'q2', 'q3', 'q4'];
    var ANSWERS = ['A', 'S', 'B'];          // A = left video better, S = about the same, B = right video better

    // Seeded PRNG: cyrb128 string hash -> sfc32 generator (deterministic per rater id).
    function cyrb128(str) {
        var h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
        for (var i = 0, k; i < str.length; i++) {
            k = str.charCodeAt(i);
            h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
            h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
            h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
            h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
        }
        h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
        h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
        h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
        h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
        h1 ^= (h2 ^ h3 ^ h4); h2 ^= h1; h3 ^= h1; h4 ^= h1;
        return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
    }
    function sfc32(a, b, c, d) {
        return function () {
            a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
            var t = (a + b) | 0;
            a = b ^ (b >>> 9);
            b = (c + (c << 3)) | 0;
            c = (c << 21) | (c >>> 11);
            d = (d + 1) | 0;
            t = (t + d) | 0;
            c = (c + t) | 0;
            return (t >>> 0) / 4294967296;
        };
    }
    function rng(seed) { var h = cyrb128(seed); return sfc32(h[0], h[1], h[2], h[3]); }

    // Rater ids are anonymous: letters, digits, '-' and '_' only (no names, no emails).
    function sanitizeRid(s) {
        if (typeof s !== 'string') { return null; }
        s = s.trim();
        return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : null;
    }
    function newRid(bytes) {
        var al = 'abcdefghjkmnpqrstuvwxyz23456789', out = 'r-';
        for (var i = 0; i < bytes.length; i++) { out += al[bytes[i] % al.length]; }
        return out;
    }

    function itemIndex(data) {
        var m = {};
        data.items.forEach(function (it) { m[it.id] = it; });
        return m;
    }
    function questionsFor(item) { return item.kind === 'copy' ? ['q2', 'q3', 'q4'] : ['q1', 'q2', 'q3', 'q4']; }   // owner 11/01: one question per concept; copy screens have no instruction question (q2 = reference motion on every screen)

    // Every rater sees every comparison; order and sides are shuffled with the rater id as the seed.
    function buildPlan(data, rid) {
        var r = rng(data.study + '|' + data.version + '|' + rid);
        var order = data.comparisons.slice();
        for (var i = order.length - 1; i > 0; i--) {
            var j = Math.floor(r() * (i + 1));
            var t = order[i]; order[i] = order[j]; order[j] = t;
        }
        return order.map(function (c, pos) {
            var swap = r() < 0.5;
            return { cmp: c.id, item: c.item, left: swap ? c.pair[1] : c.pair[0], right: swap ? c.pair[0] : c.pair[1], pos: pos };
        });
    }

    function newState(data, rid, ridSource, nowIso) {
        return { schema: STATE_SCHEMA, study: data.study, version: data.version, rid: rid, ridSource: ridSource, startedUtc: nowIso,
                 plan: buildPlan(data, rid), idx: 0, answers: {}, answeredUtc: {}, watchMs: {}, shownCmp: null, shownAt: null, finished: false };
    }
    function stateMatches(state, data, rid) {
        return !!state && state.schema === STATE_SCHEMA && state.study === data.study && state.version === data.version && state.rid === rid &&
            Array.isArray(state.plan) && state.plan.length === data.comparisons.length;
    }

    function setAnswer(state, cmpId, q, v, nowIso) {
        if (QUESTIONS.indexOf(q) < 0 || ANSWERS.indexOf(v) < 0) { throw new Error('bad answer ' + q + '=' + v); }
        var a = state.answers[cmpId] || (state.answers[cmpId] = {});
        a[q] = v;
        state.answeredUtc[cmpId] = nowIso;
    }
    function isComplete(state, data, cmpId) {
        var p = state.plan.filter(function (x) { return x.cmp === cmpId; })[0];
        if (!p) { return false; }
        var a = state.answers[cmpId] || {};
        return questionsFor(itemIndex(data)[p.item]).every(function (q) { return ANSWERS.indexOf(a[q]) >= 0; });
    }

    // Watch time: milliseconds a comparison is on screen while the page is visible (summed over visits).
    function leave(state, nowMs) {
        if (state.shownCmp !== null && state.shownAt !== null) {
            state.watchMs[state.shownCmp] = (state.watchMs[state.shownCmp] || 0) + Math.max(0, nowMs - state.shownAt);
        }
        state.shownCmp = null; state.shownAt = null;
    }
    function enter(state, cmpId, nowMs) {
        leave(state, nowMs);
        state.shownCmp = cmpId; state.shownAt = nowMs;
    }

    function buildPayload(state, data, env) {
        var items = itemIndex(data), nComplete = 0;
        var comps = state.plan.map(function (p) {
            var a = state.answers[p.cmp] || {}, qs = questionsFor(items[p.item]);
            var done = qs.every(function (q) { return ANSWERS.indexOf(a[q]) >= 0; });
            if (done) { nComplete++; }
            return { cmp: p.cmp, pos: p.pos, item: p.item, kind: items[p.item].kind, left: p.left, right: p.right,
                     q1: a.q1 || null, q2: qs.indexOf('q2') >= 0 ? (a.q2 || null) : null, q3: a.q3 || null, q4: a.q4 || null, complete: done,
                     watch_ms: Math.round(state.watchMs[p.cmp] || 0), answered_utc: state.answeredUtc[p.cmp] || null };
        });
        return { schema: SCHEMA, study: data.study, version: data.version, rater_id: state.rid, rid_source: state.ridSource,
                 user_agent: (env && env.userAgent) || '', started_utc: state.startedUtc, submitted_utc: (env && env.nowIso) || null,
                 submit_mode: (env && env.mode) || null, answer_codes: { A: 'left video better', S: 'about the same', B: 'right video better' },
                 n_comparisons: comps.length, n_complete: nComplete, comparisons: comps };
    }

    function payloadFilename(payload) { return 'ustudy_smoke_' + payload.rater_id + '.json'; }

    // Pluggable submit. 'download' always works (saves the answers JSON); 'mock' / 'worker' POST the payload to config.endpoint.
    function submit(payload, config, deps) {
        var mode = (config && config.submit) || 'download';
        var body = JSON.stringify(payload, null, 1);
        if (mode === 'download') {
            deps.download(payloadFilename(payload), body);
            return Promise.resolve({ ok: true, mode: mode });
        }
        if (mode === 'mock' || mode === 'worker') {
            if (!config.endpoint) { return Promise.reject(new Error('no endpoint configured')); }
            return deps.fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
                .then(function (r) {
                    return r.text().then(function (t) {
                        if (!r.ok) { throw new Error('HTTP ' + r.status + ': ' + t.slice(0, 200)); }
                        var j = null;
                        try { j = JSON.parse(t); } catch (e) { j = null; }
                        return { ok: true, mode: mode, status: r.status, receipt: j };
                    });
                });
        }
        return Promise.reject(new Error('unknown submit mode ' + mode));
    }

    return { SCHEMA: SCHEMA, QUESTIONS: QUESTIONS, ANSWERS: ANSWERS, rng: rng, sanitizeRid: sanitizeRid, newRid: newRid,
             itemIndex: itemIndex, questionsFor: questionsFor, buildPlan: buildPlan, newState: newState, stateMatches: stateMatches,
             setAnswer: setAnswer, isComplete: isComplete, enter: enter, leave: leave, buildPayload: buildPayload,
             payloadFilename: payloadFilename, submit: submit };
});
