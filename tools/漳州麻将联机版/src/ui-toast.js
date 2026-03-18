const TOAST_ID = 'action-toast';
const MIN_DURATION_MS = 900;
const DEDUPE_WINDOW_MS = 800;

let toastTimer = null;
let lastToastText = '';
let lastToastAt = 0;

function ensureToastElement() {
    let toastEl = document.getElementById(TOAST_ID);
    if (toastEl) return toastEl;

    toastEl = document.createElement('div');
    toastEl.id = TOAST_ID;
    toastEl.className = 'action-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
    return toastEl;
}

export function showActionToast(text, { isError = false, durationMs = 1800, allowRepeat = false } = {}) {
    const content = String(text || '').trim();
    if (!content) return;

    const now = Date.now();
    if (!allowRepeat && content === lastToastText && now - lastToastAt < DEDUPE_WINDOW_MS) return;

    const toastEl = ensureToastElement();
    if (!toastEl) return;

    if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
    }

    toastEl.textContent = content;
    toastEl.classList.toggle('error', !!isError);
    toastEl.classList.remove('show');

    requestAnimationFrame(() => {
        toastEl.classList.add('show');
    });

    toastTimer = setTimeout(() => {
        toastEl.classList.remove('show');
        toastTimer = null;
    }, Math.max(MIN_DURATION_MS, Number(durationMs) || 1800));

    lastToastText = content;
    lastToastAt = now;
}
