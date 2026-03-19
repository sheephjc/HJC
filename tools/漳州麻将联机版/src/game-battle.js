import { createAction } from './shared/action-schema.js';
import { getSelfDrawHuInfo, hasMandatorySanJinHu } from './online-game-engine.js';
import { ensureAnonymousAuth, getFirebaseConfigStatus, hasFirebaseConfig } from './firebase-client.js';
import { toTileEmoji } from './tile-display.js';
import { initMobileScreenGuard } from './mobile-screen-guard.js';
import {
    attachPresence,
    leaveRoom,
    runHostTick,
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

const BUILD_TAG = '20260318r34';
const HOST_LOOP_IDLE_INTERVAL_MS = 650;
const HOST_LOOP_ACTIVE_INTERVAL_MS = 100;
const HOST_LOOP_BURST_WINDOW_MS = 2800;
const GOLD_REVEAL_FX_DURATION_MS = 1880;
const REPLACEMENT_DRAW_DELAY_MS = 100;
const REPLACEMENT_DRAW_REASONS = new Set(['GANG', 'GANG_FLOWER', 'FLOWER']);
const FLOWER_DRAW_REASONS = new Set(['FLOWER', 'GANG_FLOWER']);
const CLAIM_PRIORITY = Object.freeze({
    HU: 0,
    PENG: 1,
    GANG: 1,
    CHI: 2
});
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
    FLOWER_REPLENISH: { minnan: '補花', mandarin: '补花' }
});
const AUDIO_UNLOCK_EVENTS = ['click', 'touchend', 'keydown'];

const roomMetaEl = document.getElementById('room-meta');
const turnStatusEl = document.getElementById('turn-status');
const mobileTurnStatusEl = document.getElementById('mobile-turn-status');
const leaveRoomBtn = document.getElementById('leave-room-btn');
const mobileLeaveRoomBtn = document.getElementById('mobile-leave-room-btn');
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
let lastActionAudioKey = '';
let lastFlowerCueKey = '';
let lastChuiFengCueKey = '';
let lastTableOutcomeEffectKey = '';
let lastGoldRevealEffectKey = '';
let replacementDrawRevealTimer = null;
let flowerCueTimer = null;
let goldRevealFxTimer = null;

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
    if (options.HU) return CLAIM_PRIORITY.HU;
    if (options.PENG || options.GANG) return CLAIM_PRIORITY.PENG;
    if (Array.isArray(options.CHI) && options.CHI.length) return CLAIM_PRIORITY.CHI;
    return 9;
}

function getActivePendingPriority(pending = null) {
    if (!pending?.optionsBySeat || typeof pending.optionsBySeat !== 'object') return null;
    let active = null;
    for (const [seatId, options] of Object.entries(pending.optionsBySeat)) {
        if (pending?.decisions?.[seatId]) continue;
        const priority = pendingOptionPriority(options);
        if (priority >= 9) continue;
        if (active === null || priority < active) {
            active = priority;
        }
    }
    return active;
}

function isSeatActivePendingDecision(pending = null, seatId = '') {
    const seatKey = String(seatId || '');
    if (!seatKey || !pending?.optionsBySeat?.[seatKey]) return false;
    const activePriority = getActivePendingPriority(pending);
    if (activePriority === null) return true;
    return pendingOptionPriority(pending.optionsBySeat[seatKey]) === activePriority;
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

function getSelfSeatNo() {
    if (session?.seatId === null || session?.seatId === undefined) return null;
    return normalizeSeatNo(session.seatId, 0);
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
    return headline || (outcome?.isSelfDraw ? '自摸' : '点炮');
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
        text.style.setProperty('--seat-rotate', `${getSeatTextRotationDegByPos(winnerPos)}deg`);
        text.textContent = outcomeWinnerTableText(outcome);
        applyOutcomeTextEffectClasses(text, outcome);
        if (!placeEffectAtSeat(text, outcome.winner, { verticalRatio: 0.5 })) {
            winnerArea.appendChild(text);
        }
        fitTextToSingleLine(text, { minPx: 12, widthRatio: 0.9, container: winnerArea });
    }

    if (!outcome.isSelfDraw && Number.isInteger(Number(outcome.loser))) {
        const loserPos = getPosBySeat(baseSeat, Number(outcome.loser));
        const loserArea = document.getElementById(`p-${loserPos}`);
        if (loserArea) {
            loserArea.classList.add('lose-mark');
            const text = document.createElement('div');
            text.className = 'result-text lose-text';
            text.style.setProperty('--seat-rotate', `${getSeatTextRotationDegByPos(loserPos)}deg`);
            text.textContent = '点炮 👎🏻';
            if (!placeEffectAtSeat(text, outcome.loser, { verticalRatio: 0.5 })) {
                loserArea.appendChild(text);
            }
        }
    }
}

function renderRoomMeta() {
    if (!roomMetaEl || !session || !roomState) return;
    const role = isHost() ? '房主' : '成员';
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

function setBoardScore(pos, label, score, isDealer) {
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
            badge.textContent = '庄';
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
    const revealHand = pos === 'bottom' || gameState?.phase === 'ended';
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
        setStatus('等待牌局初始化...');
        renderGoldDisplay('');
        PLAYER_POS.forEach((pos) => {
            document.getElementById(`hand-${pos}`)?.replaceChildren();
            document.getElementById(`river-${pos}`)?.replaceChildren();
            document.getElementById(`show-${pos}`)?.replaceChildren();
        });
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
        setBoardScore(pos, label, scores[seatId], Number(gameState.dealerSeat) === Number(seatId));
    });

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
    if (!ctx) return false;

    if (ctx.state === 'running' || ctx.state === 'interrupted') {
        actionAudioUnlocked = true;
        return true;
    }

    if (fromGesture && ctx.state === 'suspended') {
        ctx.resume().then(() => {
            if (ctx.state === 'running' || ctx.state === 'interrupted') {
                actionAudioUnlocked = true;
            }
        }).catch(() => {});
    }

    return actionAudioUnlocked;
}

function getActionVoiceProfile() {
    if (!('speechSynthesis' in window)) return { voice: null, isMinnan: false };
    if (actionVoiceProfile) return actionVoiceProfile;

    const voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
    const preferred = voices.slice().sort((a, b) => Number(!!b.localService) - Number(!!a.localService));
    const minnanReg = /nan|hokkien|hok-lo|taiwanese|tai-yu|tai yu|台语|闽南/i;
    const twReg = /zh[-_]?tw|zh[-_]?hk|zh[-_]?hant|taiwan|台湾|hong kong|繁中|繁體/i;

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

    const utter = new SpeechSynthesisUtterance(text);
    if (options.voice) utter.voice = options.voice;
    utter.lang = options.lang || options.voice?.lang || 'zh-CN';
    utter.rate = options.rate ?? 1;
    utter.pitch = options.pitch ?? 1;
    utter.volume = options.volume ?? 1;
    if (options.cancel !== false) window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
}

function playActionSfx(type = '') {
    const conf = ACTION_SFX_MAP[type];
    if (!conf) return;

    if (hasUserActivationGesture()) tryUnlockActionAudio(true);
    if (!actionAudioUnlocked) return;

    const ctx = getActionAudioContext(false);
    if (!ctx) return;
    if (ctx.state !== 'running' && ctx.state !== 'interrupted') return;

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
    const text = profile.isMinnan ? voiceItem.minnan : voiceItem.mandarin;
    const lang = profile.isMinnan ? (profile.voice?.lang || 'nan-TW') : (profile.voice?.lang || 'zh-CN');
    speakActionText(text, { voice: profile.voice, lang, cancel: false, rate: 1.08 });
}

function actionAudioKey(action = null) {
    if (!action || typeof action !== 'object') return '';
    if (!action.type) return '';
    const seatId = Number.isInteger(action.seatId) ? action.seatId : 'x';
    const ts = Number.isFinite(action.ts) ? action.ts : 'x';
    return `${action.type}|${seatId}|${ts}`;
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
    if (actionType === 'FLOWER_REPLENISH') {
        effect.classList.add('flower');
    }
    effect.textContent = text;
    if (!placeEffectAtSeat(effect, seatId, { verticalRatio: 0.46 })) {
        const pos = getPosBySeat(getViewerBaseSeat(), Number(seatId));
        const area = document.getElementById(`p-${pos}`);
        if (!area) return;
        area.appendChild(effect);
    }
    setTimeout(() => effect.remove(), 850);
}

function syncActionAudio(gameState = null, primeOnly = false) {
    const action = gameState?.lastAction || null;
    const key = actionAudioKey(action);
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
    playActionSfx('CHUI_FENG');
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
        const chips = orderedTiles.map((tileCode) => `
            <span class="chi-option-tile${tileCode === goldTile ? ' is-gold' : ''}">${escapeHtml(toTileEmoji(tileCode))}</span>
        `).join('');
        return `<button class="btn-act chi-option-btn" data-reaction-type="CHI" data-reaction-choice="${choicePayload}"><span class="chi-option-tiles">${chips}</span></button>`;
    }
    return `<button class="btn-act chi-option-btn" data-reaction-type="CHI" data-reaction-choice="${choicePayload}">吃</button>`;
}

function renderActionBar() {
    if (!actionBarEl) return;
    actionBarEl.classList.remove('chi-three-mobile');
    const gameState = getGameState();
    if (!gameState || !session || session.seatId === null || session.seatId === undefined) {
        chiSubMenuOpen = false;
        actionBarEl.innerHTML = '';
        actionBarEl.classList.add('hidden');
        return;
    }

    const seatId = String(session.seatId);
    if (!isGoldRevealed(gameState)) {
        chiSubMenuOpen = false;
        actionBarEl.innerHTML = '';
        actionBarEl.classList.add('hidden');
        return;
    }

    const pending = gameState.pendingClaim || null;
    const controls = [];

    if (pending) {
        const options = pending.optionsBySeat?.[seatId];
        if (!options) {
            chiSubMenuOpen = false;
            actionBarEl.innerHTML = '';
            actionBarEl.classList.add('hidden');
            return;
        }
        if (!isSeatActivePendingDecision(pending, seatId)) {
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
        chiSubMenuOpen = false;
        const hand = gameState.hands?.[seatId] || [];
        const goldTile = gameState.goldTile;
        const isSelfDrawState = Number(gameState?.currentDraw?.seatId) === Number(seatId) && !!gameState?.currentDraw?.tile;
        const selfHuInfo = isSelfDrawState ? getSelfDrawHuInfo(gameState, Number(seatId)) : { canHu: false, types: [] };
        const canHu = !!selfHuInfo?.canHu;
        const mustHu = canHu && Array.isArray(selfHuInfo.types) && selfHuInfo.types.includes('三金倒');

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

        if (canHu) {
            controls.push(buildActionButton('胡', { 'data-turn-type': 'HU' }));
        }
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
        const headline = buildOutcomeHeadline({
            isSelfDraw: !!entry.isSelfDraw,
            specialTypes: Array.isArray(entry.specialTypes) ? entry.specialTypes : [],
            flowerCount: Number(entry.flowerCount || 0),
            waterMul: Number(entry.waterMul || 1)
        });
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

    const rows = logs.slice().reverse().map((entry) => `
        <div class="instant-row">
            <div class="instant-type">${escapeHtml(formatInstantRound(entry))} · ${escapeHtml(formatInstantType(entry))} · ${escapeHtml(formatInstantTs(entry.ts))}</div>
            <div class="instant-delta">${escapeHtml(formatInstantDeltaLine(entry.delta || []))}</div>
        </div>
    `);
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
        let basePay = 1;
        if (winnerIsDealer) {
            const dealerMul = streak >= 1 ? Math.pow(2, streak) : 1;
            basePay = 2 * dealerMul;
        } else {
            basePay = loser === dealer ? 2 : 1;
        }
        return `${basePay}底×1点炮家${multiplierSuffix} = ${total}`;
    }

    if (winnerIsDealer) {
        const dealerMul = streak >= 1 ? Math.pow(2, streak) : 1;
        const baseMul = dealerMul * 2;
        const basePart = scoreAsSelfDraw
            ? `(1底×${baseMul}庄家+1自摸)×3闲家`
            : `(1底×${baseMul}庄家)×3闲家`;
        return `${basePart}${multiplierSuffix} = ${total}`;
    }

    const baseStr = scoreAsSelfDraw ? '1底+1自摸' : '1底';
    const basePart = `(${baseStr})×2闲家 + (${baseStr}+1庄)×1庄家`;
    return `${basePart}${multiplierSuffix} = ${total}`;
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
        const lines = [0, 1, 2, 3].map((seatId) => {
            const value = Number(payout[seatId] || 0);
            const totalScore = Math.floor(Number(totalScores[seatId] || 0));
            const className = value >= 0 ? 'settle-plus' : 'settle-minus';
            const sign = value >= 0 ? '+' : '';
            const totalSign = totalScore >= 0 ? '+' : '';
            const seatLabel = escapeHtml(getSettlementSeatLabel(seatId));
            return `<div class="settle-row"><span class="settle-name">${seatLabel}</span><span class="settle-score ${className}">${sign}${value}</span><span class="settle-total">${totalSign}${totalScore}</span></div>`;
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
    renderTableOutcomeEffects();
    renderActionBar();
    renderInstantScoreLog();
    renderOutcome();
}

function kickHostLoopSoon() {
    if (!isHost()) return;
    hostLoopBurstUntil = Math.max(hostLoopBurstUntil, Date.now() + HOST_LOOP_BURST_WINDOW_MS);
    scheduleHostLoop(0, true);
}

async function submitIntent(type, payload = {}, options = {}) {
    if (!roomState || !session) return false;
    const seatId = session.seatId === null || session.seatId === undefined ? 0 : Number(session.seatId);
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
        setStatus('已放下金牌');
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
    if (getGameState()?.goldRevealed === false) {
        setStatus('等待庄家开金后再操作', true);
        return;
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
        const gameState = getGameState();
        const pending = gameState?.pendingClaim || null;
        const selfSeatId = session?.seatId === null || session?.seatId === undefined ? '' : String(session.seatId);
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

async function handleLeaveRoom() {
    leaveRoomBtn.disabled = true;
    if (mobileLeaveRoomBtn) mobileLeaveRoomBtn.disabled = true;
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

        document.getElementById('hand-bottom')?.addEventListener('click', handleHandClick);
        document.getElementById('hand-bottom')?.addEventListener('contextmenu', handleHandContextMenu);
        actionBarEl?.addEventListener('click', handleActionBarClick);
        document.addEventListener('click', handleBoardOutsideClick);
        leaveRoomBtn?.addEventListener('click', handleLeaveRoom);
        mobileLeaveRoomBtn?.addEventListener('click', handleLeaveRoom);
        centerLeaveRoomBtn?.addEventListener('click', handleLeaveRoom);
        nextRoundBtn?.addEventListener('click', handleNextRound);
        mobileNextRoundBtn?.addEventListener('click', handleNextRound);
        centerNextRoundBtn?.addEventListener('click', handleNextRound);
        centerOpenGoldBtn?.addEventListener('click', handleOpenGold);
        document.addEventListener('click', handleRuleModalClick);
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

