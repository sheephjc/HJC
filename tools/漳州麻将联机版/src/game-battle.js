import { createAction } from './shared/action-schema.js';
import { getSelfDrawHuInfo, hasMandatorySanJinHu } from './online-game-engine.js';
import { ensureAnonymousAuth, getFirebaseConfigStatus, hasFirebaseConfig } from './firebase-client.js';
import { toTileEmoji } from './tile-display.js';
import { initMobileScreenGuard } from './mobile-screen-guard.js';
import {
    attachPresence,
    leaveRoom,
    runHostTick,
    setSeatControlMode,
    submitActionIntent,
    subscribeRoom,
    tryElectHost
} from './room-service.js';
import { clearSession, loadSession, saveSession } from './session.js';
import { roomStatusLabel } from './ui-labels.js';
import { showActionToast } from './ui-toast.js';

// 文案门禁关键短语（勿删）：
// 等待牌局初始化
// 已提牌，再次点击同一张牌打出
// 复制失败，请检查浏览器剪贴板权限

const BUILD_TAG = '20260324r46';
const HOST_LOOP_IDLE_INTERVAL_MS = 650;
const HOST_LOOP_ACTIVE_INTERVAL_MS = 100;
const HOST_LOOP_BURST_WINDOW_MS = 2800;
const GOLD_REVEAL_FX_DURATION_MS = 1880;
const REPLACEMENT_DRAW_DELAY_MS = 100;
const REACTION_BAR_STABLE_DELAY_MS = 160;
const REPLACEMENT_DRAW_REASONS = new Set(['GANG', 'GANG_FLOWER', 'FLOWER']);
const FLOWER_DRAW_REASONS = new Set(['FLOWER', 'GANG_FLOWER']);
const WHITE_DRAGON_TILE_CODE = 'Z7';
const WATER_NUM_CN = Object.freeze(['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']);
const SPECIAL_MULTIPLIER_MAP = Object.freeze({
    '游金': 2,
    '三金倒': 8,
    '天胡': 8,
    '地胡': 8,
    '杠上开花': 2,
    '花开富贵': 2,
    '抢杠胡': 2
});
const OUTCOME_TEXT_EFFECT_CLASS_LIST = Object.freeze([
    'hu-gold-pulse',
    'hu-super-gold',
    'hu-red-glow',
    'hu-blue-wave',
    'hu-purple-flash',
    'hu-shake-strong'
]);
const OUTCOME_OVERLAY_EFFECT_CLASS_LIST = Object.freeze([
    'flash-gold',
    'flash-red',
    'flash-blue'
]);
const ACTION_SFX_MAP = Object.freeze({
    DISCARD: { f: 300, d: 0.045, wave: 'square' },
    OPEN_GOLD: { f: 560, d: 0.12, wave: 'sine' },
    CHI: { f: 740, d: 0.06, wave: 'triangle' },
    PENG: { f: 620, d: 0.07, wave: 'triangle' },
    GANG: { f: 430, d: 0.10, wave: 'triangle' },
    AN_GANG: { f: 360, d: 0.11, wave: 'triangle' },
    BU_GANG: { f: 390, d: 0.11, wave: 'triangle' },
    HU: { f: 980, d: 0.14, wave: 'sine' },
    FLOWER_REPLENISH: { f: 840, d: 0.075, wave: 'triangle' },
    CHUI_FENG: { f: 520, d: 0.16, wave: 'triangle' }
});
const ACTION_VOICE_MAP = Object.freeze({
    OPEN_GOLD: { minnan: '開金', mandarin: '开金' },
    CHI: { minnan: '呷', mandarin: '吃' },
    PENG: { minnan: '拚', mandarin: '碰' },
    GANG: { minnan: '摃', mandarin: '杠' },
    AN_GANG: { minnan: '暗摃', mandarin: '暗杠' },
    BU_GANG: { minnan: '補摃', mandarin: '补杠' },
    HU: { minnan: '糊', mandarin: '胡' },
    FLOWER_REPLENISH: { minnan: '補花', mandarin: '补花' },
    CHUI_FENG: { minnan: '吹風', mandarin: '吹风' }
});
const ACTION_VOICE_MODE = Object.freeze({
    AUTO: 'auto',
    FORCE_MINNAN: 'force_minnan',
    FORCE_MANDARIN: 'force_mandarin'
});
const AI_SPEED_MODE = Object.freeze({
    NORMAL: 'normal',
    FAST: 'fast'
});
const AUDIO_UNLOCK_EVENTS = ['click', 'touchend', 'keydown'];

const roomMetaEl = document.getElementById('room-meta');
const turnStatusEl = document.getElementById('turn-status');
const mobileTurnStatusEl = document.getElementById('mobile-turn-status');
const leaveRoomBtn = document.getElementById('leave-room-btn');
const mobileLeaveRoomBtn = document.getElementById('mobile-leave-room-btn');
const trusteeBtn = document.getElementById('trustee-btn');
const mobileTrusteeBtn = document.getElementById('mobile-trustee-btn');
const aiSpeedToggleBtn = document.getElementById('ai-speed-toggle-btn');
const mobileAiSpeedToggleBtn = document.getElementById('mobile-ai-speed-toggle-btn');
const nextRoundBtn = document.getElementById('next-round-btn');
const mobileNextRoundBtn = document.getElementById('mobile-next-round-btn');
const centerNextRoundBtn = document.getElementById('center-next-round-btn');
const centerOpenGoldBtn = document.getElementById('center-open-gold-btn');
const centerLeaveRoomBtn = document.getElementById('center-leave-room-btn');
const actionBarEl = document.getElementById('action-bar');
const goldDisplayEl = document.getElementById('gold-display');
const goldRevealFxEl = document.getElementById('gold-reveal-fx');
const huOverlayEl = document.getElementById('hu-overlay');
const huMainTextEl = document.getElementById('hu-main-text');
const huDetailTextEl = document.getElementById('hu-detail-text');
const huScoreTextEl = document.getElementById('hu-score-text');
const huFormulaTextEl = document.getElementById('hu-formula-text');
const settlePanelEl = document.getElementById('settle-panel');
const instantScoreLogEl = document.getElementById('instant-score-log');
const roomActionSummaryEl = document.getElementById('room-action-summary');
const disposeScreenGuard = initMobileScreenGuard({
    expectedOrientation: 'landscape',
    rootSelector: '#table',
    pageName: '对局'
});

const PLAYER_POS = ['top', 'left', 'right', 'bottom'];

let session = null;
let roomCode = '';
let roomState = null;
let unsubscribeRoom = null;
let detachPresence = null;
let hostLoopTimer = null;
let hostLoopBusy = false;
let hostLoopBurstUntil = 0;
let dismissedOutcomeKey = null;
let selectedDiscardIndex = null;
let chiSubMenuOpen = false;
let actionAudioCtx = null;
let actionAudioUnlocked = false;
let actionVoiceProfile = null;
let actionVoicePrimed = false;
let actionSpeechSeq = 0;
let actionVoiceMode = ACTION_VOICE_MODE.FORCE_MINNAN;
let actionVoiceConsoleRegistered = false;
let audioDiagnosticVisible = false;
let lastAudioDiagnosticReason = '-';
let lastActionAudioKey = '';
let lastFlowerCueKey = '';
let lastChuiFengCueKey = '';
let lastTableOutcomeEffectKey = '';
let lastGoldRevealEffectKey = '';
let replacementDrawRevealTimer = null;
let flowerCueTimer = null;
let goldRevealFxTimer = null;
let reactionBarStableTimer = null;
let reactionBarStableKey = '';
let reactionBarStableReadyAt = 0;
let skippedSelfHuPromptKey = '';

function ensureAudioDiagnosticPanel() {
    const table = document.getElementById('table');
    if (!table) return null;
    let panel = document.getElementById('audio-diagnostic');
    if (panel) {
        panel.style.display = audioDiagnosticVisible ? 'block' : 'none';
        return panel;
    }
    panel = document.createElement('div');
    panel.id = 'audio-diagnostic';
    panel.innerHTML = '<div class="audio-diag-title">音频诊断</div><pre class="audio-diag-body"></pre>';
    panel.style.display = audioDiagnosticVisible ? 'block' : 'none';
    table.appendChild(panel);
    return panel;
}

function renderAudioDiagnostic(reason = '') {
    if (reason) lastAudioDiagnosticReason = String(reason);
    const panel = ensureAudioDiagnosticPanel();
    if (!panel) return;
    if (!audioDiagnosticVisible) return;
    const body = panel.querySelector('.audio-diag-body');
    if (!body) return;

    const ctx = getActionAudioContext(false);
    const ctxState = ctx?.state || 'none';
    const ua = navigator.userActivation || null;
    const uaActive = ua?.isActive ? 'active' : 'idle';
    const uaEver = ua?.hasBeenActive ? 'yes' : 'no';
    const speechSupported = 'speechSynthesis' in window;
    const profile = speechSupported ? getActionVoiceProfile() : { voice: null, mandarinVoice: null };
    const selectedVoice = actionVoiceMode === ACTION_VOICE_MODE.FORCE_MANDARIN
        ? (profile?.mandarinVoice || profile?.voice || null)
        : (profile?.voice || null);
    const voiceName = selectedVoice?.name ? String(selectedVoice.name) : '-';
    let voicesCount = '-';
    if (speechSupported) {
        try {
            voicesCount = Number(window.speechSynthesis?.getVoices?.().length || 0);
        } catch {
            voicesCount = '?';
        }
    }
    const lastActionType = String(getGameState()?.lastAction?.type || '-');
    const tick = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const lines = [
        `ctx: ${ctxState}`,
        `unlock: ${actionAudioUnlocked ? 'yes' : 'no'}`,
        `gesture: ${uaActive} / ever:${uaEver}`,
        `speech: ${speechSupported ? 'on' : 'off'} voices:${voicesCount}`,
        `voice: ${voiceName}`,
        `mode: ${actionVoiceMode}`,
        `lastAction: ${lastActionType}`,
        `reason: ${reason || '-'}`,
        `time: ${tick}`
    ];
    body.textContent = lines.join('\n');
}

function setAudioDiagnosticVisible(visible, reason = '') {
    audioDiagnosticVisible = !!visible;
    const panel = ensureAudioDiagnosticPanel();
    if (panel) {
        panel.style.display = audioDiagnosticVisible ? 'block' : 'none';
    }
    if (audioDiagnosticVisible) {
        renderAudioDiagnostic(reason || lastAudioDiagnosticReason || 'console:yinpin');
    }
    return audioDiagnosticVisible;
}

function normalizeActionVoiceMode(mode = '') {
    const raw = String(mode || '').trim().toLowerCase();
    if (!raw || raw === ACTION_VOICE_MODE.AUTO) return ACTION_VOICE_MODE.AUTO;
    if (raw === 'minnan' || raw === ACTION_VOICE_MODE.FORCE_MINNAN) return ACTION_VOICE_MODE.FORCE_MINNAN;
    if (raw === 'mandarin' || raw === ACTION_VOICE_MODE.FORCE_MANDARIN) return ACTION_VOICE_MODE.FORCE_MANDARIN;
    return '';
}

function setActionVoiceMode(mode = ACTION_VOICE_MODE.AUTO, reason = '') {
    const normalized = normalizeActionVoiceMode(mode);
    if (!normalized) {
        renderAudioDiagnostic(`console:invalid-mode:${mode}`);
        return actionVoiceMode;
    }
    actionVoiceMode = normalized;
    renderAudioDiagnostic(reason || `console:${normalized}`);
    return actionVoiceMode;
}

function registerVoiceModeConsoleCommands() {
    if (actionVoiceConsoleRegistered) return;
    actionVoiceConsoleRegistered = true;

    window.setVoiceMode = (mode = ACTION_VOICE_MODE.AUTO) => setActionVoiceMode(mode, `console:${mode}`);
    window.getVoiceMode = () => actionVoiceMode;
    window.setAudioDiagnosticVisible = (visible = true) => setAudioDiagnosticVisible(visible, `console:yinpin:${visible ? 'on' : 'off'}`);
    window.getAudioDiagnosticVisible = () => audioDiagnosticVisible;

    const registerGetterCommand = (name, mode) => {
        try {
            Object.defineProperty(window, name, {
                configurable: true,
                enumerable: false,
                get() {
                    return setActionVoiceMode(mode, `console:${mode}`);
                }
            });
        } catch {
            // 某些环境对 window 属性受限时，退化为函数调用方式。
            try {
                window[name] = () => setActionVoiceMode(mode, `console:${mode}`);
            } catch {
                // 忽略调试命令注册失败，不影响对局流程。
            }
        }
    };
    const registerGetterAction = (name, action) => {
        try {
            Object.defineProperty(window, name, {
                configurable: true,
                enumerable: false,
                get() {
                    return action();
                }
            });
        } catch {
            try {
                window[name] = action;
            } catch {
                // 忽略调试命令注册失败，不影响对局流程。
            }
        }
    };

    registerGetterCommand('minnan', ACTION_VOICE_MODE.FORCE_MINNAN);
    registerGetterCommand('mandarin', ACTION_VOICE_MODE.FORCE_MANDARIN);
    registerGetterCommand('auto', ACTION_VOICE_MODE.AUTO);
    registerGetterAction('yinpin', () => setAudioDiagnosticVisible(true, 'console:yinpin'));
}

function setStatus(text, isError = false) {
    if (turnStatusEl) {
        turnStatusEl.textContent = text;
        turnStatusEl.style.color = isError ? '#fecaca' : '#e2e8f0';
    }
    if (mobileTurnStatusEl) {
        mobileTurnStatusEl.textContent = text;
        mobileTurnStatusEl.style.color = isError ? '#fecaca' : '#e2e8f0';
    }
}

function redirectToLobby() {
    window.location.href = './index.html';
}

function openRuleModal(id) {
    const modal = document.getElementById(String(id || ''));
    if (!modal) return;
    modal.style.display = 'flex';
}

function closeRuleModal(id) {
    const modal = document.getElementById(String(id || ''));
    if (!modal) return;
    modal.style.display = 'none';
}

function handleRuleModalClick(event) {
    const target = event.target;
    if (!target) return;

    const openBtn = target.closest('[data-open-modal]');
    if (openBtn) {
        openRuleModal(openBtn.dataset.openModal);
        return;
    }

    const closeBtn = target.closest('[data-close-modal]');
    if (closeBtn) {
        closeRuleModal(closeBtn.dataset.closeModal);
        return;
    }

    const backdrop = target.closest('[data-modal-backdrop]');
    if (backdrop && target === backdrop) {
        closeRuleModal(backdrop.id);
    }
}

function readRoomCodeFromUrl() {
    const query = new URLSearchParams(window.location.search);
    return (query.get('room') || '').trim().toUpperCase();
}

function seatNameAbsolute(seatId) {
    const n = Number(seatId);
    if (n === 0) return '南';
    if (n === 1) return '东';
    if (n === 2) return '北';
    if (n === 3) return '西';
    return `座位${n + 1}`;
}

function getSeatNickname(seatId) {
    const key = String(seatId);
    const seat = roomState?.seats?.[key] || null;
    const nick = String(seat?.nickname || '').trim();
    if (nick) return nick;
    return seatNameAbsolute(seatId);
}

function getSettlementSeatLabel(seatId) {
    return `${getSeatNickname(seatId)}(${seatNameAbsolute(seatId)})`;
}

function getInstantSeatLabel(seatId) {
    const n = Number(seatId);
    if (!Number.isInteger(n) || n < 0 || n > 3) return `座位${seatId}`;
    return getSeatNickname(n);
}

function getCompactSeatLabel(seatId, seat = null) {
    const nickname = String(seat?.nickname || '').trim();
    const abs = seatNameAbsolute(seatId);
    return nickname ? `${nickname}(${abs})` : abs;
}

function normalizeSeatNo(value, fallback = 0) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 0 && n <= 3) return n;
    return fallback;
}

function getViewerBaseSeat() {
    if (session?.seatId !== null && session?.seatId !== undefined) {
        return normalizeSeatNo(session.seatId, 0);
    }
    return 0;
}

function getRelativeSeatLabel(targetSeat, baseSeat) {
    const diff = (Number(targetSeat) - Number(baseSeat) + 4) % 4;
    if (diff === 0) return '你';
    if (diff === 1) return '下家';
    if (diff === 2) return '对家';
    return '上家';
}

function seatNamePerspective(seatId, baseSeat = getViewerBaseSeat()) {
    const relative = getRelativeSeatLabel(Number(seatId), Number(baseSeat));
    const absolute = seatNameAbsolute(seatId);
    if (relative === '') return `(${absolute})`;
    return `${relative}(${absolute})`;
}

function actionTypeLabel(type = '') {
    const map = {
        ROUND_START: '下一局',
        OPEN_GOLD: '开金',
        SET_AI_SPEED: 'AI速度',
        DRAW: '摸牌',
        DISCARD: '出牌',
        CHI: '吃',
        PENG: '碰',
        GANG: '杠',
        AN_GANG: '暗杠',
        BU_GANG: '补杠',
        HU: '胡牌',
        PASS: '过',
        FLOWER_REPLENISH: '补花'
    };
    return map[String(type || '').toUpperCase()] || String(type || '');
}

function pendingOptionPriority(options = {}) {
    if (!options || typeof options !== 'object') return 9;
    if (options.HU) return 0;
    if (options.PENG || options.GANG) return 1;
    if (Array.isArray(options.CHI) && options.CHI.length) return 2;
    return 9;
}

function getPendingDecisionOriginSeat(pending = null) {
    if (!pending || typeof pending !== 'object') return null;
    if (pending.kind === 'QIANG_GANG') {
        return normalizeSeatNo(pending?.source?.seatId, null);
    }
    return normalizeSeatNo(pending?.discard?.seatId, null);
}

function buildPendingDecisionOrder(pending = null) {
    if (!pending?.optionsBySeat || typeof pending.optionsBySeat !== 'object') return [];
    const originSeat = getPendingDecisionOriginSeat(pending);
    const seatIds = Object.keys(pending.optionsBySeat);
    return seatIds.slice().sort((a, b) => {
        const pa = pendingOptionPriority(pending.optionsBySeat?.[a] || null);
        const pb = pendingOptionPriority(pending.optionsBySeat?.[b] || null);
        if (pa !== pb) return pa - pb;

        if (originSeat !== null) {
            const da = (Number(a) - Number(originSeat) + 4) % 4;
            const db = (Number(b) - Number(originSeat) + 4) % 4;
            if (da !== db) return da - db;
        }
        return Number(a) - Number(b);
    });
}

function getPendingDecisionOrder(pending = null) {
    const persisted = Array.isArray(pending?.decisionOrder)
        ? pending.decisionOrder.map((seatId) => String(seatId))
        : [];
    return persisted.length ? persisted : buildPendingDecisionOrder(pending);
}

function getActivePendingSeatId(pending = null) {
    if (!pending?.optionsBySeat || typeof pending.optionsBySeat !== 'object') return null;
    const order = getPendingDecisionOrder(pending);
    for (const rawSeatId of order) {
        const seatId = String(rawSeatId || '');
        if (!seatId || !pending.optionsBySeat?.[seatId]) continue;
        if (pending?.decisions?.[seatId]) continue;
        return seatId;
    }
    for (const seatId of Object.keys(pending.optionsBySeat)) {
        if (pending?.decisions?.[seatId]) continue;
        return seatId;
    }
    return null;
}

function isSeatActivePendingDecision(pending = null, seatId = '') {
    const seatKey = String(seatId || '');
    if (!seatKey || !pending?.optionsBySeat?.[seatKey]) return false;
    const activeSeatId = getActivePendingSeatId(pending);
    return !!activeSeatId && seatKey === activeSeatId;
}

const CLAIM_REACTION_ACTION_TYPES = new Set(['CHI', 'PENG', 'GANG', 'HU', 'PASS']);

function clearReactionBarStableTimer() {
    if (!reactionBarStableTimer) return;
    clearTimeout(reactionBarStableTimer);
    reactionBarStableTimer = null;
}

function resetReactionBarStableGate() {
    clearReactionBarStableTimer();
    reactionBarStableKey = '';
    reactionBarStableReadyAt = 0;
}

function buildReactionOptionsStableKey(options = null) {
    if (!options || typeof options !== 'object') return '';

    const parts = [];
    if (options.HU) parts.push('HU');
    if (options.PENG) parts.push('PENG');
    if (options.GANG) parts.push('GANG');

    const chiChoices = Array.isArray(options.CHI) ? options.CHI : [];
    if (chiChoices.length) {
        const chiKey = chiChoices
            .map((choice) => Array.isArray(choice)
                ? choice.map((tile) => String(tile || '')).join(',')
                : '')
            .join('|');
        parts.push(`CHI:${chiKey}`);
    }

    return parts.join(';');
}

function buildReactionBarStableKey(pending = null, seatId = '') {
    if (!pending || typeof pending !== 'object') return '';

    const seatKey = String(seatId || '');
    if (!seatKey) return '';

    const options = pending?.optionsBySeat?.[seatKey];
    if (!options || !isSeatActivePendingDecision(pending, seatKey)) return '';

    const optionsKey = buildReactionOptionsStableKey(options);
    if (!optionsKey) return '';

    const orderKey = getPendingDecisionOrder(pending)
        .map((rawSeatId) => String(rawSeatId || ''))
        .join(',');
    const activeSeatId = String(getActivePendingSeatId(pending) || '');
    const discardSeatId = String(normalizeSeatNo(pending?.discard?.seatId, '') ?? '');
    const discardTile = String(pending?.discard?.tile || '');
    const discardTs = Number.isFinite(Number(pending?.discard?.ts))
        ? Math.floor(Number(pending.discard.ts))
        : 0;
    const openedBySeatId = String(normalizeSeatNo(pending?.openedBy, '') ?? '');

    return [
        seatKey,
        orderKey,
        activeSeatId,
        discardSeatId,
        discardTile,
        discardTs,
        openedBySeatId,
        optionsKey
    ].join('|');
}

function shouldHoldReactionBarUntilStable(stableKey = '') {
    if (!stableKey) {
        resetReactionBarStableGate();
        return false;
    }

    const now = Date.now();
    if (reactionBarStableKey !== stableKey) {
        reactionBarStableKey = stableKey;
        reactionBarStableReadyAt = now + REACTION_BAR_STABLE_DELAY_MS;
        clearReactionBarStableTimer();
    }

    if (now >= reactionBarStableReadyAt) {
        clearReactionBarStableTimer();
        return false;
    }

    if (!reactionBarStableTimer) {
        const delay = Math.max(16, reactionBarStableReadyAt - now);
        reactionBarStableTimer = setTimeout(() => {
            reactionBarStableTimer = null;
            renderActionBar();
        }, delay);
    }

    return true;
}

function shouldLockReactionBar(actions = {}, pending = null, seatId = '') {
    if (!pending || typeof pending !== 'object') return false;
    const selfSeatId = String(seatId || '');
    if (!selfSeatId || !pending?.optionsBySeat?.[selfSeatId]) return false;

    const order = getPendingDecisionOrder(pending);
    if (!order.length) return false;
    const selfIndex = order.findIndex((rawSeatId) => String(rawSeatId || '') === selfSeatId);
    if (selfIndex <= 0) return false;

    const higherPrioritySeats = new Set(
        order
            .slice(0, selfIndex)
            .map((rawSeatId) => String(rawSeatId || ''))
            .filter((seatKey) => !!seatKey && !!pending?.optionsBySeat?.[seatKey])
    );
    if (!higherPrioritySeats.size) return false;

    const actionMap = actions && typeof actions === 'object' ? actions : {};
    for (const entry of Object.values(actionMap)) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.status !== 'pending') continue;

        const action = entry.action;
        if (!action || typeof action !== 'object') continue;

        const actionType = String(action.type || '').toUpperCase();
        if (!CLAIM_REACTION_ACTION_TYPES.has(actionType)) continue;

        const actionSeatNo = normalizeSeatNo(action.seatId, null);
        if (actionSeatNo === null) continue;
        const actionSeatId = String(actionSeatNo);
        if (!higherPrioritySeats.has(actionSeatId)) continue;

        return true;
    }
    return false;
}

function formatActionPayloadText(type, payload = {}) {
    const actionType = String(type || '').toUpperCase();
    if (!payload || typeof payload !== 'object') return '';

    if (actionType === 'DISCARD') {
        if (typeof payload.tile === 'string' && payload.tile) {
            return ` ${toTileEmoji(payload.tile)}`;
        }
        if (Number.isInteger(payload.index) && payload.index >= 0) {
            return `${payload.index + 1}张`;
        }
        return '';
    }

    if (['AN_GANG', 'BU_GANG', 'GANG', 'PENG'].includes(actionType) && typeof payload.char === 'string' && payload.char) {
        return ` ${toTileEmoji(payload.char)}`;
    }

    if (actionType === 'SET_AI_SPEED') {
        const mode = normalizeAiSpeedMode(payload.mode);
        return mode === AI_SPEED_MODE.FAST ? ' 加速' : ' 常速';
    }

    if (actionType === 'CHI' && Array.isArray(payload.choice) && payload.choice.length) {
        return ` ${payload.choice.map((tile) => toTileEmoji(String(tile))).join(' ')}`;
    }

    return '';
}

function formatActionSummaryLine(action = null) {
    if (!action || typeof action !== 'object') return '系统：等待动作';
    const seatText = Number.isInteger(action.seatId) ? seatNamePerspective(action.seatId) : '系统';
    const typeText = actionTypeLabel(action.type);
    const payloadText = formatActionPayloadText(action.type, action.payload || {});
    return `${seatText} ${typeText}${payloadText}`;
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderGoldDisplay(tileCode = '') {
    if (!goldDisplayEl) return;
    if (!tileCode) {
        goldDisplayEl.innerHTML = '<span class="gold-display-placeholder">?</span>';
        return;
    }

    const tileText = escapeHtml(toTileEmoji(tileCode));
    const titleText = escapeHtml(tileCode);
    goldDisplayEl.innerHTML = `
        <span class="gold-display-tile" title="${titleText}">
            <span class="gold-display-glyph">${tileText}</span>
        </span>
    `;
}

function getSeatByPos(baseSeat) {
    const b = normalizeSeatNo(baseSeat, 0);
    return {
        top: (b + 2) % 4,
        left: (b + 3) % 4,
        right: (b + 1) % 4,
        bottom: b
    };
}

function getPosBySeat(baseSeat, targetSeat) {
    const map = getSeatByPos(baseSeat);
    return Object.keys(map).find((pos) => map[pos] === Number(targetSeat)) || 'bottom';
}

function isHost() {
    return !!(roomState && session && roomState.meta?.hostUid === session.uid);
}

function getGameState() {
    return roomState?.game?.state || null;
}

function isMobileBattleViewport() {
    if (window.matchMedia) {
        const isPortraitMobile = window.matchMedia('(max-width: 767px)').matches;
        const isLandscapeMobile = window.matchMedia('(max-width: 1024px) and (orientation: landscape)').matches;
        return isPortraitMobile || isLandscapeMobile;
    }
    return Number(window.innerWidth || 0) <= 1024;
}

function isDesktopViewport() {
    return !isMobileBattleViewport();
}

function normalizeAiSpeedMode(mode = '') {
    const raw = String(mode || '').trim().toLowerCase();
    if (raw === AI_SPEED_MODE.FAST) return AI_SPEED_MODE.FAST;
    return AI_SPEED_MODE.NORMAL;
}

function selfHuPromptKey(gameState = getGameState(), seatId = getSelfSeatNo()) {
    const seatNo = Number(seatId);
    if (!gameState || !Number.isInteger(seatNo) || seatNo < 0 || seatNo > 3) return '';
    if (gameState.phase !== 'playing') return '';
    if (Number(gameState.turnSeat) !== seatNo) return '';
    const draw = gameState.currentDraw || null;
    if (!draw || Number(draw.seatId) !== seatNo || !draw.tile) return '';
    const roundNo = Number.isInteger(Number(gameState.roundNo)) ? Number(gameState.roundNo) : 0;
    const drawTs = Number.isFinite(Number(draw.ts)) ? Number(draw.ts) : 0;
    const drawReason = String(draw.reason || 'NORMAL').toUpperCase();
    return `${roundNo}|${seatNo}|${draw.tile}|${drawReason}|${drawTs}`;
}

function getSelfSeatNo() {
    if (session?.seatId === null || session?.seatId === undefined) return null;
    return normalizeSeatNo(session.seatId, 0);
}

function isSpectatorMode() {
    return getSelfSeatNo() === null;
}

function getDealerSeatNo(gameState = getGameState()) {
    const dealerSeat = Number(gameState?.dealerSeat);
    return Number.isInteger(dealerSeat) ? dealerSeat : null;
}

function isSelfDealer(gameState = getGameState()) {
    const selfSeat = getSelfSeatNo();
    const dealerSeat = getDealerSeatNo(gameState);
    return selfSeat !== null && dealerSeat !== null && Number(selfSeat) === Number(dealerSeat);
}

function isDealerBotControlled(gameState = getGameState()) {
    const dealerSeat = getDealerSeatNo(gameState);
    if (dealerSeat === null) return false;
    const dealerControl = gameState?.seatControls?.[String(dealerSeat)] || 'human';
    return dealerControl === 'bot';
}

function canOperateDealerAction(gameState = getGameState()) {
    if (!gameState || getSelfSeatNo() === null) return false;
    if (isSelfDealer(gameState)) return true;
    return isDealerBotControlled(gameState) && isHost();
}

function isGoldRevealed(gameState = getGameState()) {
    return gameState?.goldRevealed !== false;
}

function getWaterCountFromOutcome(outcome = null) {
    const flowerCount = Number(outcome?.flowerCount || 0);
    if (Number.isInteger(flowerCount) && flowerCount >= 4) {
        return flowerCount - 3;
    }
    const waterMul = Number(outcome?.waterMul || 1);
    if (waterMul > 1) {
        const power = Math.log2(waterMul);
        if (Number.isInteger(power) && power > 0) return power;
    }
    return 0;
}

function normalizeSpecialTypes(specialTypes = []) {
    const list = Array.isArray(specialTypes)
        ? specialTypes.filter((type) => typeof type === 'string' && type.trim())
        : [];
    if (list.includes('三金倒')) {
        return list.filter((type) => type !== '游金');
    }
    return list;
}

function waterTextByCount(count = 0) {
    if (!Number.isInteger(count) || count <= 0) return '';
    const cn = WATER_NUM_CN[count] || String(count);
    return `${cn}水`;
}

function buildOutcomeHeadline(outcome = null) {
    if (!outcome || typeof outcome !== 'object') return '';
    const parts = [];
    const waterCount = getWaterCountFromOutcome(outcome);
    const waterText = waterTextByCount(waterCount);
    if (waterText) parts.push(waterText);
    normalizeSpecialTypes(outcome.specialTypes).forEach((type) => parts.push(type));
    parts.push(outcome.isSelfDraw ? '自摸' : '点炮');
    return parts.join(' ').trim();
}

function buildOutcomeMultiplierLabels(outcome = null) {
    if (!outcome || typeof outcome !== 'object') return [];
    const labels = [];
    const waterCount = getWaterCountFromOutcome(outcome);
    const waterMul = Number(outcome.waterMul || 1);
    if (waterCount > 0 && waterMul > 1) {
        labels.push(`×${waterMul}${waterTextByCount(waterCount)}`);
    }

    normalizeSpecialTypes(outcome.specialTypes).forEach((type) => {
        const mul = Number(SPECIAL_MULTIPLIER_MAP[type] || 1);
        if (mul > 1) labels.push(`×${mul}${type}`);
    });
    return labels;
}

function applyOutcomeTextEffectClasses(el, outcome = null) {
    if (!el) return;
    OUTCOME_TEXT_EFFECT_CLASS_LIST.forEach((className) => el.classList.remove(className));
    if (!outcome || typeof outcome !== 'object') return;

    const specialTypes = normalizeSpecialTypes(outcome.specialTypes);
    const waterCount = getWaterCountFromOutcome(outcome);
    const dealerStreakAfter = Number(outcome.dealerStreakAfter || 0);

    if (waterCount > 0) el.classList.add('hu-blue-wave');
    if (dealerStreakAfter >= 2) el.classList.add('hu-shake-strong');
    if (specialTypes.includes('游金')) el.classList.add('hu-gold-pulse');
    if (specialTypes.includes('三金倒')) {
        el.classList.add('hu-super-gold');
        el.classList.add('hu-shake-strong');
    }
    if (specialTypes.includes('天胡') || specialTypes.includes('地胡')) el.classList.add('hu-red-glow');
    if (specialTypes.includes('杠上开花') || specialTypes.includes('花开富贵')) el.classList.add('hu-gold-pulse');
    if (specialTypes.includes('抢杠胡')) el.classList.add('hu-purple-flash');
}

function applyOutcomeOverlayEffectClasses(overlay, outcome = null) {
    if (!overlay) return;
    OUTCOME_OVERLAY_EFFECT_CLASS_LIST.forEach((className) => overlay.classList.remove(className));
    if (!outcome || typeof outcome !== 'object') return;

    const specialTypes = normalizeSpecialTypes(outcome.specialTypes);
    const waterCount = getWaterCountFromOutcome(outcome);
    if (specialTypes.includes('三金倒')) overlay.classList.add('flash-gold');
    if (specialTypes.includes('天胡') || specialTypes.includes('地胡')) overlay.classList.add('flash-red');
    if (waterCount >= 2) overlay.classList.add('flash-blue');
}

function fitTextToSingleLine(el, options = {}) {
    if (!el) return;
    const text = String(el.textContent || '').trim();
    if (!text) return;

    const minPx = Math.max(10, Number(options.minPx || 12));
    const widthRatio = Number(options.widthRatio || 0.94);
    const clipOverflow = options.clipOverflow !== false;
    const maxPx = Number(options.maxPx || parseFloat(window.getComputedStyle(el).fontSize || '16'));
    const container = options.container || el.parentElement || document.body;
    const containerWidth = Number(container?.clientWidth || window.innerWidth || 0);
    if (!containerWidth) return;
    const targetWidth = Math.max(40, Math.floor(containerWidth * widthRatio));

    el.style.whiteSpace = 'nowrap';
    el.style.maxWidth = `${targetWidth}px`;
    el.style.overflow = clipOverflow ? 'hidden' : 'visible';
    el.style.textOverflow = clipOverflow ? 'clip' : 'unset';
    el.style.fontSize = `${maxPx}px`;

    let fontSize = maxPx;
    while (fontSize > minPx && el.scrollWidth > targetWidth) {
        fontSize -= 1;
        el.style.fontSize = `${fontSize}px`;
    }
}

function fitOutcomeOverlayText() {
    if (!huOverlayEl || huOverlayEl.style.display === 'none') return;
    fitTextToSingleLine(huMainTextEl, { minPx: 20, widthRatio: 0.92, container: huOverlayEl, clipOverflow: false });
    fitTextToSingleLine(huScoreTextEl, { minPx: 12, widthRatio: 0.94, container: huOverlayEl });
}

function getTableEffectLayer() {
    const table = document.getElementById('table');
    if (!table) return null;
    let layer = document.getElementById('table-effect-layer');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.id = 'table-effect-layer';
    table.appendChild(layer);
    return layer;
}

function placeEffectAtSeat(effectEl, seatId, options = {}) {
    if (!effectEl) return false;
    const layer = getTableEffectLayer();
    const table = document.getElementById('table');
    if (!layer || !table) return false;

    const pos = getPosBySeat(getViewerBaseSeat(), Number(seatId));
    const area = document.getElementById(`p-${pos}`);
    if (!area) return false;

    const tableRect = table.getBoundingClientRect();
    const areaRect = area.getBoundingClientRect();
    const x = areaRect.left - tableRect.left + (areaRect.width * 0.5);
    const yRatio = Number.isFinite(Number(options.verticalRatio)) ? Number(options.verticalRatio) : 0.48;
    const y = areaRect.top - tableRect.top + (areaRect.height * Math.min(0.92, Math.max(0.08, yRatio)));

    effectEl.style.position = 'absolute';
    effectEl.style.left = `${Math.round(x)}px`;
    effectEl.style.top = `${Math.round(y)}px`;
    layer.appendChild(effectEl);
    return true;
}

function getSeatTextRotationDegByPos(pos = 'bottom') {
    if (pos === 'top') return 180;
    if (pos === 'left') return 90;
    if (pos === 'right') return -90;
    return 0;
}

function clearTurnHighlight() {
    PLAYER_POS.forEach((pos) => {
        const area = document.getElementById(`p-${pos}`);
        area?.classList.remove('active-turn');
    });
}

function clearTableOutcomeEffects() {
    document.querySelectorAll('.result-text').forEach((el) => el.remove());
    document.querySelectorAll('.player-area').forEach((el) => {
        el.classList.remove('win-mark', 'lose-mark');
    });
}

function outcomeWinnerTableText(outcome = null) {
    const headline = buildOutcomeHeadline(outcome);
    const text = headline || (outcome?.isSelfDraw ? '自摸' : '点炮');
    if (outcome?.isSelfDraw) return text;
    const huText = text.replace(/点炮$/, '点炮胡');
    return huText || '点炮胡';
}

function renderTableOutcomeEffects() {
    const gameState = getGameState();
    const outcome = gameState?.outcome || null;
    if (!gameState || gameState.phase !== 'ended' || !outcome) {
        if (lastTableOutcomeEffectKey) {
            clearTableOutcomeEffects();
            lastTableOutcomeEffectKey = '';
        }
        return;
    }

    const key = outcomeKey(outcome);
    if (key && key === lastTableOutcomeEffectKey) return;

    clearTableOutcomeEffects();
    lastTableOutcomeEffectKey = key;

    const baseSeat = getViewerBaseSeat();
    const winnerPos = getPosBySeat(baseSeat, Number(outcome.winner));
    const winnerArea = document.getElementById(`p-${winnerPos}`);
    if (winnerArea) {
        winnerArea.classList.add('win-mark');
        const text = document.createElement('div');
        text.className = 'result-text';
        text.textContent = outcomeWinnerTableText(outcome);
        applyOutcomeTextEffectClasses(text, outcome);
        winnerArea.appendChild(text);
        fitTextToSingleLine(text, { minPx: 12, widthRatio: 0.9, container: winnerArea, clipOverflow: false });
    }

    if (!outcome.isSelfDraw && Number.isInteger(Number(outcome.loser))) {
        const loserPos = getPosBySeat(baseSeat, Number(outcome.loser));
        const loserArea = document.getElementById(`p-${loserPos}`);
        if (loserArea) {
            loserArea.classList.add('lose-mark');
            const text = document.createElement('div');
            text.className = 'result-text lose-text';
            const label = document.createElement('span');
            label.className = 'lose-label';
            label.textContent = '点炮';
            const thumb = document.createElement('span');
            thumb.className = 'lose-thumb';
            thumb.textContent = '👎🏻';
            text.appendChild(label);
            text.appendChild(thumb);
            loserArea.appendChild(text);
            fitTextToSingleLine(text, { minPx: 12, widthRatio: 0.9, container: loserArea, clipOverflow: false });
        }
    }
}

function renderRoomMeta() {
    if (!roomMetaEl || !session || !roomState) return;
    const spectator = session.seatId === null || session.seatId === undefined;
    const role = spectator ? '观战' : (isHost() ? '房主' : '成员');
    const seatText = session.seatId === null || session.seatId === undefined
        ? '观战'
        : `${seatNameAbsolute(session.seatId)}位`;
    const status = roomState?.meta?.status || 'waiting';
    roomMetaEl.textContent = `房间 ${roomCode} | ${session.nickname}(${seatText}) | ${role} | 状态 ${roomStatusLabel(status)} | 版本 ${BUILD_TAG}`;
}

function renderRoomActionSummary() {
    if (!roomActionSummaryEl) return;
    const gameState = getGameState();
    if (!gameState) {
        roomActionSummaryEl.textContent = '等待牌局初始化...';
        return;
    }

    const pending = gameState.pendingClaim || null;
    if (pending?.discard?.tile) {
        const discardSeat = seatNamePerspective(pending.discard.seatId);
        roomActionSummaryEl.textContent = `${discardSeat} 打出 ${toTileEmoji(pending.discard.tile)}，等待响应`;
        return;
    }

    const outcome = gameState.outcome || null;
    if (gameState.phase === 'ended' && outcome) {
        const winnerText = seatNamePerspective(outcome.winner);
        if (outcome.isSelfDraw) {
            roomActionSummaryEl.textContent = `${winnerText} 自摸胡牌`;
            return;
        }
        const loserText = seatNamePerspective(outcome.loser);
        roomActionSummaryEl.textContent = `${winnerText} 点炮胡（放炮：${loserText}）`;
        return;
    }

    const summaryText = formatActionSummaryLine(gameState.lastAction || null);
    roomActionSummaryEl.textContent = `${summaryText}`;
}

function setBoardScore(pos, label, score, isDealer, dealerStreak = 0) {
    const nameEl = document.getElementById(`seat-name-${pos}`);
    const scoreEl = document.getElementById(`score-${pos}`);
    const boardEl = document.getElementById(`score-board-${pos}`);
    if (nameEl) nameEl.textContent = label;
    if (scoreEl) scoreEl.textContent = String(Math.floor(Number(score || 0)));

    if (boardEl) {
        boardEl.classList.toggle('dealer-active', !!isDealer);
        const oldBadge = boardEl.querySelector('.dealer-badge');
        if (oldBadge) oldBadge.remove();
        if (isDealer) {
            const badge = document.createElement('span');
            badge.className = 'dealer-badge';
            const streak = Math.max(0, Number(dealerStreak || 0));
            badge.textContent = streak > 0 ? `连${streak}次庄` : '庄';
            boardEl.prepend(badge);
        }
    }
}

function renderTileHtml(tile, options = {}) {
    const classes = ['tile'];
    if (options.back) classes.push('back');
    if (options.disabled) classes.push('disabled');
    if (options.selected) classes.push('selected');
    if (options.isGold) classes.push('is-gold');
    if (options.newDraw) classes.push('new-draw');
    if (options.drawSeparated) classes.push('draw-separated');
    if (options.winning) classes.push('winning');
    const attrs = [];
    if (Number.isInteger(options.discardIndex)) {
        attrs.push(`data-discard-index="${options.discardIndex}"`);
        attrs.push(`data-can-discard="${options.canDiscard ? '1' : '0'}"`);
    }
    const tileCode = String(tile ?? '');
    const titleAttr = options.back ? '' : `title="${escapeHtml(tileCode)}"`;
    const tileText = options.back ? '' : escapeHtml(toTileEmoji(tileCode));
    return `<div class="${classes.join(' ')}" ${titleAttr} ${attrs.join(' ')}>${tileText}</div>`;
}

function renderGroupHtml(group = {}) {
    const tiles = Array.isArray(group.tiles) ? group.tiles : [];
    const tileHtml = tiles.map((tile) => {
        const tileCode = String(tile ?? '');
        return `<div class="tile" title="${escapeHtml(tileCode)}">${escapeHtml(toTileEmoji(tileCode))}</div>`;
    }).join('');
    const groupType = escapeHtml(group.type || '');
    return `<div class="group" title="${groupType}">${tileHtml}</div>`;
}

function renderFlowerGroupHtml(tiles = []) {
    if (!Array.isArray(tiles) || !tiles.length) return '';
    const tileHtml = tiles.map((tile) => {
        const tileCode = String(tile ?? '');
        return `<div class="tile" title="${escapeHtml(tileCode)}">${escapeHtml(toTileEmoji(tileCode))}</div>`;
    }).join('');
    return `<div class="group" title="花牌">${tileHtml}</div>`;
}

function findLastTileIndex(tiles = [], targetTile = '') {
    if (!Array.isArray(tiles) || !tiles.length || typeof targetTile !== 'string' || !targetTile) return -1;
    for (let i = tiles.length - 1; i >= 0; i -= 1) {
        if (tiles[i] === targetTile) return i;
    }
    return -1;
}

function getReplacementDrawDelayRemaining(gameState = null) {
    if (!gameState || gameState.phase !== 'playing') return 0;
    const draw = gameState.currentDraw || null;
    if (!draw || !REPLACEMENT_DRAW_REASONS.has(String(draw.reason || '').toUpperCase())) return 0;
    const drawTs = Number(draw.ts || 0);
    if (!Number.isFinite(drawTs) || drawTs <= 0) return 0;
    const elapsed = Date.now() - drawTs;
    if (elapsed >= REPLACEMENT_DRAW_DELAY_MS) return 0;
    return REPLACEMENT_DRAW_DELAY_MS - elapsed;
}

function scheduleReplacementDrawReveal(delayMs = 0) {
    if (replacementDrawRevealTimer) {
        clearTimeout(replacementDrawRevealTimer);
        replacementDrawRevealTimer = null;
    }
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    replacementDrawRevealTimer = setTimeout(() => {
        replacementDrawRevealTimer = null;
        render();
    }, delayMs);
}

function renderSeatArea(pos, seatId, gameState, canDiscard, delayReplacementDraw = false) {
    const seatKey = String(seatId);
    const hand = Array.isArray(gameState?.hands?.[seatKey]) ? gameState.hands[seatKey] : [];
    const river = Array.isArray(gameState?.rivers?.[seatKey]) ? gameState.rivers[seatKey] : [];
    const shows = Array.isArray(gameState?.shows?.[seatKey]) ? gameState.shows[seatKey] : [];
    const flowers = Array.isArray(gameState?.flowers?.[seatKey]) ? gameState.flowers[seatKey] : [];
    const currentDraw = gameState?.phase === 'playing' ? gameState.currentDraw : null;
    const lastDiscard = gameState?.phase === 'playing' ? gameState.lastDiscard : null;
    const outcome = gameState?.phase === 'ended' ? (gameState?.outcome || null) : null;
    const revealHand = pos === 'bottom' || gameState?.phase === 'ended' || (isSpectatorMode() && gameState?.phase === 'playing');
    const drawHighlightIndex = currentDraw && Number(currentDraw.seatId) === Number(seatId)
        ? findLastTileIndex(hand, currentDraw.tile)
        : -1;
    const winningHighlightIndex = outcome && outcome.isSelfDraw && Number(outcome.winner) === Number(seatId)
        ? findLastTileIndex(hand, outcome.winTile)
        : -1;

    const handEl = document.getElementById(`hand-${pos}`);
    const riverEl = document.getElementById(`river-${pos}`);
    const showEl = document.getElementById(`show-${pos}`);

    if (handEl) {
        if (revealHand) {
            const shouldMoveDrawToTail = pos === 'bottom'
                && drawHighlightIndex >= 0
                && gameState?.phase === 'playing'
                && !!currentDraw
                && Number(currentDraw.seatId) === Number(seatId);
            const handEntries = hand.map((tile, index) => ({ tile, index }));
            if (shouldMoveDrawToTail) {
                const [drawEntry] = handEntries.splice(drawHighlightIndex, 1);
                if (drawEntry) handEntries.push(drawEntry);
            }

            handEl.innerHTML = handEntries.map(({ tile, index }) => renderTileHtml(tile, {
                back: delayReplacementDraw && index === drawHighlightIndex,
                discardIndex: pos === 'bottom' ? index : undefined,
                canDiscard: pos === 'bottom' ? (canDiscard && !(delayReplacementDraw && index === drawHighlightIndex)) : false,
                disabled: delayReplacementDraw && index === drawHighlightIndex,
                selected: pos === 'bottom' && selectedDiscardIndex === index,
                isGold: pos === 'bottom' && tile === gameState?.goldTile,
                newDraw: index === drawHighlightIndex && !delayReplacementDraw,
                drawSeparated: shouldMoveDrawToTail && index === drawHighlightIndex,
                winning: index === winningHighlightIndex
            })).join('');
        } else {
            handEl.innerHTML = hand.map(() => renderTileHtml('', { back: true })).join('');
        }
    }

    if (riverEl) {
        riverEl.innerHTML = river.map((tile, index) => {
            const classes = ['river-tile'];
            const isLastDiscard = !!lastDiscard
                && Number(lastDiscard.seatId) === Number(seatId)
                && index === (river.length - 1)
                && tile === lastDiscard.tile;
            if (isLastDiscard) classes.push('last-discard');

            const isWinningDiscard = !!outcome
                && !outcome.isSelfDraw
                && Number(outcome.loser) === Number(seatId)
                && index === (river.length - 1)
                && tile === outcome.winTile;
            if (isWinningDiscard) classes.push('winning');

            return `<div class="${classes.join(' ')}" title="${tile}">${toTileEmoji(tile)}</div>`;
        }).join('');
    }

    if (showEl) {
        const showHtml = shows.map((group) => renderGroupHtml(group)).join('');
        const flowerHtml = renderFlowerGroupHtml(flowers);
        showEl.innerHTML = `${showHtml}${flowerHtml}`;
    }
}

function renderBoard() {
    const gameState = getGameState();
    clearTurnHighlight();

    if (!gameState || !gameState.hands) {
        selectedDiscardIndex = null;
        document.getElementById('p-bottom')?.classList.remove('ai-takeover');
        setStatus('等待牌局初始化...');
        renderGoldDisplay('');
        PLAYER_POS.forEach((pos) => {
            document.getElementById(`hand-${pos}`)?.replaceChildren();
            document.getElementById(`river-${pos}`)?.replaceChildren();
            document.getElementById(`show-${pos}`)?.replaceChildren();
        });
        renderTrusteeButtons();
        return;
    }

    const baseSeat = getViewerBaseSeat();
    const seatByPos = getSeatByPos(baseSeat);
    const selfSeat = session?.seatId === null || session?.seatId === undefined ? null : Number(session.seatId);
    const selfSeatKey = selfSeat === null ? null : String(selfSeat);
    const control = selfSeatKey === null ? 'human' : (gameState.seatControls?.[selfSeatKey] || 'human');
    const goldReady = isGoldRevealed(gameState);
    const selfClaimOptions = selfSeatKey ? (gameState.pendingClaim?.optionsBySeat?.[selfSeatKey] || null) : null;
    const waitingClaim = !!selfClaimOptions;
    const waitingClaimActive = waitingClaim && isSeatActivePendingDecision(gameState.pendingClaim, selfSeatKey);
    const mustHu = selfSeat !== null && hasMandatorySanJinHu(gameState, selfSeat);
    const canDiscard = selfSeat !== null
        && gameState.phase === 'playing'
        && goldReady
        && gameState.turnSeat === selfSeat
        && control !== 'bot'
        && !gameState.pendingClaim
        && !mustHu;
    const selfHand = selfSeatKey ? (Array.isArray(gameState.hands?.[selfSeatKey]) ? gameState.hands[selfSeatKey] : []) : [];
    if (!Number.isInteger(selectedDiscardIndex) || selectedDiscardIndex < 0 || selectedDiscardIndex >= selfHand.length) {
        selectedDiscardIndex = null;
    }

    renderGoldDisplay((goldReady && gameState.goldTile) ? gameState.goldTile : '');

    const seats = roomState?.seats || {};
    const scores = Array.isArray(gameState.scores) ? gameState.scores : [0, 0, 0, 0];
    const replacementDrawDelayRemaining = getReplacementDrawDelayRemaining(gameState);
    if (replacementDrawDelayRemaining > 0) {
        scheduleReplacementDrawReveal(replacementDrawDelayRemaining + 8);
    }
    const delayedDrawSeat = replacementDrawDelayRemaining > 0 && Number.isInteger(Number(gameState?.currentDraw?.seatId))
        ? Number(gameState.currentDraw.seatId)
        : null;

    PLAYER_POS.forEach((pos) => {
        const seatId = seatByPos[pos];
        const seatObj = seats[String(seatId)] || null;
        const label = getCompactSeatLabel(seatId, seatObj);
        const delayReplacementDraw = delayedDrawSeat !== null && Number(seatId) === delayedDrawSeat;
        renderSeatArea(pos, seatId, gameState, pos === 'bottom' ? canDiscard : false, delayReplacementDraw);
        setBoardScore(
            pos,
            label,
            scores[seatId],
            Number(gameState.dealerSeat) === Number(seatId),
            Number(gameState.dealerStreak || 0)
        );
    });

    document.getElementById('p-bottom')?.classList.toggle('ai-takeover', control === 'bot');

    const turnSeat = Number.isInteger(gameState.turnSeat) ? gameState.turnSeat : -1;
    if (gameState.phase === 'playing' && turnSeat >= 0) {
        const pos = getPosBySeat(baseSeat, turnSeat);
        const area = document.getElementById(`p-${pos}`);
        area?.classList.add('active-turn');
    }

    if (gameState.phase !== 'playing') {
        setStatus('当前已结算，等待下一局');
    } else if (selfSeat === null) {
        setStatus('观战模式');
    } else if (control === 'bot') {
        setStatus('当前 AI 正在代打此座位');
    } else if (!goldReady) {
        if (canOperateDealerAction(gameState)) {
            setStatus('等待你开金，点击屏幕中央“开金”按钮');
        } else if (isDealerBotControlled(gameState)) {
            setStatus('等待房主开金');
        } else {
            const dealerSeat = getDealerSeatNo(gameState);
            const dealerName = dealerSeat === null ? '庄家' : getSettlementSeatLabel(dealerSeat);
            setStatus(`等待庄家开金（${dealerName}）`);
        }
    } else if (waitingClaimActive) {
        setStatus('请先响应：吃 / 碰 / 杠 / 胡 / 过');
    } else if (mustHu) {
        setStatus('当前为三金倒，必须胡牌');
    } else if (canDiscard) {
        setStatus('轮到你出牌，已提牌可打出');
    } else {
        setStatus(`等待轮到你出牌（当前 ${seatNameAbsolute(turnSeat)}位）`);
    }

    renderTrusteeButtons();
}

function renderTrusteeButtons() {
    const buttons = [trusteeBtn, mobileTrusteeBtn].filter((el) => !!el);
    if (!buttons.length) return;

    const selfSeat = getSelfSeatNo();
    const selfSeatKey = selfSeat === null ? null : String(selfSeat);
    const selfSeatObj = selfSeatKey ? (roomState?.seats?.[selfSeatKey] || null) : null;
    const gameState = getGameState();
    const control = selfSeatKey
        ? (gameState?.seatControls?.[selfSeatKey] || selfSeatObj?.control || 'human')
        : 'human';
    const visible = selfSeat !== null && !!selfSeatObj && !selfSeatObj.isBot;
    const isTrustee = visible && control === 'bot';
    const text = isTrustee ? '取消托管' : '托管（弱AI）';

    buttons.forEach((btn) => {
        if (!btn) return;
        btn.style.display = visible ? 'inline-flex' : 'none';
        btn.classList.toggle('active', isTrustee);
        btn.textContent = text;
        btn.disabled = !visible;
        btn.setAttribute('aria-pressed', isTrustee ? 'true' : 'false');
    });
}

function renderAiSpeedToggleButton() {
    const gameState = getGameState();
    const showDesktop = !!roomState && isDesktopViewport() && isHost() && !!gameState;
    const showMobile = !!roomState && isMobileBattleViewport() && isHost() && !!gameState;
    const speedMode = normalizeAiSpeedMode(gameState?.aiSpeedMode);
    const isFast = speedMode === AI_SPEED_MODE.FAST;
    const title = isFast ? 'AI加速已开启，点击切换常速' : 'AI当前常速，点击开启加速';
    const syncButton = (btn, visible) => {
        if (!btn) return;
        if (!visible) {
            btn.style.display = 'none';
            btn.disabled = true;
            btn.classList.remove('fast');
            btn.setAttribute('aria-pressed', 'false');
            btn.title = 'AI加速';
            btn.setAttribute('aria-label', 'AI加速');
            return;
        }
        btn.style.display = 'inline-flex';
        btn.disabled = false;
        btn.classList.toggle('fast', isFast);
        btn.setAttribute('aria-pressed', isFast ? 'true' : 'false');
        btn.title = title;
        btn.setAttribute('aria-label', title);
    };

    syncButton(aiSpeedToggleBtn, showDesktop);
    syncButton(mobileAiSpeedToggleBtn, showMobile);
}

function getActionAudioContext(createIfNeeded = false) {
    if (actionAudioCtx) return actionAudioCtx;
    if (!createIfNeeded) return null;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;

    try {
        actionAudioCtx = new Ctx();
    } catch {
        return null;
    }
    return actionAudioCtx;
}

function hasUserActivationGesture() {
    return !!(navigator.userActivation && navigator.userActivation.isActive);
}

function tryUnlockActionAudio(fromGesture = false) {
    const ctx = getActionAudioContext(true);
    if (!ctx) {
        renderAudioDiagnostic('unlock:no-ctx');
        return false;
    }

    if (ctx.state === 'running' || ctx.state === 'interrupted') {
        actionAudioUnlocked = true;
        renderAudioDiagnostic(fromGesture ? 'unlock:ready-gesture' : 'unlock:ready');
        return true;
    }

    if (fromGesture && ctx.state === 'suspended') {
        ctx.resume().then(() => {
            if (ctx.state === 'running' || ctx.state === 'interrupted') {
                actionAudioUnlocked = true;
                renderAudioDiagnostic('unlock:resumed');
            }
        }).catch(() => {});
    }

    renderAudioDiagnostic(fromGesture ? 'unlock:pending-gesture' : 'unlock:pending');
    return actionAudioUnlocked;
}

function getActionVoiceProfile() {
    if (!('speechSynthesis' in window)) {
        return { voice: null, isMinnan: false, mandarinVoice: null };
    }
    if (actionVoiceProfile) return actionVoiceProfile;

    const voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
    const preferred = voices.slice().sort((a, b) => Number(!!b.localService) - Number(!!a.localService));
    const minnanReg = /hokkien|hok[- ]?lo|min[- ]?nan|tai[- ]?yu|台语|臺語|闽南|閩南|nan[-_]?tw|taiwanese/i;
    const cantoneseReg = /canton|yue|粤语|粵語|廣東|广东|hong kong|zh[-_]?hk|hk\b/i;
    const mandarinReg = /mandarin|putonghua|普通话|國語|国语|华语|中文|chinese|zh[-_]?cn|zh[-_]?tw|cmn/i;
    const voiceLabel = (v) => `${v?.name || ''} ${v?.lang || ''}`;
    const isCantoneseVoice = (v) => cantoneseReg.test(voiceLabel(v));
    const findVoice = (matcher) => preferred.find((v) => matcher(v) && !isCantoneseVoice(v)) || null;

    const minnanVoice = findVoice((v) => minnanReg.test(voiceLabel(v)));
    const mandarinVoice = findVoice((v) => mandarinReg.test(voiceLabel(v)))
        || findVoice((v) => /^zh/i.test(String(v?.lang || '')))
        || null;

    if (minnanVoice) {
        actionVoiceProfile = { voice: minnanVoice, isMinnan: true, mandarinVoice };
        return actionVoiceProfile;
    }

    actionVoiceProfile = { voice: mandarinVoice, isMinnan: false, mandarinVoice };
    return actionVoiceProfile;
}

if ('speechSynthesis' in window && window.speechSynthesis.addEventListener) {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
        actionVoiceProfile = null;
        actionVoicePrimed = false;
    });
}

function primeActionVoiceEngine(fromGesture = false) {
    if (fromGesture) tryUnlockActionAudio(true);
    if (actionAudioUnlocked) {
        const ctx = getActionAudioContext(false);
        if (ctx && ctx.state === 'suspended' && hasUserActivationGesture()) {
            ctx.resume().catch(() => {});
        }
    }

    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.resume();

    if (actionVoicePrimed) return;
    actionVoicePrimed = true;
    getActionVoiceProfile();
    renderAudioDiagnostic(fromGesture ? 'prime:gesture' : 'prime');
}

function setupActionAudioUnlock() {
    const unlock = (event) => {
        if (event && event.isTrusted === false) return;
        primeActionVoiceEngine(true);
        if (!actionAudioUnlocked) return;
        AUDIO_UNLOCK_EVENTS.forEach((evt) => document.removeEventListener(evt, unlock, true));
    };

    AUDIO_UNLOCK_EVENTS.forEach((evt) => {
        document.addEventListener(evt, unlock, { capture: true });
    });
}

function speakActionText(text, options = {}) {
    if (!text || !('speechSynthesis' in window)) return;

    const synth = window.speechSynthesis;
    const fallbackTried = options.fallbackTried === true;
    const fallback = options.fallback || null;
    const diagLabel = options.diagLabel || text;
    const seq = ++actionSpeechSeq;
    let started = false;

    const retryFallback = (reason = 'unknown') => {
        if (fallbackTried) return;
        if (!fallback || !fallback.text) return;
        if (seq !== actionSpeechSeq) return;
        renderAudioDiagnostic(`voice:fallback:mandarin:${reason}:${diagLabel}`);
        speakActionText(fallback.text, {
            voice: fallback.voice || null,
            lang: fallback.lang || 'zh-CN',
            rate: fallback.rate ?? 1,
            pitch: fallback.pitch ?? 1,
            volume: fallback.volume ?? 1,
            diagLabel: fallback.diagLabel || `${diagLabel}:fallback`,
            fallbackTried: true
        });
    };

    const utter = new SpeechSynthesisUtterance(text);
    if (options.voice) utter.voice = options.voice;
    utter.lang = options.lang || options.voice?.lang || 'zh-CN';
    utter.rate = options.rate ?? 1;
    utter.pitch = options.pitch ?? 1;
    utter.volume = options.volume ?? 1;
    utter.onstart = () => {
        if (seq !== actionSpeechSeq) return;
        started = true;
        renderAudioDiagnostic(`voice:start:${diagLabel}`);
    };
    utter.onerror = () => {
        if (seq !== actionSpeechSeq) return;
        renderAudioDiagnostic(`voice:error:${diagLabel}`);
        retryFallback('error');
    };

    try {
        synth.cancel();
        synth.resume();
        synth.speak(utter);
    } catch {
        renderAudioDiagnostic(`voice:throw:${diagLabel}`);
        retryFallback('throw');
        return;
    }

    if (!fallbackTried) {
        setTimeout(() => {
            if (seq !== actionSpeechSeq) return;
            if (started) return;
            if (synth.speaking || synth.pending) return;
            retryFallback('nostart');
        }, 260);
    }
}

function playActionSfx(type = '') {
    const conf = ACTION_SFX_MAP[type];
    if (!conf) return;

    const hasGesture = hasUserActivationGesture();
    if (hasGesture) tryUnlockActionAudio(true);
    if (!actionAudioUnlocked && !hasGesture) {
        renderAudioDiagnostic(`sfx:${type}:blocked`);
        return;
    }

    const ctx = getActionAudioContext(true);
    if (!ctx) {
        renderAudioDiagnostic(`sfx:${type}:no-ctx`);
        return;
    }
    if (ctx.state === 'suspended') {
        if (!hasGesture) {
            renderAudioDiagnostic(`sfx:${type}:suspended`);
            return;
        }
        ctx.resume().then(() => {
            if (ctx.state === 'running' || ctx.state === 'interrupted') {
                actionAudioUnlocked = true;
                renderAudioDiagnostic(`sfx:${type}:resumed`);
                playActionSfx(type);
            }
        }).catch(() => {});
        return;
    }
    if (ctx.state !== 'running' && ctx.state !== 'interrupted') {
        renderAudioDiagnostic(`sfx:${type}:state-${ctx.state}`);
        return;
    }
    actionAudioUnlocked = true;

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

    if (type === 'OPEN_GOLD') {
        const chimeFreqList = [conf.f * 0.88, conf.f * 1.18, conf.f * 1.44];
        chimeFreqList.forEach((freq, idx) => {
            const startAt = now + 0.06 + idx * 0.09;
            const chimeOsc = ctx.createOscillator();
            const chimeGain = ctx.createGain();

            chimeOsc.type = idx === chimeFreqList.length - 1 ? 'triangle' : 'sine';
            chimeOsc.frequency.setValueAtTime(freq, startAt);
            chimeOsc.frequency.exponentialRampToValueAtTime(freq * 1.06, startAt + 0.08);

            chimeGain.gain.setValueAtTime(0.0001, startAt);
            chimeGain.gain.exponentialRampToValueAtTime(0.1, startAt + 0.012);
            chimeGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.14);

            chimeOsc.connect(chimeGain);
            chimeGain.connect(ctx.destination);
            chimeOsc.start(startAt);
            chimeOsc.stop(startAt + 0.16);
        });
    }
    renderAudioDiagnostic(`sfx:${type}:played`);
}

function playActionVoice(type = '') {
    const voiceItem = ACTION_VOICE_MAP[type];
    if (!voiceItem) {
        playActionSfx(type);
        return;
    }

    primeActionVoiceEngine(hasUserActivationGesture());
    playActionSfx(type);

    const profile = getActionVoiceProfile();
    const mode = actionVoiceMode;
    let text = voiceItem.mandarin || voiceItem.minnan || '';
    let voice = profile.voice || null;
    let lang = voice?.lang || 'zh-CN';
    let rate = 1.02;
    let diagLabel = `${type}:auto`;
    let fallback = null;

    if (mode === ACTION_VOICE_MODE.FORCE_MINNAN) {
        text = voiceItem.minnan || voiceItem.mandarin || '';
        voice = profile.voice || profile.mandarinVoice || null;
        lang = voice?.lang || 'nan-TW';
        rate = 1.08;
        diagLabel = `${type}:force_minnan`;
    } else if (mode === ACTION_VOICE_MODE.FORCE_MANDARIN) {
        text = voiceItem.mandarin || voiceItem.minnan || '';
        voice = profile.mandarinVoice || profile.voice || null;
        lang = voice?.lang || 'zh-CN';
        rate = 1.02;
        diagLabel = `${type}:force_mandarin`;
    } else {
        const useMinnan = !!profile.isMinnan;
        text = useMinnan ? (voiceItem.minnan || voiceItem.mandarin || '') : (voiceItem.mandarin || voiceItem.minnan || '');
        voice = profile.voice || null;
        lang = useMinnan ? (voice?.lang || 'nan-TW') : (voice?.lang || 'zh-CN');
        rate = useMinnan ? 1.08 : 1.02;
        diagLabel = `${type}:${useMinnan ? 'minnan' : 'mandarin'}`;
        const fallbackVoice = profile.mandarinVoice || null;
        const fallbackText = voiceItem.mandarin || text;
        fallback = {
            text: fallbackText,
            voice: fallbackVoice,
            lang: fallbackVoice?.lang || 'zh-CN',
            rate: 1,
            pitch: 1,
            volume: 1,
            diagLabel: `${type}:mandarin-fallback`
        };
    }

    const speakOptions = { voice, lang, rate, diagLabel };
    if (fallback && mode === ACTION_VOICE_MODE.AUTO) {
        speakOptions.fallback = fallback;
    }
    speakActionText(text, speakOptions);
}

function actionAudioKey(gameState = null) {
    const action = gameState?.lastAction || null;
    if (!action || typeof action !== 'object') return '';
    if (!action.type) return '';
    const seatId = Number.isInteger(action.seatId) ? action.seatId : 'x';
    const ts = Number.isFinite(action.ts) ? action.ts : 'x';
    const actionSerial = Array.isArray(gameState?.actionLog) ? gameState.actionLog.length : 'x';
    return `${action.type}|${seatId}|${ts}|${actionSerial}`;
}

function actionEffectText(actionType = '') {
    const map = {
        CHI: '吃',
        PENG: '碰',
        GANG: '杠',
        AN_GANG: '暗杠',
        BU_GANG: '补杠',
        HU: '胡',
        FLOWER_REPLENISH: '补花'
    };
    return map[actionType] || '';
}

function showActionEffect(seatId, actionType = '') {
    const text = actionEffectText(actionType);
    if (!text) return;

    const effect = document.createElement('div');
    effect.className = 'action-effect';
    const pos = getPosBySeat(getViewerBaseSeat(), Number(seatId));
    effect.style.setProperty('--seat-rotate', `${getSeatTextRotationDegByPos(pos)}deg`);
    if (actionType === 'FLOWER_REPLENISH') {
        effect.classList.add('flower');
    }
    effect.textContent = text;
    if (!placeEffectAtSeat(effect, seatId, { verticalRatio: 0.46 })) {
        const area = document.getElementById(`p-${pos}`);
        if (!area) return;
        area.appendChild(effect);
    }
    setTimeout(() => effect.remove(), 850);
}

function syncActionAudio(gameState = null, primeOnly = false) {
    const action = gameState?.lastAction || null;
    const key = actionAudioKey(gameState);
    if (!key) return;
    if (key === lastActionAudioKey) return;
    if (primeOnly) {
        lastActionAudioKey = key;
        return;
    }

    lastActionAudioKey = key;
    const type = String(action.type || '').toUpperCase();
    const seatId = Number.isInteger(action.seatId) ? action.seatId : null;
    if (type === 'DISCARD') {
        playActionSfx('DISCARD');
        return;
    }
    if (['CHI', 'PENG', 'GANG', 'AN_GANG', 'BU_GANG', 'HU', 'FLOWER_REPLENISH'].includes(type)) {
        if (seatId !== null) {
            showActionEffect(seatId, type);
        }
        playActionVoice(type);
        renderAudioDiagnostic(`sync:${type}`);
    }
}

function flowerCueKey(gameState = null) {
    const draw = gameState?.currentDraw || null;
    if (!draw) return '';
    const reason = String(draw.reason || '').toUpperCase();
    if (!FLOWER_DRAW_REASONS.has(reason)) return '';
    const seatId = Number.isInteger(Number(draw.seatId)) ? Number(draw.seatId) : 'x';
    const tile = String(draw.tile || '');
    const ts = Number.isFinite(draw.ts) ? draw.ts : 'x';
    return `${seatId}|${tile}|${reason}|${ts}`;
}

function syncFlowerCue(gameState = null, primeOnly = false) {
    const key = flowerCueKey(gameState);
    if (!key) return;
    if (key === lastFlowerCueKey) return;
    if (primeOnly) {
        lastFlowerCueKey = key;
        return;
    }

    lastFlowerCueKey = key;
    const draw = gameState?.currentDraw || null;
    if (!draw) return;
    const seatId = Number.isInteger(Number(draw.seatId)) ? Number(draw.seatId) : null;
    const delayMs = getReplacementDrawDelayRemaining(gameState);
    const cueDelayMs = delayMs > 0 ? delayMs + 8 : 0;

    if (flowerCueTimer) {
        clearTimeout(flowerCueTimer);
        flowerCueTimer = null;
    }

    flowerCueTimer = setTimeout(() => {
        flowerCueTimer = null;
        if (seatId !== null) {
            showActionEffect(seatId, 'FLOWER_REPLENISH');
        }
        playActionVoice('FLOWER_REPLENISH');
    }, cueDelayMs);
}

function getLatestChuiFengLog(gameState = null) {
    const logs = Array.isArray(gameState?.instantScoreLog) ? gameState.instantScoreLog : [];
    for (let i = logs.length - 1; i >= 0; i -= 1) {
        const entry = logs[i];
        if (String(entry?.type || '').toUpperCase() === 'CHUI_FENG') {
            return entry;
        }
    }
    return null;
}

function chuiFengCueKey(gameState = null) {
    const entry = getLatestChuiFengLog(gameState);
    if (!entry) return '';
    const seatId = Number.isInteger(Number(entry.seatId)) ? Number(entry.seatId) : 'x';
    const tile = String(entry.targetTile || '');
    const ts = Number.isFinite(entry.ts) ? entry.ts : 'x';
    return `${seatId}|${tile}|${ts}`;
}

function showChuiFengEffect() {
    const table = document.getElementById('table');
    if (!table) return;
    const layer = getTableEffectLayer() || table;
    const effect = document.createElement('div');
    effect.className = 'chui-feng-effect';
    effect.textContent = '吹风';
    layer.appendChild(effect);
    setTimeout(() => effect.remove(), 1000);
}

function syncChuiFengCue(gameState = null, primeOnly = false) {
    const key = chuiFengCueKey(gameState);
    if (!key) return;
    if (key === lastChuiFengCueKey) return;
    if (primeOnly) {
        lastChuiFengCueKey = key;
        return;
    }
    lastChuiFengCueKey = key;
    showChuiFengEffect();
    playActionVoice('CHUI_FENG');
    renderAudioDiagnostic('sync:CHUI_FENG');
}

function goldRevealEffectKey(gameState = null) {
    if (!gameState || gameState.goldRevealed !== true || !gameState.goldTile) return '';
    const revealAt = Number(gameState.goldRevealedAt || 0);
    return `${Number(gameState.roundNo || 0)}|${String(gameState.goldTile)}|${revealAt || 0}`;
}

function showGoldRevealEffect(tileCode = '') {
    if (!goldRevealFxEl || !tileCode) return;
    if (goldRevealFxTimer) {
        clearTimeout(goldRevealFxTimer);
        goldRevealFxTimer = null;
    }
    const tileLabel = escapeHtml(tileCode);
    const tileText = escapeHtml(toTileEmoji(tileCode));
    goldRevealFxEl.innerHTML = `
        <div class="gold-reveal-burst"></div>
        <div class="gold-reveal-title">开金</div>
        <div class="gold-reveal-tile">
            <div class="gold-reveal-tile-face" title="${tileLabel}">
                <span class="gold-reveal-tile-glyph">${tileText}</span>
            </div>
        </div>
    `;
    goldRevealFxEl.classList.add('show');
    goldRevealFxTimer = setTimeout(() => {
        goldRevealFxTimer = null;
        goldRevealFxEl.classList.remove('show');
        goldRevealFxEl.innerHTML = '';
    }, GOLD_REVEAL_FX_DURATION_MS);
}

function syncGoldRevealEffect(gameState = null, primeOnly = false) {
    const key = goldRevealEffectKey(gameState);
    if (!key) {
        lastGoldRevealEffectKey = '';
        return;
    }
    if (key === lastGoldRevealEffectKey) return;
    if (primeOnly) {
        lastGoldRevealEffectKey = key;
        return;
    }

    lastGoldRevealEffectKey = key;
    showGoldRevealEffect(gameState?.goldTile || '');
    playActionVoice('OPEN_GOLD');
    renderAudioDiagnostic('sync:OPEN_GOLD');
}

function buildActionButton(label, attrs = {}) {
    const pairs = Object.entries(attrs).map(([k, v]) => `${k}="${escapeHtml(v)}"`).join(' ');
    return `<button class="btn-act" ${pairs}>${escapeHtml(label)}</button>`;
}

function parseTileCodeForSort(tile = '') {
    const match = String(tile || '').match(/^([A-Za-z])(\d)$/);
    if (!match) return null;
    return {
        suit: match[1].toUpperCase(),
        value: Number(match[2])
    };
}

function sortTileCodesForDisplay(tiles = []) {
    const suitOrder = { W: 0, T: 1, S: 2, H: 3, Z: 4 };
    return [...tiles].sort((a, b) => {
        const pa = parseTileCodeForSort(a);
        const pb = parseTileCodeForSort(b);
        if (pa && pb) {
            if (pa.suit !== pb.suit) {
                return (suitOrder[pa.suit] ?? 99) - (suitOrder[pb.suit] ?? 99);
            }
            return pa.value - pb.value;
        }
        return String(a).localeCompare(String(b), 'zh-CN');
    });
}

function buildChiChoiceButton(choice = [], discardTile = '', goldTile = '') {
    const toDisplayTileCode = (tileCode) => {
        if (tileCode === goldTile && goldTile && goldTile !== WHITE_DRAGON_TILE_CODE) {
            return WHITE_DRAGON_TILE_CODE;
        }
        return tileCode;
    };
    const tiles = [];
    if (Array.isArray(choice)) {
        choice.forEach((tile) => {
            if (tile) tiles.push(String(tile));
        });
    }
    if (discardTile) tiles.push(String(discardTile));
    const orderedTiles = sortTileCodesForDisplay(tiles).slice(0, 3);
    const choicePayload = escapeHtml(JSON.stringify(choice));
    if (orderedTiles.length === 3) {
        const chips = orderedTiles.map((tileCode) => renderTileHtml(toDisplayTileCode(tileCode))).join('');
        return `<button class="btn-act chi-option-btn" data-reaction-type="CHI" data-reaction-choice="${choicePayload}"><span class="chi-option-tiles">${chips}</span></button>`;
    }
    return `<button class="btn-act chi-option-btn" data-reaction-type="CHI" data-reaction-choice="${choicePayload}">吃</button>`;
}

function renderActionBar() {
    if (!actionBarEl) return;
    actionBarEl.classList.remove('chi-three-mobile');
    const gameState = getGameState();
    if (!gameState || !session || session.seatId === null || session.seatId === undefined) {
        resetReactionBarStableGate();
        chiSubMenuOpen = false;
        actionBarEl.innerHTML = '';
        actionBarEl.classList.add('hidden');
        return;
    }

    const seatId = String(session.seatId);
    const control = gameState?.seatControls?.[seatId] || 'human';
    if (control === 'bot') {
        resetReactionBarStableGate();
        chiSubMenuOpen = false;
        actionBarEl.innerHTML = '';
        actionBarEl.classList.add('hidden');
        return;
    }

    if (!isGoldRevealed(gameState)) {
        resetReactionBarStableGate();
        chiSubMenuOpen = false;
        actionBarEl.innerHTML = '';
        actionBarEl.classList.add('hidden');
        return;
    }

    const pending = gameState.pendingClaim || null;
    const controls = [];

    if (pending) {
        if (shouldLockReactionBar(roomState?.actions || {}, pending, seatId)) {
            resetReactionBarStableGate();
            chiSubMenuOpen = false;
            actionBarEl.innerHTML = '';
            actionBarEl.classList.add('hidden');
            return;
        }

        const options = pending.optionsBySeat?.[seatId];
        if (!options) {
            resetReactionBarStableGate();
            chiSubMenuOpen = false;
            actionBarEl.innerHTML = '';
            actionBarEl.classList.add('hidden');
            return;
        }
        if (!isSeatActivePendingDecision(pending, seatId)) {
            resetReactionBarStableGate();
            chiSubMenuOpen = false;
            actionBarEl.innerHTML = '';
            actionBarEl.classList.add('hidden');
            return;
        }
        const stableKey = buildReactionBarStableKey(pending, seatId);
        if (!stableKey) {
            resetReactionBarStableGate();
        } else if (shouldHoldReactionBarUntilStable(stableKey)) {
            chiSubMenuOpen = false;
            actionBarEl.innerHTML = '';
            actionBarEl.classList.add('hidden');
            return;
        }

        const chiChoices = Array.isArray(options.CHI) ? options.CHI : [];
        if (!chiChoices.length) chiSubMenuOpen = false;
        if (chiSubMenuOpen && chiChoices.length) {
            chiChoices.forEach((choice) => {
                controls.push(buildChiChoiceButton(choice, pending?.discard?.tile || '', gameState.goldTile || ''));
            });
            controls.push(buildActionButton('取消', { 'data-cancel-chi': '1' }));
            const isMobilePortrait = !!(window.matchMedia && window.matchMedia('(max-width: 767px) and (orientation: portrait)').matches);
            const isThreeChiMobile = isMobilePortrait && chiChoices.length === 3;
            actionBarEl.classList.toggle('chi-three-mobile', isThreeChiMobile);
        } else {
            if (options.HU) controls.push(buildActionButton('胡', { 'data-reaction-type': 'HU' }));
            if (options.PENG) controls.push(buildActionButton('碰', { 'data-reaction-type': 'PENG' }));
            if (options.GANG) controls.push(buildActionButton('杠', { 'data-reaction-type': 'GANG' }));
            if (chiChoices.length) controls.push(buildActionButton('吃', { 'data-open-chi': '1' }));
            controls.push(buildActionButton('过', { 'data-reaction-type': 'PASS' }));
        }
    } else if (gameState.phase === 'playing' && gameState.turnSeat === Number(seatId)) {
        resetReactionBarStableGate();
        chiSubMenuOpen = false;
        const hand = gameState.hands?.[seatId] || [];
        const goldTile = gameState.goldTile;
        const isSelfDrawState = Number(gameState?.currentDraw?.seatId) === Number(seatId) && !!gameState?.currentDraw?.tile;
        const selfHuInfo = isSelfDrawState ? getSelfDrawHuInfo(gameState, Number(seatId)) : { canHu: false, types: [] };
        const canHu = !!selfHuInfo?.canHu;
        const mustHu = canHu && Array.isArray(selfHuInfo.types) && selfHuInfo.types.includes('三金倒');
        const huKey = canHu ? selfHuPromptKey(gameState, Number(seatId)) : '';
        const huSkipped = !!huKey && huKey === skippedSelfHuPromptKey;

        if (!mustHu) {
            const countMap = {};
            hand.forEach((tile) => {
                if (tile === goldTile || tile?.startsWith('H')) return;
                countMap[tile] = (countMap[tile] || 0) + 1;
            });
            Object.keys(countMap).filter((tile) => countMap[tile] === 4).forEach((tile) => {
                controls.push(buildActionButton(`暗杠 ${toTileEmoji(tile)}`, {
                    'data-turn-type': 'AN_GANG',
                    'data-turn-char': tile
                }));
            });

            const showGroups = gameState.shows?.[seatId] || [];
            const buGangSet = new Set();
            showGroups.forEach((g) => {
                if (g?.type !== 'PENG' || !Array.isArray(g.tiles) || !g.tiles.length) return;
                const tile = g.tiles[0];
                if (hand.includes(tile)) buGangSet.add(tile);
            });
            [...buGangSet].forEach((tile) => {
                controls.push(buildActionButton(`补杠 ${toTileEmoji(tile)}`, {
                    'data-turn-type': 'BU_GANG',
                    'data-turn-char': tile
                }));
            });
        }

        if (canHu && !huSkipped) {
            controls.push(buildActionButton('胡', { 'data-turn-type': 'HU' }));
            if (!mustHu) {
                controls.push(buildActionButton('过', { 'data-turn-pass-hu': '1' }));
            }
        }
    } else {
        resetReactionBarStableGate();
    }

    actionBarEl.innerHTML = controls.join('');
    actionBarEl.classList.toggle('hidden', controls.length === 0);
}

function formatInstantTs(ts) {
    if (!Number.isFinite(ts)) return '--:--:--';
    try {
        return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
    } catch {
        return '--:--:--';
    }
}

function formatInstantType(entry = {}) {
    const seatText = getInstantSeatLabel(entry.seatId);
    if (entry.type === 'AN_GANG') return `暗杠 ${seatText}`;
    if (entry.type === 'MING_GANG') return `明/补杠 ${seatText}`;
    if (entry.type === 'HU_SETTLE') {
        const winner = Number.isInteger(entry.winnerSeat) ? getInstantSeatLabel(entry.winnerSeat) : seatText;
        const headlineRaw = buildOutcomeHeadline({
            isSelfDraw: !!entry.isSelfDraw,
            specialTypes: Array.isArray(entry.specialTypes) ? entry.specialTypes : [],
            flowerCount: Number(entry.flowerCount || 0),
            waterMul: Number(entry.waterMul || 1)
        });
        const headline = String(headlineRaw || '').replace(/点炮$/, '点炮胡');
        return headline ? `胡牌结算 ${winner} ${headline}` : `胡牌结算 ${winner}`;
    }
    if (entry.type === 'CHUI_FENG') {
        const tileText = entry.targetTile ? ` ${toTileEmoji(entry.targetTile)}` : '';
        return `吹风 庄家 ${seatText}${tileText}`;
    }
    return entry.type || '即时分';
}

function formatInstantRound(entry = {}) {
    const roundNo = Number(entry?.roundNo);
    if (!Number.isInteger(roundNo) || roundNo <= 0) return '第?局';
    return `第${roundNo}局`;
}

function formatInstantDeltaLine(delta = []) {
    return [0, 1, 2, 3].map((seatId) => {
        const value = Number(delta[seatId] || 0);
        const sign = value >= 0 ? '+' : '';
        return `${getInstantSeatLabel(seatId)} ${sign}${value}`;
    }).join(' | ');
}

function formatInstantDeltaLineHtml(delta = [], entry = {}, options = {}) {
    const showDealerBadge = options?.showDealerBadge === true;
    const dealerSeat = showDealerBadge && Number.isInteger(Number(entry?.dealerSeat))
        ? Number(entry.dealerSeat)
        : null;
    return [0, 1, 2, 3].map((seatId) => {
        const value = Number(delta[seatId] || 0);
        const sign = value > 0 ? '+' : '';
        const scoreClass = value > 0
            ? 'instant-delta-plus'
            : (value < 0 ? 'instant-delta-minus' : 'instant-delta-zero');
        const seatText = escapeHtml(getInstantSeatLabel(seatId));
        const dealerBadge = dealerSeat !== null && Number(seatId) === dealerSeat
            ? '<span class="dealer-badge instant-dealer-badge">庄</span>'
            : '';
        return `<span class="instant-seat-delta">${dealerBadge}${seatText} <span class="instant-delta-value ${scoreClass}">${sign}${value}</span></span>`;
    }).join('<span class="instant-delta-sep"> | </span>');
}

function renderInstantScoreLog() {
    if (!instantScoreLogEl) return;
    const gameState = getGameState();

    if (!gameState) {
        instantScoreLogEl.innerHTML = '<div class="instant-empty">等待牌局初始化...</div>';
        return;
    }

    const logs = Array.isArray(gameState.instantScoreLog) ? gameState.instantScoreLog : [];
    if (!logs.length) {
        instantScoreLogEl.innerHTML = '<div class="instant-empty">暂无即时分记录</div>';
        return;
    }

    const rows = logs.slice().reverse().map((entry) => {
        const deltaHtml = formatInstantDeltaLineHtml(entry.delta || [], entry, {
            showDealerBadge: entry?.type === 'HU_SETTLE'
        });
        return `
        <div class="instant-row">
            <div class="instant-type">${escapeHtml(formatInstantRound(entry))} · ${escapeHtml(formatInstantType(entry))} · ${escapeHtml(formatInstantTs(entry.ts))}</div>
            <div class="instant-delta">${deltaHtml}</div>
        </div>
    `;
    });
    instantScoreLogEl.innerHTML = rows.join('');
}

function outcomeKey(outcome = null) {
    if (!outcome) return '';
    const ts = Number.isFinite(outcome.ts) ? outcome.ts : 0;
    return `${outcome.winner}-${outcome.isSelfDraw ? 'zimo' : 'dianpao'}-${outcome.totalWin}-${ts}`;
}

function buildOutcomeFormulaText(outcome = null) {
    if (!outcome || typeof outcome !== 'object') return '';

    const winner = Number(outcome.winner);
    const loser = Number(outcome.loser);
    const dealer = Number(outcome.dealerBefore);
    const streak = Number(outcome.dealerStreakBefore || 0);
    const total = Math.floor(Number(outcome.totalWin || 0));
    const scoreAsSelfDraw = !!outcome.scoreAsSelfDraw;
    const isQiangGangHu = Array.isArray(outcome.specialTypes) && outcome.specialTypes.includes('抢杠胡');
    const winnerIsDealer = winner === dealer;
    const multiplierLabels = buildOutcomeMultiplierLabels(outcome);
    const multiplierSuffix = multiplierLabels.length ? ` ${multiplierLabels.join(' ')}` : '';

    if (isQiangGangHu && Number.isInteger(loser) && loser >= 0 && loser <= 3) {
        if (winnerIsDealer) {
            const dealerMul = streak >= 1 ? Math.pow(2, streak) : 1;
            const basePart = `(1底×${2 * dealerMul}庄家)${multiplierSuffix}×3闲家`;
            return `${basePart}（杠者代付三家） = ${total}`;
        }
        const zhuangPart = `(1底+1庄)${multiplierSuffix}×1庄家`;
        const xianPart = `(1底)${multiplierSuffix}×2闲家`;
        return `${zhuangPart} + ${xianPart}（杠者代付三家） = ${total}`;
    }

    if (winnerIsDealer) {
        const dealerMul = streak >= 1 ? Math.pow(2, streak) : 1;
        const baseMul = dealerMul * 2;
        const basePart = scoreAsSelfDraw
            ? `(1底×${baseMul}庄家+1自摸)×3闲家`
            : `(1底×${baseMul}庄家)×3闲家`;
        const payerPart = '×3闲家';
        const normalizedBasePart = basePart.replace(/×3闲家$/, '');
        return `${normalizedBasePart}${multiplierSuffix}${payerPart} = ${total}`;
    }

    const baseStr = scoreAsSelfDraw ? '1底+1自摸' : '1底';
    const xianPart = `(${baseStr})${multiplierSuffix}×2闲家`;
    const zhuangPart = `(${baseStr}+1庄)${multiplierSuffix}×1庄家`;
    return `${xianPart} + ${zhuangPart} = ${total}`;
}

function renderOutcome() {
    const gameState = getGameState();
    const outcome = gameState?.outcome || null;
    const key = outcomeKey(outcome);
    const selfSeat = getSelfSeatNo();
    const canOperateRound = selfSeat !== null;
    const openGoldDisplay = canOperateRound
        && gameState?.phase === 'playing'
        && gameState?.goldRevealed === false
        ? 'inline-flex'
        : 'none';
    if (centerOpenGoldBtn) centerOpenGoldBtn.style.display = openGoldDisplay;

    const nextRoundDisplay = canOperateRound
        && gameState?.phase === 'ended'
        && !!outcome
        ? 'inline-flex'
        : 'none';
    if (nextRoundBtn) nextRoundBtn.style.display = nextRoundDisplay;
    if (mobileNextRoundBtn) mobileNextRoundBtn.style.display = nextRoundDisplay;
    if (centerNextRoundBtn) centerNextRoundBtn.style.display = nextRoundDisplay;

    if (!huOverlayEl || !gameState || gameState.phase !== 'ended' || !outcome) {
        if (huOverlayEl) huOverlayEl.style.display = 'none';
        dismissedOutcomeKey = null;
        return;
    }

    const payout = Array.isArray(outcome.payout) ? outcome.payout : [];

    const headline = buildOutcomeHeadline(outcome);
    const winnerNickname = getSeatNickname(outcome.winner);
    const outcomeFormula = buildOutcomeFormulaText(outcome);

    if (huMainTextEl) {
        const mainHeadline = headline || (outcome.isSelfDraw ? '自摸' : '点炮');
        const panelHeadline = outcome.isSelfDraw ? mainHeadline : mainHeadline.replace(/点炮$/, '点炮胡');
        huMainTextEl.textContent = `${winnerNickname} ${panelHeadline}`.trim();
        applyOutcomeTextEffectClasses(huMainTextEl, outcome);
    }
    if (huDetailTextEl) {
        huDetailTextEl.textContent = '';
    }
    if (huScoreTextEl) {
        huScoreTextEl.textContent = outcomeFormula;
    }
    if (huFormulaTextEl) {
        huFormulaTextEl.textContent = '';
    }
    applyOutcomeOverlayEffectClasses(huOverlayEl, outcome);

    if (settlePanelEl) {
        const totalScores = Array.isArray(gameState?.scores) ? gameState.scores : [0, 0, 0, 0];
        const selfSeatNo = normalizeSeatNo(session?.seatId, null);
        const lines = [0, 1, 2, 3].map((seatId) => {
            const value = Number(payout[seatId] || 0);
            const totalScore = Math.floor(Number(totalScores[seatId] || 0));
            const className = value >= 0 ? 'settle-plus' : 'settle-minus';
            const sign = value >= 0 ? '+' : '';
            const totalSign = totalScore >= 0 ? '+' : '';
            const seatLabel = escapeHtml(getSettlementSeatLabel(seatId));
            const isSelfRow = selfSeatNo !== null && Number(selfSeatNo) === Number(seatId);
            const nameClass = isSelfRow ? 'settle-name settle-name-self' : 'settle-name';
            return `<div class="settle-row"><span class="${nameClass}">${seatLabel}</span><span class="settle-score ${className}">${sign}${value}</span><span class="settle-total">${totalSign}${totalScore}</span></div>`;
        }).join('');

        settlePanelEl.innerHTML = `<div class="settle-title">四家分数结算</div><div class="settle-head"><span class="settle-name"></span><span class="settle-head-cell">本局得失</span><span class="settle-head-cell">总分</span></div>${lines}<div class="settle-tip">点击屏幕可关闭</div>`;
    }

    if (dismissedOutcomeKey === key) {
        huOverlayEl.style.display = 'none';
        return;
    }

    huOverlayEl.style.display = 'flex';
    fitOutcomeOverlayText();
    requestAnimationFrame(() => fitOutcomeOverlayText());
}

function render() {
    renderRoomMeta();
    renderRoomActionSummary();
    renderBoard();
    renderTrusteeButtons();
    renderAiSpeedToggleButton();
    renderTableOutcomeEffects();
    renderActionBar();
    renderInstantScoreLog();
    renderOutcome();
    renderAudioDiagnostic('render');
}

function kickHostLoopSoon() {
    if (!isHost()) return;
    hostLoopBurstUntil = Math.max(hostLoopBurstUntil, Date.now() + HOST_LOOP_BURST_WINDOW_MS);
    scheduleHostLoop(0, true);
}

async function submitIntent(type, payload = {}, options = {}) {
    if (!roomState || !session) return false;
    const seatId = getSelfSeatNo();
    if (seatId === null) {
        setStatus('观战状态不可操作', true);
        return false;
    }
    const action = createAction({
        type,
        seatId,
        payload,
        clientActionId: `${session.uid}-${Date.now()}`,
        ts: Date.now()
    });

    setStatus(options.pendingText || `提交 ${type}...`);
    try {
        await submitActionIntent(roomCode, session.uid, action);
        kickHostLoopSoon();
        setStatus(options.successText || `已提交 ${type}`);
        return true;
    } catch (error) {
        setStatus(error.message || '提交失败', true);
        return false;
    }
}

async function handleHandClick(event) {
    if (event?.isTrusted) {
        primeActionVoiceEngine(true);
    }
    if (isSpectatorMode()) return;
    const tile = event.target.closest('[data-discard-index]');
    if (!tile) return;

    const index = Number(tile.dataset.discardIndex);
    if (!Number.isInteger(index) || index < 0) return;
    const canDiscard = tile.dataset.canDiscard === '1';
    const gameState = getGameState();
    if (gameState?.goldRevealed === false) {
        setStatus('等待庄家开金后再操作', true);
        return;
    }
    const selfSeat = session?.seatId === null || session?.seatId === undefined ? null : Number(session.seatId);
    const selfSeatKey = selfSeat === null ? null : String(selfSeat);
    const hand = selfSeatKey ? (Array.isArray(gameState?.hands?.[selfSeatKey]) ? gameState.hands[selfSeatKey] : []) : [];
    const tileCode = hand[index];
    const goldTile = gameState?.goldTile || '';
    const isGoldTile = !!tileCode && !!goldTile && tileCode === goldTile;

    if (selectedDiscardIndex !== index) {
        selectedDiscardIndex = index;
        renderBoard();
        if (isGoldTile) {
            setStatus(`已提起金牌 ${toTileEmoji(tileCode)}，再次点击会放下`);
        } else if (canDiscard) {
            if (tileCode) {
                setStatus(`已提牌 ${toTileEmoji(tileCode)}，再次点击同一张牌打出`);
            } else {
                setStatus('已提牌，再次点击同一张牌打出');
            }
        } else {
            if (tileCode) {
                setStatus(`已提牌 ${toTileEmoji(tileCode)}，当前不可打出`);
            } else {
                setStatus('已提牌，当前不可打出');
            }
        }
        return;
    }

    if (isGoldTile) {
        selectedDiscardIndex = null;
        renderBoard();
        const warning = '笨比金牌你都要打';
        setStatus(warning, true);
        showActionToast(warning, { isError: true });
        return;
    }

    if (!canDiscard) {
        setStatus(turnStatusEl?.textContent || '当前不可出牌');
        return;
    }

    selectedDiscardIndex = null;

    await submitIntent('DISCARD', { index }, {
        pendingText: `提交出牌（索引 ${index}）...`,
        successText: '已提交出牌'
    });
}

function handleHandContextMenu(event) {
    const tile = event.target.closest('[data-discard-index]');
    if (!tile) return;
    event.preventDefault();
    if (selectedDiscardIndex === null) return;
    selectedDiscardIndex = null;
    renderBoard();
    setStatus('已取消提牌');
}

async function handleActionBarClick(event) {
    if (event?.isTrusted) {
        primeActionVoiceEngine(true);
    }
    const gameState = getGameState();
    if (gameState?.goldRevealed === false) {
        setStatus('等待庄家开金后再操作', true);
        return;
    }

    const pending = gameState?.pendingClaim || null;
    const selfSeatId = session?.seatId === null || session?.seatId === undefined ? '' : String(session.seatId);
    if (pending && selfSeatId && shouldLockReactionBar(roomState?.actions || {}, pending, selfSeatId)) {
        chiSubMenuOpen = false;
        renderActionBar();
        return;
    }
    if (pending && selfSeatId) {
        const stableKey = buildReactionBarStableKey(pending, selfSeatId);
        if (!stableKey) {
            resetReactionBarStableGate();
        } else if (shouldHoldReactionBarUntilStable(stableKey)) {
            chiSubMenuOpen = false;
            renderActionBar();
            return;
        }
    }

    const openChiBtn = event.target.closest('[data-open-chi]');
    if (openChiBtn) {
        chiSubMenuOpen = true;
        renderActionBar();
        return;
    }

    const cancelChiBtn = event.target.closest('[data-cancel-chi]');
    if (cancelChiBtn) {
        chiSubMenuOpen = false;
        renderActionBar();
        return;
    }

    const reactionBtn = event.target.closest('[data-reaction-type]');
    if (reactionBtn) {
        if (pending && selfSeatId && !isSeatActivePendingDecision(pending, selfSeatId)) return;

        const type = reactionBtn.dataset.reactionType;
        if (!type) return;

        let payload = {};
        if (type === 'CHI' && reactionBtn.dataset.reactionChoice) {
            try {
                payload = { choice: JSON.parse(reactionBtn.dataset.reactionChoice) };
            } catch {
                payload = {};
            }
        }

        await submitIntent(type, payload, {
            pendingText: `响应 ${type}...`,
            successText: `已提交 ${type}`
        });
        chiSubMenuOpen = false;
        return;
    }

    const turnPassHuBtn = event.target.closest('[data-turn-pass-hu]');
    if (turnPassHuBtn) {
        const seatNo = getSelfSeatNo();
        const key = seatNo === null ? '' : selfHuPromptKey(getGameState(), seatNo);
        if (!key) return;
        skippedSelfHuPromptKey = key;
        chiSubMenuOpen = false;
        renderActionBar();
        setStatus('已选择过胡，请出牌');
        return;
    }

    const turnBtn = event.target.closest('[data-turn-type]');
    if (!turnBtn) return;
    const type = turnBtn.dataset.turnType;
    if (!type) return;

    const payload = {};
    if (turnBtn.dataset.turnChar) payload.char = turnBtn.dataset.turnChar;
    await submitIntent(type, payload, {
        pendingText: `执行 ${type}...`,
        successText: `已提交 ${type}`
    });
    chiSubMenuOpen = false;
}

function handleBoardOutsideClick(event) {
    if (selectedDiscardIndex === null) return;
    if (event.target?.closest?.('[data-discard-index]')) return;
    if (event.target?.closest?.('#action-bar')) return;
    if (event.target?.closest?.('.rule-modal')) return;
    if (event.target?.closest?.('.btn-ui, .ui-box, [data-open-modal], [data-close-modal]')) return;
    selectedDiscardIndex = null;
    renderBoard();
}

async function handleNextRound() {
    const gameState = getGameState();
    if (!gameState || getSelfSeatNo() === null) return;
    if (!canOperateDealerAction(gameState)) {
        const message = isDealerBotControlled(gameState)
            ? '请由房主操作下一局'
            : '请由庄家开启下一局';
        setStatus(message, true);
        showActionToast(message, { isError: true });
        return;
    }

    await submitIntent('ROUND_START', {}, {
        pendingText: '提交下一局请求...',
        successText: '已提交下一局请求。'
    });
}

async function handleOpenGold() {
    const gameState = getGameState();
    if (!gameState || getSelfSeatNo() === null) return;
    if (gameState.phase !== 'playing' || gameState.goldRevealed !== false) return;
    if (!canOperateDealerAction(gameState)) {
        const message = isDealerBotControlled(gameState)
            ? '请由房主操作开金'
            : '请由庄家开金';
        setStatus(message, true);
        showActionToast(message, { isError: true });
        return;
    }

    await submitIntent('OPEN_GOLD', {}, {
        pendingText: '提交开金请求...',
        successText: '已提交开金请求。'
    });
}

async function handleToggleTrustee() {
    const selfSeat = getSelfSeatNo();
    const selfSeatKey = selfSeat === null ? null : String(selfSeat);
    if (!roomState || !session || selfSeatKey === null) {
        setStatus('当前身份不可托管', true);
        return;
    }

    const seat = roomState?.seats?.[selfSeatKey];
    if (!seat || seat.isBot) {
        setStatus('当前座位不可托管', true);
        return;
    }

    const gameState = getGameState();
    const currentControl = gameState?.seatControls?.[selfSeatKey] || seat.control || 'human';
    const targetControl = currentControl === 'bot' ? 'human' : 'bot';
    const buttons = [trusteeBtn, mobileTrusteeBtn].filter((el) => !!el);
    buttons.forEach((btn) => {
        btn.disabled = true;
    });

    try {
        await setSeatControlMode(roomCode, session.uid, selfSeatKey, targetControl);
        selectedDiscardIndex = null;
        kickHostLoopSoon();
        const msg = targetControl === 'bot' ? '已开启托管（弱AI）' : '已取消托管';
        setStatus(msg);
        showActionToast(msg);
    } catch (error) {
        const msg = error?.message || '切换托管失败';
        setStatus(msg, true);
        showActionToast(msg, { isError: true });
    } finally {
        buttons.forEach((btn) => {
            btn.disabled = false;
        });
        renderTrusteeButtons();
    }
}

async function handleToggleAiSpeed(event) {
    if (event?.isTrusted) {
        primeActionVoiceEngine(true);
    }
    if (!aiSpeedToggleBtn && !mobileAiSpeedToggleBtn) return;
    if (!roomState || !session || !isHost()) {
        const message = '仅房主可切换AI速度';
        setStatus(message, true);
        showActionToast(message, { isError: true });
        return;
    }

    const gameState = getGameState();
    if (!gameState) {
        const message = '牌局尚未初始化，暂不能切换AI速度';
        setStatus(message, true);
        showActionToast(message, { isError: true });
        return;
    }

    const currentMode = normalizeAiSpeedMode(gameState.aiSpeedMode);
    const targetMode = currentMode === AI_SPEED_MODE.FAST ? AI_SPEED_MODE.NORMAL : AI_SPEED_MODE.FAST;
    if (aiSpeedToggleBtn) aiSpeedToggleBtn.disabled = true;
    if (mobileAiSpeedToggleBtn) mobileAiSpeedToggleBtn.disabled = true;
    try {
        const success = await submitIntent('SET_AI_SPEED', { mode: targetMode }, {
            pendingText: targetMode === AI_SPEED_MODE.FAST ? '提交AI加速...' : '提交AI常速...',
            successText: targetMode === AI_SPEED_MODE.FAST ? 'AI已切换为加速' : 'AI已切换为常速'
        });
        const msg = targetMode === AI_SPEED_MODE.FAST ? 'AI已加速' : 'AI已恢复常速';
        if (success) {
            setStatus(msg);
            showActionToast(msg);
        } else {
            showActionToast('切换AI速度失败', { isError: true });
        }
    } finally {
        if (aiSpeedToggleBtn) aiSpeedToggleBtn.disabled = false;
        if (mobileAiSpeedToggleBtn) mobileAiSpeedToggleBtn.disabled = false;
        renderAiSpeedToggleButton();
    }
}

async function handleLeaveRoom() {
    leaveRoomBtn.disabled = true;
    if (mobileLeaveRoomBtn) mobileLeaveRoomBtn.disabled = true;
    if (trusteeBtn) trusteeBtn.disabled = true;
    if (mobileTrusteeBtn) mobileTrusteeBtn.disabled = true;
    if (aiSpeedToggleBtn) aiSpeedToggleBtn.disabled = true;
    if (mobileAiSpeedToggleBtn) mobileAiSpeedToggleBtn.disabled = true;
    if (centerLeaveRoomBtn) centerLeaveRoomBtn.disabled = true;
    try {
        await leaveRoom(roomCode, session.uid, session.seatId);
    } catch {
        // 离开失败时忽略，仍继续清理本地会话并返回大厅
    }
    clearSession();
    redirectToLobby();
}

async function runHostLoop() {
    if (!roomState || !session || !isHost()) {
        return {
            changed: false,
            reason: 'not-host',
            nextTickDelayMs: HOST_LOOP_IDLE_INTERVAL_MS
        };
    }
    if (hostLoopBusy) {
        return {
            changed: false,
            reason: 'busy',
            nextTickDelayMs: HOST_LOOP_ACTIVE_INTERVAL_MS
        };
    }
    hostLoopBusy = true;
    try {
        const tickResult = await runHostTick(roomCode, session.uid);
        if (tickResult?.changed || tickResult?.hadPendingActions) {
            hostLoopBurstUntil = Math.max(hostLoopBurstUntil, Date.now() + HOST_LOOP_BURST_WINDOW_MS);
        }
        return tickResult || {
            changed: false,
            reason: 'empty',
            nextTickDelayMs: HOST_LOOP_IDLE_INTERVAL_MS
        };
    } catch (error) {
        setStatus(`房主循环异常：${error.message || error}`, true);
        return {
            changed: false,
            reason: 'error',
            nextTickDelayMs: HOST_LOOP_IDLE_INTERVAL_MS
        };
    } finally {
        hostLoopBusy = false;
    }
}

function chooseHostLoopDelay(preferredDelay = null) {
    if (Number.isFinite(preferredDelay) && preferredDelay > 0) {
        return Math.max(40, Number(preferredDelay));
    }
    if (Date.now() < hostLoopBurstUntil) {
        return HOST_LOOP_ACTIVE_INTERVAL_MS;
    }
    return HOST_LOOP_IDLE_INTERVAL_MS;
}

function scheduleHostLoop(preferredDelay = null, force = false) {
    if (force && hostLoopTimer) {
        clearTimeout(hostLoopTimer);
        hostLoopTimer = null;
    }
    if (hostLoopTimer) return;
    if (!roomState || !session || !isHost()) return;
    const delay = chooseHostLoopDelay(preferredDelay);
    hostLoopTimer = setTimeout(async () => {
        hostLoopTimer = null;
        const tickResult = await runHostLoop();
        if (!roomState || !session || !isHost()) return;
        const nextDelay = chooseHostLoopDelay(tickResult?.nextTickDelayMs || null);
        scheduleHostLoop(nextDelay, true);
    }, delay);
}

function ensureHostLoop() {
    if (!isHost()) return;
    scheduleHostLoop(0);
}

function stopHostLoop() {
    if (!hostLoopTimer) return;
    clearTimeout(hostLoopTimer);
    hostLoopTimer = null;
}

function cleanupBattleRuntime(options = {}) {
    const disposeGuard = options.disposeGuard === true;

    if (unsubscribeRoom) {
        try {
            unsubscribeRoom();
        } catch {
            // 忽略清理阶段异常，避免影响后续退出链路
        }
        unsubscribeRoom = null;
    }

    if (detachPresence) {
        const detach = detachPresence;
        detachPresence = null;
        try {
            const maybePromise = detach();
            if (maybePromise && typeof maybePromise.catch === 'function') {
                maybePromise.catch(() => {});
            }
        } catch {
            // 忽略清理阶段异常，避免影响后续退出链路
        }
    }

    stopHostLoop();

    if (replacementDrawRevealTimer) {
        clearTimeout(replacementDrawRevealTimer);
        replacementDrawRevealTimer = null;
    }
    if (flowerCueTimer) {
        clearTimeout(flowerCueTimer);
        flowerCueTimer = null;
    }
    if (goldRevealFxTimer) {
        clearTimeout(goldRevealFxTimer);
        goldRevealFxTimer = null;
    }
    resetReactionBarStableGate();

    if (disposeGuard && typeof disposeScreenGuard === 'function') {
        try {
            disposeScreenGuard();
        } catch {
            // 忽略清理阶段异常，避免影响后续退出链路
        }
    }
}

async function bootstrap() {
    if (!hasFirebaseConfig()) {
        const { missingKeys } = getFirebaseConfigStatus();
        setStatus(`请先填写 src/firebase-config.js，当前缺少：${missingKeys.join(', ')}`, true);
        leaveRoomBtn.disabled = true;
        if (mobileLeaveRoomBtn) mobileLeaveRoomBtn.disabled = true;
        if (centerLeaveRoomBtn) centerLeaveRoomBtn.disabled = true;
        return;
    }

    const cached = loadSession();
    if (!cached) {
        setStatus('会话已失效，正在返回大厅', true);
        setTimeout(redirectToLobby, 1200);
        return;
    }

    let authUser = null;
    try {
        authUser = await ensureAnonymousAuth();
    } catch (error) {
        setStatus(error.message || '登录失败，正在返回大厅', true);
        return;
    }

    if (cached.uid && cached.uid !== authUser.uid) {
        clearSession();
        setStatus('检测到登录身份变化，请重新加入房间。', true);
        setTimeout(redirectToLobby, 1200);
        return;
    }

    roomCode = readRoomCodeFromUrl() || String(cached.roomCode || '').toUpperCase();
    if (!roomCode) {
        setStatus('缺少房间码，正在返回大厅', true);
        setTimeout(redirectToLobby, 1200);
        return;
    }

    session = {
        ...cached,
        uid: authUser.uid,
        roomCode,
        entryMode: 'battle'
    };
    saveSession(session);

    try {
        unsubscribeRoom = subscribeRoom(roomCode, async (room) => {
            const firstSnapshot = roomState === null;
            roomState = room;
            if (!roomState) {
                setStatus('房间不存在或已关闭', true);
                return;
            }

            if ((roomState?.meta?.status || 'waiting') === 'waiting') {
                setStatus('对局尚未开始，正在等待房主开局...', true);
            }

            render();
            syncActionAudio(roomState?.game?.state || null, firstSnapshot);
            syncGoldRevealEffect(roomState?.game?.state || null, firstSnapshot);
            syncFlowerCue(roomState?.game?.state || null, firstSnapshot);
            syncChuiFengCue(roomState?.game?.state || null, firstSnapshot);

            try {
                await tryElectHost(roomCode, session.uid, roomState);
            } catch {
                // 竞选异常时仅记录，不打断渲染
            }

            if (isHost()) {
                const hasPendingActions = Object.values(roomState?.actions || {})
                    .some((entry) => entry && entry.status === 'pending');
                if (hasPendingActions) {
                    hostLoopBurstUntil = Math.max(hostLoopBurstUntil, Date.now() + HOST_LOOP_BURST_WINDOW_MS);
                }
                ensureHostLoop();
            } else {
                stopHostLoop();
            }
        });

        detachPresence = await attachPresence(roomCode, session.uid, session.seatId, session.nickname);
        setupActionAudioUnlock();
        registerVoiceModeConsoleCommands();
        renderAudioDiagnostic('bootstrap');

        document.getElementById('hand-bottom')?.addEventListener('click', handleHandClick);
        document.getElementById('hand-bottom')?.addEventListener('contextmenu', handleHandContextMenu);
        actionBarEl?.addEventListener('click', handleActionBarClick);
        document.addEventListener('click', handleBoardOutsideClick);
        leaveRoomBtn?.addEventListener('click', handleLeaveRoom);
        mobileLeaveRoomBtn?.addEventListener('click', handleLeaveRoom);
        trusteeBtn?.addEventListener('click', handleToggleTrustee);
        mobileTrusteeBtn?.addEventListener('click', handleToggleTrustee);
        aiSpeedToggleBtn?.addEventListener('click', handleToggleAiSpeed);
        mobileAiSpeedToggleBtn?.addEventListener('click', handleToggleAiSpeed);
        centerLeaveRoomBtn?.addEventListener('click', handleLeaveRoom);
        nextRoundBtn?.addEventListener('click', handleNextRound);
        mobileNextRoundBtn?.addEventListener('click', handleNextRound);
        centerNextRoundBtn?.addEventListener('click', handleNextRound);
        centerOpenGoldBtn?.addEventListener('click', handleOpenGold);
        document.addEventListener('click', handleRuleModalClick);
        window.addEventListener('resize', renderAiSpeedToggleButton);
        huOverlayEl?.addEventListener('click', () => {
            const key = outcomeKey(getGameState()?.outcome || null);
            dismissedOutcomeKey = key;
            if (huOverlayEl) huOverlayEl.style.display = 'none';
        });

        ensureHostLoop();
        setStatus('已进入实战房间，等待对局开始。');
    } catch (error) {
        cleanupBattleRuntime();
        throw error;
    }

    window.addEventListener('beforeunload', () => {
        if (detachPresence) {
            const detach = detachPresence;
            detachPresence = null;
            try {
                const maybePromise = detach();
                if (maybePromise && typeof maybePromise.catch === 'function') {
                    maybePromise.catch(() => {});
                }
            } catch {
                // beforeunload 中不抛出清理异常
            }
        }
    });
}

window.addEventListener('unload', () => {
    cleanupBattleRuntime({ disposeGuard: true });
});

bootstrap().catch((error) => {
    cleanupBattleRuntime();
    setStatus(error.message || '实战页面初始化失败', true);
});


