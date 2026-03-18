let actionVoiceProfile = null;
let actionVoicePrimed = false;
let actionSfxCtx = null;
let actionAudioUnlocked = false;

const hasWindow = typeof window !== 'undefined';
const hasDocument = typeof document !== 'undefined';
const hasNavigator = typeof navigator !== 'undefined';

function getActionSfxContext(createIfNeeded = false) {
    if (actionSfxCtx) return actionSfxCtx;
    if (!createIfNeeded || !hasWindow) return null;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;

    try {
        actionSfxCtx = new Ctx();
    } catch {
        return null;
    }
    return actionSfxCtx;
}

function tryUnlockActionSfx() {
    const ctx = getActionSfxContext(true);
    if (!ctx) return false;

    if (ctx.state === 'running' || ctx.state === 'interrupted') {
        actionAudioUnlocked = true;
        return true;
    }

    if (ctx.state === 'suspended' && hasNavigator && navigator.userActivation?.isActive) {
        ctx.resume().then(() => {
            if (ctx.state === 'running' || ctx.state === 'interrupted') {
                actionAudioUnlocked = true;
            }
        }).catch(() => {});
    }

    return actionAudioUnlocked;
}

function primeActionSfxEngine(fromGesture = false) {
    if (fromGesture) tryUnlockActionSfx();
    if (!actionAudioUnlocked) return;

    const ctx = getActionSfxContext(false);
    if (!ctx) return;

    if (ctx.state === 'suspended' && hasNavigator && navigator.userActivation?.isActive) {
        ctx.resume().catch(() => {});
    }
}

function primeActionVoiceEngine(fromGesture = false) {
    primeActionSfxEngine(fromGesture);

    if (hasWindow && 'speechSynthesis' in window) {
        window.speechSynthesis.resume();
    }

    if (actionVoicePrimed) return;
    actionVoicePrimed = true;
    getActionVoiceProfile();
}

export function setupActionAudioUnlock() {
    if (!hasDocument) return;

    const events = ['click', 'touchend', 'keydown'];
    const unlock = (ev) => {
        if (ev && ev.isTrusted === false) return;
        primeActionVoiceEngine(true);
        if (!actionAudioUnlocked) return;
        if (actionSfxCtx && (actionSfxCtx.state === 'running' || actionSfxCtx.state === 'interrupted')) {
            events.forEach((evt) => document.removeEventListener(evt, unlock, true));
        }
    };

    events.forEach((evt) => {
        document.addEventListener(evt, unlock, { capture: true });
    });
}

export function getActionVoiceProfile() {
    if (!hasWindow || !('speechSynthesis' in window)) return { voice: null, isMinnan: false };
    if (actionVoiceProfile) return actionVoiceProfile;

    const voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
    const preferred = voices.slice().sort((a, b) => Number(!!b.localService) - Number(!!a.localService));
    const minnanReg = /nan|hokkien|hok-lo|taiwanese|tai-yu|tai yu|台语|台語|闽南|閩南/i;
    const twReg = /zh[-_]?tw|zh[-_]?hk|zh[-_]?hant|taiwan|台湾|台灣|hong kong|繁中|繁體/i;

    let voice = preferred.find((v) => minnanReg.test(`${v.name} ${v.lang}`));
    if (voice) {
        actionVoiceProfile = { voice, isMinnan: true };
        return actionVoiceProfile;
    }

    voice = preferred.find((v) => twReg.test(`${v.name} ${v.lang}`));
    if (!voice) {
        voice = preferred.find((v) => /^zh/i.test(v.lang) || /chinese|中文|普通话|國語|国语|mandarin/i.test(v.name));
    }

    actionVoiceProfile = { voice: voice || null, isMinnan: false };
    return actionVoiceProfile;
}

if (hasWindow && 'speechSynthesis' in window && window.speechSynthesis.addEventListener) {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
        actionVoiceProfile = null;
        actionVoicePrimed = false;
    });
}

function speak(text, opts = {}) {
    if (!hasWindow || !('speechSynthesis' in window)) return;

    const utter = new SpeechSynthesisUtterance(text);
    if (opts.voice) utter.voice = opts.voice;
    utter.lang = opts.lang || opts.voice?.lang || 'zh-CN';
    utter.rate = opts.rate ?? 1;
    utter.pitch = opts.pitch ?? 1;
    utter.volume = opts.volume ?? 1;

    if (opts.cancel !== false) window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
}

function playActionInstantSfx(actionType) {
    const isUserGesture = !!(hasNavigator && navigator.userActivation?.isActive);
    if (isUserGesture) primeActionSfxEngine(true);
    if (!actionAudioUnlocked) return;

    const ctx = getActionSfxContext(false);
    if (!ctx) return;
    if (ctx.state !== 'running' && ctx.state !== 'interrupted') return;

    const map = {
        CHI: { f: 740, d: 0.06 },
        PENG: { f: 620, d: 0.07 },
        GANG: { f: 430, d: 0.10 },
        AN_GANG: { f: 360, d: 0.11 },
        BU_GANG: { f: 390, d: 0.11 },
        HU: { f: 980, d: 0.14 }
    };
    const conf = map[actionType];
    if (!conf) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = actionType === 'HU' ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(conf.f, now);
    if (actionType === 'HU') {
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

export function playActionVoice(actionType) {
    const table = {
        CHI: { minnan: 'chi', mandarin: '吃' },
        PENG: { minnan: 'phing', mandarin: '碰' },
        GANG: { minnan: 'kong', mandarin: '杠' },
        AN_GANG: { minnan: 'am kong', mandarin: '暗杠' },
        BU_GANG: { minnan: 'poo kong', mandarin: '补杠' },
        HU: { minnan: 'hoo', mandarin: '胡' }
    };
    const item = table[actionType];
    if (!item) return;

    const isUserGesture = !!(hasNavigator && navigator.userActivation?.isActive);
    primeActionVoiceEngine(isUserGesture);
    playActionInstantSfx(actionType);

    const profile = getActionVoiceProfile();
    const text = profile.isMinnan ? item.minnan : item.mandarin;
    const lang = profile.isMinnan ? (profile.voice?.lang || 'nan-TW') : (profile.voice?.lang || 'zh-CN');
    speak(text, { voice: profile.voice, lang, cancel: false, rate: 1.08 });
}
