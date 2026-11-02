// Submit backend for this page. 'download' (always works: saves the answers as a JSON file) | 'mock' | 'worker' (POST the answers to endpoint).
// prolificCompletionCode: from the Prolific study page (Completion paths). Empty = no redirect.
window.STUDY_CONFIG = { submit: "worker", endpoint: "https://ustudy-smoke.lc-qi.workers.dev/submit", prolificCompletionCode: "", minWatchMs: 0 };
