const ACTION_LABELS = Object.freeze({
    CHI: '吃',
    PENG: '碰',
    GANG: '杠',
    AN_GANG: '暗杠',
    BU_GANG: '补杠',
    HU: '胡',
    DISCARD: '出牌',
    ROUND_START: '开局'
});

const ACTION_VOICE_MAP = Object.freeze({
    CHI: { minnan: 'chi', mandarin: '吃' },
    PENG: { minnan: 'phing', mandarin: '碰' },
    GANG: { minnan: 'kong', mandarin: '杠' },
    AN_GANG: { minnan: 'am kong', mandarin: '暗杠' },
    BU_GANG: { minnan: 'poo kong', mandarin: '补杠' },
    HU: { minnan: 'hoo', mandarin: '胡' }
});

const ACTION_SFX_MAP = Object.freeze({
    ROUND_START: { f: 520, d: 0.07, wave: 'triangle' },
    DISCARD: { f: 300, d: 0.045, wave: 'square' },
    CHI: { f: 740, d: 0.06, wave: 'triangle' },
    PENG: { f: 620, d: 0.07, wave: 'triangle' },
    GANG: { f: 430, d: 0.10, wave: 'triangle' },
    AN_GANG: { f: 360, d: 0.11, wave: 'triangle' },
    BU_GANG: { f: 390, d: 0.11, wave: 'triangle' },
    HU: { f: 980, d: 0.14, wave: 'sine' }
});

const UNLOCK_EVENTS = ['click', 'touchend', 'keydown'];

const hasWindow = typeof window !== 'undefined';
const hasDocument = typeof document !== 'undefined';
const hasNavigator = typeof navigator !== 'undefined';

function safeTime(ts) {
    return Number.isFinite(ts) ? ts : Date.now();
}

function toActionKey(action) {
    if (!action || !action.type) return '';
    const seat = Number.isInteger(action.seatId) ? action.seatId : 'x';
    return `${action.type}|${seat}|${safeTime(action.ts)}`;
}

function toOutcomeKey(outcome, endedAt) {
    if (!outcome) return '';
    const winner = Number.isInteger(outcome.winner) ? outcome.winner : 'x';
    return `${winner}|${safeTime(outcome.ts || endedAt)}`;
}

function seatLabel(getSeatName, seatId) {
    if (typeof getSeatName === 'function') {
        return getSeatName(seatId);
    }
    return `座位${Number(seatId) + 1}`;
}

function outcomeColor(types = [], flowerCount = 0) {
    if (types.includes('三金倒')) return '#f59e0b';
    if (types.includes('天胡') || types.includes('地胡')) return '#ef4444';
    if (types.includes('抢杠胡')) return '#7c3aed';
    if (flowerCount >= 5) return '#2563eb';
    return '#f8fafc';
}

export function createPresentationEffects({ toastEl = null, canvasEl = null, outcomeCardEl = null, getSeatName = null } = {}) {
    let audioCtx = null;
    let audioUnlocked = false;
    let voiceProfile = null;
    let toastTimer = null;
    let particleFrame = null;
    let lastActionKey = '';
    let lastOutcomeKey = '';
    let removedUnlock = false;

    function getAudioContext(createIfNeeded = false) {
        if (audioCtx) return audioCtx;
        if (!createIfNeeded || !hasWindow) return null;

        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;

        try {
            audioCtx = new Ctx();
        } catch {
            return null;
        }
        return audioCtx;
    }

    function ensureAudioUnlocked(fromGesture = false) {
        const ctx = getAudioContext(true);
        if (!ctx) return false;

        if (ctx.state === 'running' || ctx.state === 'interrupted') {
            audioUnlocked = true;
            return true;
        }

        if (fromGesture && ctx.state === 'suspended') {
            ctx.resume().then(() => {
                if (ctx.state === 'running' || ctx.state === 'interrupted') {
                    audioUnlocked = true;
                }
            }).catch(() => {});
        }

        return audioUnlocked;
    }

    function getVoiceProfile() {
        if (!hasWindow || !('speechSynthesis' in window)) return { voice: null, isMinnan: false };
        if (voiceProfile) return voiceProfile;

        const voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
        const preferred = voices.slice().sort((a, b) => Number(!!b.localService) - Number(!!a.localService));
        const minnanReg = /nan|hokkien|hok-lo|taiwanese|tai-yu|tai yu|台语|台語|闽南|閩南/i;
        const twReg = /zh[-_]?tw|zh[-_]?hk|zh[-_]?hant|taiwan|台湾|台灣|hong kong|繁中|繁體/i;

        let voice = preferred.find((v) => minnanReg.test(`${v.name} ${v.lang}`));
        if (voice) {
            voiceProfile = { voice, isMinnan: true };
            return voiceProfile;
        }

        voice = preferred.find((v) => twReg.test(`${v.name} ${v.lang}`));
        if (!voice) {
            voice = preferred.find((v) => /^zh/i.test(v.lang) || /chinese|中文|普通话|國語|国语|mandarin/i.test(v.name));
        }

        voiceProfile = { voice: voice || null, isMinnan: false };
        return voiceProfile;
    }

    function speak(text, options = {}) {
        if (!hasWindow || !('speechSynthesis' in window) || !text) return;

        const utter = new SpeechSynthesisUtterance(text);
        if (options.voice) utter.voice = options.voice;
        utter.lang = options.lang || options.voice?.lang || 'zh-CN';
        utter.rate = options.rate ?? 1;
        utter.pitch = options.pitch ?? 1;
        utter.volume = options.volume ?? 1;
        if (options.cancel !== false) window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utter);
    }

    function playActionSfx(type) {
        const conf = ACTION_SFX_MAP[type];
        if (!conf) return;

        const withGesture = !!(hasNavigator && navigator.userActivation?.isActive);
        ensureAudioUnlocked(withGesture);
        if (!audioUnlocked) return;

        const ctx = getAudioContext(false);
        if (!ctx || (ctx.state !== 'running' && ctx.state !== 'interrupted')) return;

        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = conf.wave || 'triangle';
        osc.frequency.setValueAtTime(conf.f, now);
        if (type === 'HU') {
            osc.frequency.exponentialRampToValueAtTime(conf.f * 1.2, now + conf.d * 0.8);
        }

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.11, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + conf.d);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + conf.d + 0.02);
    }

    function playActionVoice(type) {
        const voiceItem = ACTION_VOICE_MAP[type];
        if (!voiceItem) {
            playActionSfx(type);
            return;
        }

        playActionSfx(type);
        const profile = getVoiceProfile();
        const text = profile.isMinnan ? voiceItem.minnan : voiceItem.mandarin;
        const lang = profile.isMinnan ? (profile.voice?.lang || 'nan-TW') : (profile.voice?.lang || 'zh-CN');
        speak(text, {
            voice: profile.voice,
            lang,
            cancel: false,
            rate: 1.08
        });
    }

    function hideToast() {
        if (!toastEl) return;
        toastEl.classList.remove('show', 'hu', 'round');
    }

    function showToast(text, variant = 'action', durationMs = 1400) {
        if (!toastEl || !text) return;
        if (toastTimer) clearTimeout(toastTimer);

        toastEl.textContent = text;
        toastEl.classList.remove('hu', 'round');
        if (variant === 'hu') toastEl.classList.add('hu');
        if (variant === 'round') toastEl.classList.add('round');
        toastEl.classList.add('show');
        toastTimer = setTimeout(hideToast, durationMs);
    }

    function stopHuParticles() {
        if (particleFrame) cancelAnimationFrame(particleFrame);
        particleFrame = null;
        if (!canvasEl) return;

        const ctx = canvasEl.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    }

    function startHuParticles(typeList = [], flowerCount = 0) {
        if (!canvasEl || !hasWindow) return;

        const ctx = canvasEl.getContext('2d');
        if (!ctx) return;

        stopHuParticles();
        canvasEl.width = window.innerWidth;
        canvasEl.height = window.innerHeight;
        const color = outcomeColor(typeList, flowerCount);

        let particles = [];
        for (let i = 0; i < 120; i += 1) {
            particles.push({
                x: Math.random() * canvasEl.width,
                y: Math.random() * canvasEl.height,
                r: Math.random() * 6 + 2,
                dx: (Math.random() - 0.5) * 4,
                dy: (Math.random() - 0.5) * 4,
                alpha: 1,
                color
            });
        }

        const animate = () => {
            ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

            particles.forEach((p) => {
                ctx.globalAlpha = p.alpha;
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fill();
                p.x += p.dx;
                p.y += p.dy;
                p.alpha -= 0.01;
            });

            particles = particles.filter((p) => p.alpha > 0);
            if (particles.length) {
                particleFrame = requestAnimationFrame(animate);
            } else {
                particleFrame = null;
            }
        };

        animate();
    }

    function pulseOutcomeCard() {
        if (!outcomeCardEl) return;
        outcomeCardEl.classList.remove('outcome-pop');
        void outcomeCardEl.offsetWidth;
        outcomeCardEl.classList.add('outcome-pop');
    }

    function buildActionMessage(action, gameState) {
        const actionType = action?.type;
        const actor = seatLabel(getSeatName, action?.seatId);

        if (actionType === 'DISCARD') {
            const tile = gameState?.lastDiscard?.tile || action?.payload?.tile || '';
            return tile ? `${actor} 出牌 ${tile}` : `${actor} 出牌`;
        }
        if (actionType === 'ROUND_START') {
            return `第 ${gameState?.roundNo || '-'} 局开始`;
        }

        const label = ACTION_LABELS[actionType] || actionType || '动作';
        return `${actor} ${label}`;
    }

    function handleActionUpdate(action, gameState) {
        if (!action || !action.type) return;

        const message = buildActionMessage(action, gameState);
        if (action.type === 'ROUND_START') {
            showToast(message, 'round', 1200);
            playActionSfx('ROUND_START');
            stopHuParticles();
            return;
        }

        if (action.type === 'DISCARD') {
            showToast(message, 'action', 900);
            playActionSfx('DISCARD');
            return;
        }

        const shouldVoice = ['CHI', 'PENG', 'GANG', 'AN_GANG', 'BU_GANG', 'HU'].includes(action.type);
        showToast(message, action.type === 'HU' ? 'hu' : 'action', action.type === 'HU' ? 2000 : 1400);
        if (shouldVoice) {
            playActionVoice(action.type);
        } else {
            playActionSfx(action.type);
        }
    }

    function handleOutcomeUpdate(outcome) {
        if (!outcome) return;

        const winner = seatLabel(getSeatName, outcome.winner);
        const special = Array.isArray(outcome.specialTypes) && outcome.specialTypes.length
            ? outcome.specialTypes.join('、')
            : (outcome.isSelfDraw ? '自摸' : '点炮');

        showToast(`${winner} ${special}`, 'hu', 2800);
        playActionVoice('HU');
        startHuParticles(outcome.specialTypes || [], Number(outcome.flowerCount || 0));
        pulseOutcomeCard();
    }

    function handleInstantScoreUpdate(prevGameState, nextGameState) {
        const prevLen = Array.isArray(prevGameState?.instantScoreLog) ? prevGameState.instantScoreLog.length : 0;
        const logs = Array.isArray(nextGameState?.instantScoreLog) ? nextGameState.instantScoreLog : [];
        if (logs.length <= prevLen) return;

        const latest = logs[logs.length - 1];
        if (!latest) return;

        if (latest.type === 'CHUI_FENG') {
            showToast(`吹风结算：庄家 ${seatLabel(getSeatName, latest.seatId)}`, 'action', 1700);
            playActionSfx('GANG');
            return;
        }

        if (latest.type === 'AN_GANG' || latest.type === 'MING_GANG') {
            showToast(`杠分结算：${seatLabel(getSeatName, latest.seatId)}`, 'action', 1500);
            playActionSfx(latest.type === 'AN_GANG' ? 'AN_GANG' : 'GANG');
        }
    }

    function bindUnlockEvents() {
        if (!hasDocument) return;

        const unlock = (ev) => {
            if (ev && ev.isTrusted === false) return;
            ensureAudioUnlocked(true);
            if (hasWindow && 'speechSynthesis' in window) window.speechSynthesis.resume();
            if (!audioUnlocked || removedUnlock) return;

            removedUnlock = true;
            UNLOCK_EVENTS.forEach((evt) => document.removeEventListener(evt, unlock, true));
        };

        removedUnlock = false;
        UNLOCK_EVENTS.forEach((evt) => {
            document.addEventListener(evt, unlock, { capture: true });
        });
    }

    function handleStateUpdate(prevRoomState, nextRoomState) {
        const prevGameState = prevRoomState?.game?.state || null;
        const nextGameState = nextRoomState?.game?.state || null;
        if (!nextGameState) return;

        const nextAction = nextGameState.lastAction || null;
        const nextActionKey = toActionKey(nextAction);
        const prevActionKey = toActionKey(prevGameState?.lastAction || null);
        if (nextActionKey && nextActionKey !== prevActionKey && nextActionKey !== lastActionKey) {
            lastActionKey = nextActionKey;
            handleActionUpdate(nextAction, nextGameState);
        }

        handleInstantScoreUpdate(prevGameState, nextGameState);

        const nextOutcome = nextGameState.outcome || null;
        const nextOutcomeKey = toOutcomeKey(nextOutcome, nextGameState.endedAt);
        const prevOutcomeKey = toOutcomeKey(prevGameState?.outcome || null, prevGameState?.endedAt);
        if (nextGameState.phase === 'ended' && nextOutcomeKey && nextOutcomeKey !== prevOutcomeKey && nextOutcomeKey !== lastOutcomeKey) {
            lastOutcomeKey = nextOutcomeKey;
            handleOutcomeUpdate(nextOutcome);
        }
    }

    function dispose() {
        stopHuParticles();
        hideToast();

        if (hasWindow && 'speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }

        if (audioCtx && audioCtx.state === 'running') {
            audioCtx.close().catch(() => {});
        }
    }

    return {
        bindUnlockEvents,
        handleStateUpdate,
        stopHuParticles,
        dispose
    };
}
