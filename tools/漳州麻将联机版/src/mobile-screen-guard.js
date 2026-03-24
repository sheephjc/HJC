const ORIENTATION_LABEL = {
    portrait: '竖屏',
    landscape: '横屏'
};

function getExpectedOrientation(value = 'portrait') {
    return String(value).toLowerCase() === 'landscape' ? 'landscape' : 'portrait';
}

function isPortraitNow() {
    if (window.matchMedia) {
        return window.matchMedia('(orientation: portrait)').matches;
    }
    return window.innerHeight >= window.innerWidth;
}

function isPhoneLikeViewport() {
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const shortestEdge = Math.min(window.innerWidth || 0, window.innerHeight || 0);
    return coarse && shortestEdge <= 900;
}

function getViewportHeight() {
    const vvHeight = Number(window.visualViewport?.height || 0);
    const innerHeight = Number(window.innerHeight || 0);
    const height = vvHeight > 0 ? vvHeight : innerHeight;
    return Math.max(1, Math.round(height));
}

function getViewportWidth() {
    const vvWidth = Number(window.visualViewport?.width || 0);
    const innerWidth = Number(window.innerWidth || 0);
    const width = vvWidth > 0 ? vvWidth : innerWidth;
    return Math.max(1, Math.round(width));
}

function ensureMaskElement(pageName = '', expectedOrientation = 'portrait') {
    const existing = document.getElementById('screen-orientation-mask');
    if (existing) return existing;

    const mask = document.createElement('div');
    mask.id = 'screen-orientation-mask';
    mask.setAttribute('aria-hidden', 'true');
    mask.setAttribute('aria-live', 'polite');
    mask.style.position = 'fixed';
    mask.style.inset = '0';
    mask.style.zIndex = '99999';
    mask.style.display = 'none';
    mask.style.alignItems = 'center';
    mask.style.justifyContent = 'center';
    mask.style.padding = '24px';
    mask.style.boxSizing = 'border-box';
    mask.style.textAlign = 'center';
    mask.style.background = 'rgba(0, 0, 0, 0.88)';
    mask.style.color = '#f8fafc';
    mask.style.backdropFilter = 'blur(4px)';
    mask.style.pointerEvents = 'auto';
    mask.style.touchAction = 'none';

    const card = document.createElement('div');
    card.style.maxWidth = 'min(92vw, 420px)';
    card.style.border = '1px solid rgba(255,255,255,0.25)';
    card.style.borderRadius = '14px';
    card.style.padding = '18px 16px';
    card.style.background = 'rgba(15, 23, 42, 0.75)';
    card.style.boxShadow = '0 10px 30px rgba(0,0,0,0.45)';

    const title = document.createElement('div');
    title.style.fontSize = '20px';
    title.style.fontWeight = '700';
    title.style.marginBottom = '10px';
    title.textContent = `请切换为${ORIENTATION_LABEL[expectedOrientation]}使用`;

    const desc = document.createElement('div');
    desc.style.fontSize = '14px';
    desc.style.lineHeight = '1.6';
    const pageText = pageName ? `${pageName}页面` : '当前页面';
    desc.textContent = `${pageText}需要${ORIENTATION_LABEL[expectedOrientation]}显示，旋转设备后将自动恢复。`;

    card.appendChild(title);
    card.appendChild(desc);
    mask.appendChild(card);
    document.body.appendChild(mask);
    return mask;
}

function orientationMatches(expectedOrientation) {
    const portrait = isPortraitNow();
    return expectedOrientation === 'portrait' ? portrait : !portrait;
}

export function initMobileScreenGuard(options = {}) {
    const expectedOrientation = getExpectedOrientation(options.expectedOrientation || 'portrait');
    const enforceOrientation = options.enforceOrientation !== false;
    const rootSelector = String(options.rootSelector || 'body');
    const pageName = String(options.pageName || '');
    const rootEl = document.querySelector(rootSelector) || document.body;
    const maskEl = enforceOrientation ? ensureMaskElement(pageName, expectedOrientation) : null;
    let disposed = false;

    const setViewportVars = () => {
        const height = getViewportHeight();
        const width = getViewportWidth();
        document.documentElement.style.setProperty('--app-height', `${height}px`);
        document.documentElement.style.setProperty('--app-width', `${width}px`);
        if (rootEl) {
            rootEl.style.setProperty('--app-height', `${height}px`);
            rootEl.style.setProperty('--app-width', `${width}px`);
        }
    };

    const applyState = () => {
        if (disposed) return;
        setViewportVars();

        const isPhone = isPhoneLikeViewport();
        const mismatch = enforceOrientation && isPhone && !orientationMatches(expectedOrientation);

        document.documentElement.classList.add('screen-guard-enabled');
        document.body?.classList.add('screen-guard-enabled');
        rootEl?.classList.add('screen-guard-enabled');

        document.documentElement.classList.toggle('screen-guard-mismatch', mismatch);
        document.body?.classList.toggle('screen-guard-mismatch', mismatch);
        rootEl?.classList.toggle('screen-guard-mismatch', mismatch);

        if (maskEl) {
            maskEl.style.display = mismatch ? 'flex' : 'none';
            maskEl.setAttribute('aria-hidden', mismatch ? 'false' : 'true');
            maskEl.dataset.expectedOrientation = expectedOrientation;
            maskEl.dataset.pageName = pageName;
        }
    };

    const tryLockOrientation = async () => {
        if (disposed || !enforceOrientation || !isPhoneLikeViewport()) return;
        const lockApi = window.screen?.orientation;
        if (!lockApi || typeof lockApi.lock !== 'function') return;
        const lockTarget = expectedOrientation === 'portrait' ? 'portrait' : 'landscape';
        try {
            await lockApi.lock(lockTarget);
        } catch {
            // 部分浏览器要求 fullscreen 才允许 lock，这里按 best-effort 忽略失败。
        }
    };

    const handleResize = () => applyState();
    const handleOrientation = () => applyState();
    const handleVisibility = () => {
        if (document.hidden) return;
        applyState();
        void tryLockOrientation();
    };
    const handleFirstGesture = () => {
        void tryLockOrientation();
    };

    window.addEventListener('resize', handleResize, { passive: true });
    window.addEventListener('orientationchange', handleOrientation, { passive: true });
    document.addEventListener('visibilitychange', handleVisibility, { passive: true });
    window.addEventListener('pointerdown', handleFirstGesture, { passive: true });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', handleResize, { passive: true });
        window.visualViewport.addEventListener('scroll', handleResize, { passive: true });
    }

    applyState();
    void tryLockOrientation();

    return function dispose() {
        if (disposed) return;
        disposed = true;

        window.removeEventListener('resize', handleResize);
        window.removeEventListener('orientationchange', handleOrientation);
        document.removeEventListener('visibilitychange', handleVisibility);
        window.removeEventListener('pointerdown', handleFirstGesture);
        if (window.visualViewport) {
            window.visualViewport.removeEventListener('resize', handleResize);
            window.visualViewport.removeEventListener('scroll', handleResize);
        }

        document.documentElement.classList.remove('screen-guard-enabled', 'screen-guard-mismatch');
        document.body?.classList.remove('screen-guard-enabled', 'screen-guard-mismatch');
        rootEl?.classList.remove('screen-guard-enabled', 'screen-guard-mismatch');
        if (maskEl?.parentNode) {
            maskEl.parentNode.removeChild(maskEl);
        }
    };
}
