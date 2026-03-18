import { createAction, ACTION_TYPES } from './shared/action-schema.js';
import { getSelfDrawHuInfo, hasMandatorySanJinHu } from './online-game-engine.js';
import { ensureAnonymousAuth, getFirebaseConfigStatus, hasFirebaseConfig } from './firebase-client.js';
import { createPresentationEffects } from './presentation-effects.js';
import { toTileEmoji } from './tile-display.js';
import {
    attachPresence,
    leaveRoom,
    processPendingActions,
    startRoomGame,
    submitActionIntent,
    subscribeRoom,
    syncSeatControls,
    tryElectHost
} from './room-service.js';
import { clearSession, loadSession } from './session.js';
import { debugActionLabel, debugPresetLabel, roomStatusLabel } from './ui-labels.js';

const roomMetaEl = document.getElementById('room-meta');
const startGameBtn = document.getElementById('start-game-btn');
const startSingleGoldBtn = document.getElementById('start-single-gold-btn');
const startDoubleGoldBtn = document.getElementById('start-double-gold-btn');
const startTripleGoldBtn = document.getElementById('start-triple-gold-btn');
const copyRoomCodeBtn = document.getElementById('copy-room-code-btn');
const startGameHintEl = document.getElementById('start-game-hint');
const leaveRoomBtn = document.getElementById('leave-room-btn');
const seatGridEl = document.getElementById('seat-grid');
const tableBoardEl = document.getElementById('table-board');
const turnHintEl = document.getElementById('turn-hint');
const selfHandEl = document.getElementById('self-hand');
const reactionBarEl = document.getElementById('reaction-bar');
const statePreviewEl = document.getElementById('state-preview');
const outcomeCardEl = document.getElementById('outcome-card');
const outcomeSummaryEl = document.getElementById('outcome-summary');
const outcomePayoutEl = document.getElementById('outcome-payout');
const actionToastEl = document.getElementById('action-toast');
const huCanvasEl = document.getElementById('hu-canvas');
const instantScoreLogEl = document.getElementById('instant-score-log');
const nextRoundBtn = document.getElementById('next-round-btn');
const debugModeToggleEl = document.getElementById('debug-mode-toggle');
const debugModeHintEl = document.getElementById('debug-mode-hint');
const debugPanelEl = document.getElementById('debug-panel');
const debugPresetSelect = document.getElementById('debug-preset-select');
const applyDebugPresetBtn = document.getElementById('apply-debug-preset-btn');
const actionSeatSelect = document.getElementById('action-seat-select');
const actionTypeSelect = document.getElementById('action-type-select');
const actionPayloadInput = document.getElementById('action-payload-input');
const sendActionBtn = document.getElementById('send-action-btn');
const actionStatusEl = document.getElementById('action-status');
const actionStatusFallbackEl = turnHintEl || roomMetaEl;
const syncDiagnosticsEl = document.getElementById('sync-diagnostics');
const copyDiagnosticsBtn = document.getElementById('copy-diagnostics-btn');
const BUILD_TAG = '20260318r34';
const HOST_LOOP_INTERVAL_MS = 220;
const CLAIM_PRIORITY = Object.freeze({
    HU: 0,
    PENG: 1,
    GANG: 1,
    CHI: 2
});

const DEBUG_MODE_STORAGE_KEY = 'zzm_online_debug_mode';
const DEBUG_PRESETS = Object.freeze({
    DISCARD_0: { type: 'DISCARD', payload: { index: 0 } },
    PASS: { type: 'PASS', payload: {} },
    HU: { type: 'HU', payload: {} },
    FLOWER_REPLENISH: { type: 'FLOWER_REPLENISH', payload: {} },
    AN_GANG_W1: { type: 'AN_GANG', payload: { char: 'W1' } },
    BU_GANG_W1: { type: 'BU_GANG', payload: { char: 'W1' } },
    ROUND_START: { type: 'ROUND_START', payload: {} }
});

function formatDebugActionTypeText(type) {
    const key = String(type || '').toUpperCase();
    if (!key) return '';
    return `${key}${debugActionLabel(key)}`;
}

function formatDebugPresetText(presetKey) {
    const key = String(presetKey || '').toUpperCase();
    if (!key) return '';
    return `${key}${debugPresetLabel(key)}`;
}

let session = null;
let roomCode = '';
let roomState = null;
let unsubscribeRoom = null;
let detachPresence = null;
let hostLoopTimer = null;
let hostLoopBusy = false;
let presentationEffects = null;
let debugModeEnabled = false;
let selectedDiscardIndex = null;
const syncDiagnostics = {
    lastMetaVersion: null,
    lastGameVersion: null,
    lastHostUid: null,
    lastSeatControlMap: '',
    latestLagMs: null,
    latestUpdatedAt: null,
    latestLastAction: null,
    events: []
};

function setActionStatus(text, isError = false) {
    const targetEl = actionStatusEl || actionStatusFallbackEl;
    if (!targetEl) return;
    targetEl.textContent = text;
    targetEl.style.color = isError ? '#b91c1c' : '#1f2937';
}

function diagNowText() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function pushDiagEvent(text, isWarn = false) {
    syncDiagnostics.events.push({
        text,
        ts: Date.now(),
        warn: !!isWarn
    });
    if (syncDiagnostics.events.length > 16) {
        syncDiagnostics.events = syncDiagnostics.events.slice(-16);
    }
}

function diffSeatControls(prevMap = {}, nextMap = {}) {
    const changes = [];
    ['0', '1', '2', '3'].forEach((seatId) => {
        const prev = prevMap?.[seatId] || 'human';
        const next = nextMap?.[seatId] || 'human';
        if (prev !== next) {
            changes.push(`${seatName(seatId)} ${prev} -> ${next}`);
        }
    });
    return changes;
}

function updateSyncDiagnostics(prevRoomState, nextRoomState) {
    if (!nextRoomState) return;

    const prevMetaVersion = Number(prevRoomState?.meta?.version || 0);
    const prevGameVersion = Number(prevRoomState?.game?.version || 0);
    const prevHostUid = prevRoomState?.meta?.hostUid || null;
    const prevSeatControls = prevRoomState?.game?.state?.seatControls || {};

    const nextMetaVersion = Number(nextRoomState?.meta?.version || 0);
    const nextGameVersion = Number(nextRoomState?.game?.version || 0);
    const nextHostUid = nextRoomState?.meta?.hostUid || null;
    const nextSeatControls = nextRoomState?.game?.state?.seatControls || {};
    const updatedAt = Number(nextRoomState?.meta?.updatedAt || nextRoomState?.game?.state?.updatedAt || 0);
    const lagMs = updatedAt > 0 ? Math.max(0, Date.now() - updatedAt) : null;

    if (prevRoomState) {
        if (nextMetaVersion < prevMetaVersion) {
            pushDiagEvent(`meta.version : ${prevMetaVersion} -> ${nextMetaVersion}`, true);
        } else if (nextMetaVersion > prevMetaVersion) {
            pushDiagEvent(`meta.version : ${prevMetaVersion} -> ${nextMetaVersion}`);
        }

        if (nextGameVersion < prevGameVersion) {
            pushDiagEvent(`game.version : ${prevGameVersion} -> ${nextGameVersion}`, true);
        }

        if (prevHostUid && nextHostUid && prevHostUid !== nextHostUid) {
            pushDiagEvent(`host变更: ${prevHostUid.slice(0, 8)} -> ${nextHostUid.slice(0, 8)}`);
        }

        const changes = diffSeatControls(prevSeatControls, nextSeatControls);
        if (changes.length) {
            pushDiagEvent(`座位托管变化: ${changes.join(' | ')}`);
        }
    }

    syncDiagnostics.lastMetaVersion = nextMetaVersion;
    syncDiagnostics.lastGameVersion = nextGameVersion;
    syncDiagnostics.lastHostUid = nextHostUid;
    syncDiagnostics.lastSeatControlMap = JSON.stringify(nextSeatControls || {});
    syncDiagnostics.latestLagMs = lagMs;
    syncDiagnostics.latestUpdatedAt = updatedAt > 0 ? updatedAt : null;
    syncDiagnostics.latestLastAction = nextRoomState?.game?.state?.lastAction || null;
}

function formatDiagTs(ts) {
    if (!Number.isFinite(ts)) return '--:--:--';
    try {
        return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
    } catch {
        return '--:--:--';
    }
}

function formatLagMs(ms) {
    if (!Number.isFinite(ms)) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function renderSyncDiagnostics() {
    if (!syncDiagnosticsEl) return;
    if (!roomState) {
        syncDiagnosticsEl.innerHTML = '<div class="muted">等待房间状态...</div>';
        return;
    }

    const hostUid = syncDiagnostics.lastHostUid || '-';
    const hostShort = hostUid === '-' ? '-' : `${hostUid.slice(0, 8)}...`;
    const gameState = roomState?.game?.state || {};
    const pending = gameState?.pendingClaim ? '有待响应' : '无';
    const lastAction = syncDiagnostics.latestLastAction;
    const actionSeatText = Number.isInteger(lastAction?.seatId) ? seatName(lastAction.seatId) : '-';
    const lastActionText = lastAction
        ? `${lastAction.type} @ ${actionSeatText} (${formatDiagTs(lastAction.ts)})`
        : '-';
    const events = syncDiagnostics.events.slice(-8).reverse();
    const hasWarn = events.some((x) => x.warn);

    syncDiagnosticsEl.innerHTML = `
        <div class="diag-grid">
            <div class="diag-item">
                <div class="diag-key"> uid</div>
                <div class="diag-val">${hostShort}</div>
            </div>
            <div class="diag-item">
                <div class="diag-key">meta.version / game.version</div>
                <div class="diag-val">${syncDiagnostics.lastMetaVersion ?? '-'} / ${syncDiagnostics.lastGameVersion ?? '-'}</div>
            </div>
            <div class="diag-item">
                <div class="diag-key">更新时间 / 延迟</div>
                <div class="diag-val">${formatDiagTs(syncDiagnostics.latestUpdatedAt)} / ${formatLagMs(syncDiagnostics.latestLagMs)}</div>
            </div>
            <div class="diag-item">
                <div class="diag-key">pendingClaim / 最近动作</div>
                <div class="diag-val">${pending} / ${lastActionText}</div>
            </div>
        </div>
        <div class="diag-list">
            <div class="diag-row${hasWarn ? ' warn' : ''}">现在 ${diagNowText()}</div>
            ${events.length ? events.map((entry) => `
                <div class="diag-row${entry.warn ? ' warn' : ''}">
                    ${formatDiagTs(entry.ts)}  ${entry.text}
                </div>
            `).join('') : '<div class="diag-row">暂无事件</div>'}
        </div>
    `;
}

function buildDiagnosticsText() {
    const lines = [];
    lines.push(`room=${roomCode}`);
    lines.push(`hostUid=${syncDiagnostics.lastHostUid || '-'}`);
    lines.push(`metaVersion=${syncDiagnostics.lastMetaVersion ?? '-'}`);
    lines.push(`gameVersion=${syncDiagnostics.lastGameVersion ?? '-'}`);
    lines.push(`lag=${formatLagMs(syncDiagnostics.latestLagMs)}`);
    const lastAction = syncDiagnostics.latestLastAction;
    if (lastAction) {
        lines.push(`lastAction=${lastAction.type} seat=${lastAction.seatId} ts=${lastAction.ts}`);
    }
    syncDiagnostics.events.slice(-10).forEach((event) => {
        lines.push(`[${formatDiagTs(event.ts)}] ${event.warn ? '[WARN] ' : ''}${event.text}`);
    });
    return lines.join('\n');
}

async function handleCopyDiagnostics() {
    const text = buildDiagnosticsText();
    if (!text) {
        setActionStatus('暂无诊断信息可复制', true);
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        setActionStatus('已复制诊断信息');
    } catch {
        setActionStatus('复制失败，请检查浏览器剪贴板权限', true);
    }
}

async function handleCopyRoomCode() {
    if (!roomCode) {
        setActionStatus('房间码为空，暂不可复制。', true);
        return;
    }
    try {
        await navigator.clipboard.writeText(roomCode);
        setActionStatus(`已复制房间码：${roomCode}`);
    } catch {
        setActionStatus('复制失败，请检查浏览器剪贴板权限', true);
    }
}

function redirectToLobby() {
    window.location.href = './index.html';
}

function readRoomCodeFromUrl() {
    const query = new URLSearchParams(window.location.search);
    return (query.get('room') || '').trim().toUpperCase();
}

function isHost() {
    return !!(roomState && roomState.meta?.hostUid === session.uid);
}

function loadDebugModePreference() {
    try {
        return window.sessionStorage.getItem(DEBUG_MODE_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

function saveDebugModePreference(enabled) {
    try {
        window.sessionStorage.setItem(DEBUG_MODE_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
        // 会话存储失败
    }
}

function isDebugActionAllowed() {
    return !!(roomState && debugModeEnabled && isHost());
}

function getDebugSeatOverride() {
    const raw = (actionSeatSelect?.value || 'SELF').toUpperCase();
    if (raw === 'SELF') {
        const selfSeat = Number(session?.seatId);
        return Number.isInteger(selfSeat) ? selfSeat : 0;
    }

    const seatId = Number(raw);
    if (!Number.isInteger(seatId) || seatId < 0 || seatId > 3) return null;
    return seatId;
}

function applyDebugPreset(presetKey) {
    const preset = DEBUG_PRESETS[presetKey];
    if (!preset) return false;
    actionTypeSelect.value = preset.type;
    actionPayloadInput.value = JSON.stringify(preset.payload);
    return true;
}

function hydrateDebugSelectLabels() {
    if (debugPresetSelect) {
        [...debugPresetSelect.options].forEach((option) => {
            const value = String(option.value || '').trim();
            if (!value) return;
            option.textContent = formatDebugPresetText(value);
        });
    }

    if (actionTypeSelect) {
        [...actionTypeSelect.options].forEach((option) => {
            const value = String(option.value || '').trim();
            if (!value) return;
            option.textContent = formatDebugActionTypeText(value);
        });
    }
}

function renderDebugControls() {
    const host = !!(roomState && isHost());
    const enabled = host && debugModeEnabled;

    if (debugModeToggleEl) {
        debugModeToggleEl.checked = !!debugModeEnabled;
        debugModeToggleEl.disabled = !host;
    }

    if (debugPanelEl) {
        debugPanelEl.classList.toggle('disabled', !enabled);
    }

    [debugPresetSelect, applyDebugPresetBtn, actionSeatSelect, actionTypeSelect, actionPayloadInput, sendActionBtn]
        .forEach((el) => {
            if (!el) return;
            el.disabled = !enabled;
        });

    if (!debugModeHintEl) return;
    if (!host) {
        debugModeHintEl.textContent = '仅房主可用';
        return;
    }
    debugModeHintEl.textContent = enabled
        ? '调试模式已开启，可发送动作/预设。'
        : '调试模式已关闭，开启后可手动发送动作。';
}

function renderMeta() {
    if (!roomState) {
        roomMetaEl.textContent = `房间 ${roomCode} | 同步中...`;
        return;
    }

    const role = isHost() ? '房主' : '成员';
    const seatText = session.seatId === null ? '观战' : `${seatNameAbsolute(session.seatId)}位`;
    const status = roomState.meta?.status || 'waiting';
    roomMetaEl.textContent = `房间 ${roomCode} | ${session.nickname}(${seatText}) | ${role} | 状态 ${roomStatusLabel(status)} | 版本 ${BUILD_TAG}`;
}

function renderStartGameControls() {
    if (!startGameBtn) return;
    const goldStartButtons = [startSingleGoldBtn, startDoubleGoldBtn, startTripleGoldBtn].filter(Boolean);
    const setGoldButtons = (disabled, title = '') => {
        goldStartButtons.forEach((btn) => {
            btn.disabled = disabled;
            btn.title = title;
        });
    };

    if (!roomState) {
        startGameBtn.disabled = true;
        startGameBtn.title = '等待房间状态同步';
        setGoldButtons(true, '等待房间状态同步');
        if (startGameHintEl) startGameHintEl.textContent = '等待房间状态同步...';
        return;
    }

    const status = roomState?.meta?.status || 'waiting';
    const hostUid = String(roomState?.meta?.hostUid || '');
    const hostShort = hostUid ? `${hostUid.slice(0, 8)}...` : '-';

    if (status !== 'waiting') {
        startGameBtn.disabled = true;
        startGameBtn.title = '当前状态不可开始对局';
        if (isHost()) {
            setGoldButtons(false, '房主可强制开局');
        } else {
            setGoldButtons(true, '仅房主可用');
        }
        if (startGameHintEl) {
            startGameHintEl.textContent = status === 'playing'
                ? '当前对局进行中，请等待本局结束。'
                : `当前状态为 ${roomStatusLabel(status)}，暂不可开始对局。`;
        }
        return;
    }

    if (isHost()) {
        startGameBtn.disabled = false;
        startGameBtn.title = '房主可开始对局';
        setGoldButtons(false, '房主可强制开局');
        if (startGameHintEl) startGameHintEl.textContent = '房主可点击开始对局。';
        return;
    }

    startGameBtn.disabled = true;
    setGoldStartButtonsDisabled(true);
    startGameBtn.title = '仅房主可开始对局';
    setGoldButtons(true, '仅房主可用');
    if (startGameHintEl) {
        startGameHintEl.textContent = `仅房主可开始对局，hostUid: ${hostShort}`;
    }
}

function seatBadge(label, className) {
    return `<span class="badge ${className}">${label}</span>`;
}

function renderSeats() {
    const seats = roomState?.seats || {};
    const hostUid = roomState?.meta?.hostUid || '';

    const html = ['0', '1', '2', '3'].map((seatId) => {
        const seat = seats[seatId];
        if (!seat) {
            return `
                <article class="seat-card">
                    <strong>座位 ${Number(seatId) + 1}</strong>
                    <div class="muted">空位</div>
                    <div class="badges">${seatBadge('空位', 'offline')}</div>
                </article>
            `;
        }

        const isSelf = !seat.isBot && seat.reservedUid === session.uid;
        const isHostSeat = !seat.isBot && seat.uid === hostUid;
        const badges = [];
        badges.push(seatBadge(seat.online ? '在线' : '离线', seat.online ? 'online' : 'offline'));
        if (seat.isBot) badges.push(seatBadge('AI', 'bot'));
        if (!seat.isBot && seat.control === 'bot') badges.push(seatBadge('AI托管', 'takeover'));
        if (isHostSeat) badges.push(seatBadge('房主', 'takeover'));

        return `
            <article class="seat-card${isSelf ? ' self' : ''}${isHostSeat ? ' host' : ''}">
                <strong>座位 ${Number(seatId) + 1}</strong>
                <div>${seat.nickname || '(匿名)'}</div>
                <div class="muted">uid: ${seat.uid || '-'}</div>
                <div class="badges">${badges.join('')}</div>
            </article>
        `;
    }).join('');

    seatGridEl.innerHTML = html;
}

function renderStatePreview() {
    if (!statePreviewEl) return;
    if (!roomState) {
        statePreviewEl.textContent = '等待状态...';
        return;
    }
    statePreviewEl.textContent = JSON.stringify(roomState.game || {}, null, 2);
}

function seatName(seatId) {
    const n = Number(seatId);
    const selfSeat = Number(session?.seatId);
    const suffix = Number.isInteger(selfSeat) && selfSeat === n ? '(你)' : '';
    if (n === 0) return `南${suffix}`;
    if (n === 1) return `东${suffix}`;
    if (n === 2) return `北${suffix}`;
    if (n === 3) return `西${suffix}`;
    return `座位${n + 1}`;
}

function absoluteSeatName(seatId) {
    const n = Number(seatId);
    if (n === 0) return '南';
    if (n === 1) return '东';
    if (n === 2) return '北';
    if (n === 3) return '西';
    return `座位${n + 1}`;
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

function getPerspectiveSeatOrder(baseSeat) {
    const b = normalizeSeatNo(baseSeat, 0);
    return [
        { seatId: String((b + 2) % 4), pos: 'top' },
        { seatId: String((b + 3) % 4), pos: 'left' },
        { seatId: String((b + 1) % 4), pos: 'right' },
        { seatId: String(b), pos: 'bottom' }
    ];
}

function meldTypeLabel(type) {
    const map = {
        CHI: '吃',
        PENG: '碰',
        GANG: '明杠',
        AN_GANG: '暗杠',
        BU_GANG: '补杠'
    };
    return map[type] || type || '-';
}

function renderTileChips(tiles = [], options = {}) {
    const highlightIndex = Number.isInteger(options.highlightIndex) ? options.highlightIndex : -1;
    const meldTile = !!options.meldTile;
    if (!Array.isArray(tiles) || !tiles.length) return '<div class="table-empty">-</div>';
    return `<div class="table-chips">${
        tiles.map((tile, idx) => {
            const classes = ['table-chip'];
            if (idx === highlightIndex) classes.push('last-discard');
            if (meldTile) classes.push('meld-tile');
            return `<span class="${classes.join(' ')}">${tile}</span>`;
        }).join('')
    }</div>`;
}

function renderMeldList(groups = []) {
    if (!Array.isArray(groups) || !groups.length) return '<div class="table-empty">-</div>';
    return `<div class="meld-list">${
        groups.map((group) => `
            <div class="meld-item">
                <div class="meld-type">${meldTypeLabel(group?.type)}</div>
                ${renderTileChips(group?.tiles || [], { meldTile: true })}
            </div>
        `).join('')
    }</div>`;
}

function findLastDiscardIndex(river = [], lastDiscard = null, seatId = '') {
    if (!Array.isArray(river) || !river.length) return -1;
    if (!lastDiscard || String(lastDiscard.seatId) !== String(seatId)) return -1;
    for (let i = river.length - 1; i >= 0; i -= 1) {
        if (river[i] === lastDiscard.tile) return i;
    }
    return -1;
}

function renderTableBoard() {
    if (!tableBoardEl) return;
    const gameState = roomState?.game?.state || null;
    const seats = roomState?.seats || {};
    if (!gameState || !gameState.hands) {
        tableBoardEl.innerHTML = '<div class="table-empty">等待牌局初始化...</div>';
        return;
    }

    const lastDiscard = gameState.lastDiscard || null;
    const turnSeat = Number.isInteger(gameState.turnSeat) ? gameState.turnSeat : -1;
    const viewBaseSeat = getViewerBaseSeat();

    const seatHtml = getPerspectiveSeatOrder(viewBaseSeat).map(({ seatId, pos }) => {
        const seat = seats?.[seatId] || null;
        const hand = gameState.hands?.[seatId] || [];
        const river = gameState.rivers?.[seatId] || [];
        const flowers = gameState.flowers?.[seatId] || [];
        const shows = gameState.shows?.[seatId] || [];
        const selfSeat = Number(session?.seatId);
        const isSelf = Number.isInteger(selfSeat) && Number(seatId) === selfSeat;
        const isTurn = turnSeat === Number(seatId) && gameState.phase === 'playing';
        const control = gameState.seatControls?.[seatId] || (seat?.isBot ? 'bot' : 'human');
        const lastIdx = findLastDiscardIndex(river, lastDiscard, seatId);

        const cardClasses = ['table-seat'];
        if (isSelf) cardClasses.push('self');
        if (isTurn) cardClasses.push('turn');
        cardClasses.push(`pos-${pos}`);

        const badges = [];
        if (isTurn) badges.push(seatBadge('当前', 'turn'));
        if (control === 'bot') badges.push(seatBadge('AI', 'takeover'));
        if (seat?.isBot) badges.push(seatBadge('AI座位', 'bot'));
        if (!seat && gameState.phase === 'playing') badges.push(seatBadge('空位', 'offline'));
        if (pos === 'bottom') badges.push(seatBadge('你', 'online'));

        const relativeLabel = getRelativeSeatLabel(Number(seatId), viewBaseSeat);
        const absoluteLabel = absoluteSeatName(seatId);
        const titleText = relativeLabel ? `${relativeLabel}（${absoluteLabel}）` : `（${absoluteLabel}）`;

        return `
            <article class="${cardClasses.join(' ')}">
                <div class="table-head">
                    <div>
                        <div class="table-title">${titleText}</div>
                        <div class="table-sub">${seat?.nickname || '(空位/AI座位)'}</div>
                    </div>
                    <div class="badges">${badges.join('')}</div>
                </div>
                <div class="table-row">
                    <div class="table-label">${hand.length}</div>
                </div>
                <div class="table-row">
                    <div class="table-label">牌河</div>
                    ${renderTileChips(river, { highlightIndex: lastIdx })}
                </div>
                <div class="table-row">
                    <div class="table-label">副露</div>
                    ${renderMeldList(shows)}
                </div>
                <div class="table-row">
                    <div class="table-label">花 ${flowers.length}</div>
                    ${renderTileChips(flowers)}
                </div>
            </article>
        `;
    }).join('');

    const goldTile = gameState.goldTile || '';
    const goldText = goldTile ? toTileEmoji(goldTile) : '?';
    const restCount = Array.isArray(gameState.wall) ? gameState.wall.length : 0;
    const centerHtml = `
        <article class="table-center">
            <div class="table-center-title">桌面状态</div>
            <div class="table-center-label">金牌</div>
            <div class="table-center-gold">${goldText}</div>
            <div class="table-center-code">${goldTile || '-'}</div>
            <div class="table-center-rest">剩余 ${restCount}</div>
        </article>
    `;

    tableBoardEl.innerHTML = `${seatHtml}${centerHtml}`;
}

function formatDeltaLine(delta = []) {
    return [0, 1, 2, 3].map((seatId) => {
        const value = Number(delta[seatId] || 0);
        const sign = value >= 0 ? '+' : '';
        return `${seatName(seatId)} ${sign}${value}`;
    }).join(' | ');
}

function formatInstantType(entry = {}) {
    if (entry.type === 'AN_GANG') return `暗杠 - ${seatName(entry.seatId)}`;
    if (entry.type === 'MING_GANG') return `明/补杠 - ${seatName(entry.seatId)}`;
    if (entry.type === 'CHUI_FENG') return `吹风 - 庄 ${seatName(entry.seatId)}${entry.targetTile ? ` (${entry.targetTile})` : ''}`;
    return entry.type || '即时分';
}

function formatInstantTs(ts) {
    if (!Number.isFinite(ts)) return '--:--:--';
    try {
        return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
    } catch {
        return '--:--:--';
    }
}

function renderInstantScoreLog() {
    if (!roomState) {
        instantScoreLogEl.innerHTML = '<div class="muted">等待状态...</div>';
        return;
    }

    const logs = roomState?.game?.state?.instantScoreLog;
    if (!Array.isArray(logs) || !logs.length) {
        instantScoreLogEl.innerHTML = '<div class="muted">暂无即时分记录</div>';
        return;
    }

    const rows = logs.slice(-10).reverse().map((entry) => `
        <div class="instant-row">
            <div class="instant-title">${formatInstantType(entry)}  ${formatInstantTs(entry.ts)}</div>
            <div class="instant-delta">${formatDeltaLine(entry.delta || [])}</div>
        </div>
    `);
    instantScoreLogEl.innerHTML = rows.join('');
}

function renderOutcome() {
    const gameState = roomState?.game?.state || null;
    const outcome = gameState?.outcome || null;
    if (!gameState || gameState.phase !== 'ended' || !outcome) {
        outcomeCardEl.style.display = 'none';
        return;
    }

    outcomeCardEl.style.display = 'block';
    const typeText = outcome.isSelfDraw ? '自摸' : '点炮胡';
    const winnerText = seatName(outcome.winner);
    const special = Array.isArray(outcome.specialTypes) && outcome.specialTypes.length
        ? ` | 番型: ${outcome.specialTypes.join('、')}`
        : '';
    outcomeSummaryEl.textContent = `${winnerText} ${typeText} | 总赢: ${outcome.totalWin ?? '-'}${special}`;

    const payout = Array.isArray(outcome.payout) ? outcome.payout : [];
    outcomePayoutEl.innerHTML = `<div class="payout-list">${
        payout.map((val, idx) => {
            const className = val >= 0 ? 'positive' : 'negative';
            const sign = val >= 0 ? '+' : '';
            return `<div class="payout-row"><span>${seatName(idx)}</span><span class="payout-val ${className}">${sign}${val}</span></div>`;
        }).join('')
    }</div>`;

    nextRoundBtn.style.display = isHost() ? 'inline-flex' : 'none';
}

function renderReactionBar() {
    if (!roomState || session.seatId === null) {
        reactionBarEl.innerHTML = '';
        return;
    }

    const gameState = roomState.game?.state || null;
    const seatId = String(session.seatId);
    const pending = gameState?.pendingClaim || null;
    if (pending) {
        const options = pending.optionsBySeat?.[seatId];
        if (!options) {
            reactionBarEl.innerHTML = '';
            return;
        }
        if (!isSeatActivePendingDecision(pending, seatId)) {
            reactionBarEl.innerHTML = '';
            return;
        }

        const controls = [];
        if (options.HU) controls.push(`<button class="btn btn-primary" data-reaction-type="HU">胡</button>`);
        if (options.PENG) controls.push(`<button class="btn" data-reaction-type="PENG">碰</button>`);
        if (options.GANG) controls.push(`<button class="btn" data-reaction-type="GANG">杠</button>`);
        if (Array.isArray(options.CHI) && options.CHI.length) {
            options.CHI.forEach((choice) => {
                const label = Array.isArray(choice) ? choice.join(' ') : '';
                controls.push(`<button class="btn" data-reaction-type="CHI" data-reaction-choice='${JSON.stringify(choice)}'>吃 ${label}</button>`);
            });
        }
        controls.push(`<button class="btn" data-reaction-type="PASS">过</button>`);
        reactionBarEl.innerHTML = controls.join('');
        return;
    }

    if (!gameState || gameState.phase !== 'playing' || gameState.turnSeat !== Number(seatId)) {
        reactionBarEl.innerHTML = '';
        return;
    }

    const hand = gameState.hands?.[seatId] || [];
    const goldTile = gameState.goldTile;
    const controls = [];
    const selfHuInfo = getSelfDrawHuInfo(gameState, Number(seatId));
    const canHu = !!selfHuInfo?.canHu;
    const mustHu = canHu && Array.isArray(selfHuInfo.types) && selfHuInfo.types.includes('三金倒');

    if (!mustHu) {
        const countMap = {};
        hand.forEach((tile) => {
            if (tile === goldTile || tile?.startsWith('H')) return;
            countMap[tile] = (countMap[tile] || 0) + 1;
        });
        Object.keys(countMap).filter((tile) => countMap[tile] === 4).forEach((tile) => {
            controls.push(`<button class="btn" data-turn-type="AN_GANG" data-turn-char="${tile}">暗杠 ${tile}</button>`);
        });

        const showGroups = gameState.shows?.[seatId] || [];
        const buGangSet = new Set();
        showGroups.forEach((g) => {
            if (g?.type !== 'PENG' || !Array.isArray(g.tiles) || !g.tiles.length) return;
            const tile = g.tiles[0];
            if (hand.includes(tile)) buGangSet.add(tile);
        });
        [...buGangSet].forEach((tile) => {
            controls.push(`<button class="btn" data-turn-type="BU_GANG" data-turn-char="${tile}">补杠 ${tile}</button>`);
        });
    }

    if (canHu) controls.push(`<button class="btn btn-primary" data-turn-type="HU">自摸胡</button>`);
    reactionBarEl.innerHTML = controls.join('');
}

function renderSelfHand() {
    if (!roomState || session.seatId === null) {
        selectedDiscardIndex = null;
        turnHintEl.textContent = '观战模式暂无手牌';
        selfHandEl.innerHTML = '';
        return;
    }

    const gameState = roomState.game?.state || null;
    if (!gameState || !gameState.hands) {
        selectedDiscardIndex = null;
        turnHintEl.textContent = '等待牌局初始化...';
        selfHandEl.innerHTML = '';
        return;
    }

    const seatId = String(session.seatId);
    const hand = gameState.hands?.[seatId] || [];
    const turnSeat = Number.isInteger(gameState.turnSeat) ? gameState.turnSeat : -1;
    const control = gameState.seatControls?.[seatId] || 'human';
    const selfClaimOptions = gameState.pendingClaim?.optionsBySeat?.[seatId] || null;
    const waitingClaim = !!selfClaimOptions;
    const waitingClaimActive = waitingClaim && isSeatActivePendingDecision(gameState.pendingClaim, seatId);
    const waitingClaimBlocked = waitingClaim && !waitingClaimActive;
    const mustHu = hasMandatorySanJinHu(gameState, Number(seatId));
    const canDiscard = gameState.phase === 'playing' && turnSeat === Number(seatId) && control !== 'bot' && !gameState.pendingClaim && !mustHu;
    if (!Number.isInteger(selectedDiscardIndex) || selectedDiscardIndex < 0 || selectedDiscardIndex >= hand.length) {
        selectedDiscardIndex = null;
    }

    if (gameState.phase !== 'playing') {
        turnHintEl.textContent = '当前已结算，等待下一局';
    } else if (control === 'bot') {
        turnHintEl.textContent = '当前 AI 正在代打此座位';
    } else if (waitingClaimActive) {
        turnHintEl.textContent = '请先响应：吃 / 碰 / 杠 / 胡 / 过';
    } else if (waitingClaimBlocked) {
        turnHintEl.textContent = '等待高优先级玩家先决策...';
    } else if (mustHu) {
        turnHintEl.textContent = '当前为三金倒，必须胡牌';
    } else if (canDiscard) {
        turnHintEl.textContent = '轮到你出牌，已提牌可打出';
    } else {
        turnHintEl.textContent = `等待轮到你出牌（当前 ${absoluteSeatName(turnSeat)}位）`;
    }

    selfHandEl.innerHTML = hand.map((tile, index) => {
        const selectedClass = selectedDiscardIndex === index ? ' selected' : '';
        return `<button class=\"tile-btn${selectedClass}\" data-discard-index=\"${index}\" data-can-discard=\"${canDiscard ? '1' : '0'}\">${tile}</button>`;
    }).join('');
}

function render() {
    renderMeta();
    renderStartGameControls();
    renderSeats();
    renderTableBoard();
    renderStatePreview();
    renderSyncDiagnostics();
    renderSelfHand();
    renderReactionBar();
    renderOutcome();
    renderInstantScoreLog();
    renderDebugControls();
}

async function runHostLoop() {
    if (!roomState || !isHost() || hostLoopBusy) return;
    hostLoopBusy = true;
    try {
        await syncSeatControls(roomCode, session.uid);
        await processPendingActions(roomCode, session.uid);
    } catch (error) {
        const message = String(error?.message || error || 'unknown');
        setActionStatus(`房主循环异常: ${message}`, true);
        console.error('[room-host-loop]', error);
        pushDiagEvent(`房主循环异常: ${message}`, true);
        if (message.toLowerCase().includes('permission_denied')) {
            stopHostLoop();
            pushDiagEvent('房主循环 permission_denied，已停止并等待重选', true);
        }
    } finally {
        hostLoopBusy = false;
    }
}

function ensureHostLoop() {
    if (hostLoopTimer) return;
    hostLoopTimer = setInterval(() => {
        runHostLoop();
    }, HOST_LOOP_INTERVAL_MS);
    runHostLoop();
}

function stopHostLoop() {
    if (!hostLoopTimer) return;
    clearInterval(hostLoopTimer);
    hostLoopTimer = null;
}

async function handleStartGame() {
    if (!isHost()) {
        const hostUid = String(roomState?.meta?.hostUid || '-');
        setActionStatus(`仅房主可开始对局，hostUid: ${hostUid.slice(0, 8)}...`, true);
        return;
    }

    startGameBtn.disabled = true;
    setActionStatus('开始对局...');
    try {
        await startRoomGame(roomCode, session.uid);
        setActionStatus('已开始对局。');
    } catch (error) {
        const baseMsg = error.message || '开始对局失败。';
        const status = String(roomState?.meta?.status || '-');
        const hostUid = String(roomState?.meta?.hostUid || '-');
        const selfUid = String(session?.uid || '-');
        const detail = `status=${status}, host=${hostUid.slice(0, 8)}..., self=${selfUid.slice(0, 8)}...`;
        setActionStatus(`${baseMsg}${detail}`, true);
        pushDiagEvent(`开始对局失败: ${baseMsg} | ${detail}`, true);
    } finally {
        renderStartGameControls();
    }
}

function setGoldStartButtonsDisabled(disabled) {
    [startSingleGoldBtn, startDoubleGoldBtn, startTripleGoldBtn].forEach((btn) => {
        if (!btn) return;
        btn.disabled = disabled;
    });
}

async function handleForcedGoldStart(forcedHostGoldCount) {
    if (!isHost()) {
        const hostUid = String(roomState?.meta?.hostUid || '-');
        setActionStatus(`仅房主可使用强制金牌开局，hostUid: ${hostUid.slice(0, 8)}...`, true);
        return;
    }

    const target = Number(forcedHostGoldCount);
    if (!Number.isInteger(target) || target < 1 || target > 3) {
        setActionStatus('金牌数量无效', true);
        return;
    }

    if (startGameBtn) startGameBtn.disabled = true;
    setGoldStartButtonsDisabled(true);

    setActionStatus(`强制金牌 ${target} 开局...`);
    try {
        await startRoomGame(roomCode, session.uid, {
            forceNewRound: true,
            forcedHostGoldCount: target
        });
        setActionStatus(`已强制金牌 ${target} 开局`);
    } catch (error) {
        const baseMsg = error.message || '强制开局失败。';
        setActionStatus(baseMsg, true);
        pushDiagEvent(`强制开局失败: forcedGold=${target} | ${baseMsg}`, true);
    } finally {
        renderStartGameControls();
    }
}

function parseActionPayload(rawText) {
    const trimmed = (rawText || '').trim();
    if (!trimmed) return {};
    return JSON.parse(trimmed);
}

function handleDebugModeToggle(event) {
    const next = !!event.target.checked;
    if (!isHost()) {
        debugModeEnabled = false;
        saveDebugModePreference(false);
        renderDebugControls();
        setActionStatus('仅房主可切换调试模式', true);
        return;
    }

    debugModeEnabled = next;
    saveDebugModePreference(next);
    renderDebugControls();
    setActionStatus(next ? '调试模式已开启' : '调试模式已关闭');
}

function handleApplyDebugPreset() {
    if (!isDebugActionAllowed()) {
        setActionStatus('请先开启调试模式', true);
        return;
    }

    const key = (debugPresetSelect?.value || '').trim();
    if (!key) {
        setActionStatus('请选择调试预设。', true);
        return;
    }

    if (!applyDebugPreset(key)) {
        setActionStatus(`未知预设: ${key}`, true);
        return;
    }

    setActionStatus(`已应用预设 ${key}`);
}

async function submitIntent(type, payload = {}, options = {}) {
    if (!roomState) return;
    const seatId = session.seatId === null || session.seatId === undefined ? 0 : Number(session.seatId);
    const action = createAction({
        type,
        seatId,
        payload,
        clientActionId: `${session.uid}-${Date.now()}`,
        ts: Date.now()
    });

    const button = options.button || null;
    if (button) button.disabled = true;
    const actionText = formatDebugActionTypeText(type);
    setActionStatus(options.pendingText || `提交 ${actionText}...`);

    try {
        await submitActionIntent(roomCode, session.uid, action);
        if (isHost()) {
            Promise.resolve().then(() => runHostLoop()).catch(() => {});
        }
        setActionStatus(options.successText || `已提交 ${actionText}`);
    } catch (error) {
        setActionStatus(error.message || '提交失败', true);
    } finally {
        if (button) button.disabled = false;
    }
}

async function handleSendAction() {
    if (!roomState) return;
    if (!isDebugActionAllowed()) {
        setActionStatus('房主调试模式下才可发送动作。', true);
        return;
    }

    const type = actionTypeSelect.value;
    if (!ACTION_TYPES.includes(type)) {
        setActionStatus(`不支持的动作类型：${type}`, true);
        return;
    }

    let payload = {};
    try {
        payload = parseActionPayload(actionPayloadInput.value);
    } catch (error) {
        setActionStatus(`payload JSON ?: ${error.message}`, true);
        return;
    }

    const seatIdOverride = getDebugSeatOverride();
    if (!Number.isInteger(seatIdOverride)) {
        setActionStatus('座位选择无效，请选择 1-4 或 SELF', true);
        return;
    }

    await submitIntent(type, payload, {
        button: sendActionBtn,
        seatIdOverride,
        pendingText: `调试发送 ${formatDebugActionTypeText(type)} -> ${seatName(seatIdOverride)}...`,
        successText: `已提交调试动作 ${formatDebugActionTypeText(type)}`
    });
}

async function handleSelfHandClick(event) {
    const btn = event.target.closest('[data-discard-index]');
    if (!btn) return;
    const canDiscard = btn.dataset.canDiscard === '1';
    const index = Number(btn.dataset.discardIndex);
    if (!Number.isInteger(index) || index < 0) return;
    const seatId = session.seatId === null ? null : String(session.seatId);
    const gameState = roomState?.game?.state || null;
    const hand = seatId && gameState ? (Array.isArray(gameState.hands?.[seatId]) ? gameState.hands[seatId] : []) : [];
    const tile = hand[index];

    if (selectedDiscardIndex !== index) {
        selectedDiscardIndex = index;
        renderSelfHand();
        if (canDiscard) {
            turnHintEl.textContent = tile
                ? `已提牌 ${toTileEmoji(tile)}，再次点击同一张牌打出`
                : '已提牌，再次点击同一张牌打出';
        } else {
            turnHintEl.textContent = tile
                ? `已提牌 ${toTileEmoji(tile)}，当前不可打出`
                : '已提牌，当前不可打出';
        }
        return;
    }

    if (!canDiscard) {
        setActionStatus(turnHintEl?.textContent || '当前不可出牌');
        return;
    }

    selectedDiscardIndex = null;

    await submitIntent('DISCARD', { index }, {
        pendingText: `提交 DISCARD index=${index}...`,
        successText: '已提交 DISCARD'
    });
}

function handleSelfHandContextMenu(event) {
    const btn = event.target.closest('[data-discard-index]');
    if (!btn) return;
    event.preventDefault();
    if (selectedDiscardIndex === null) return;
    selectedDiscardIndex = null;
    renderSelfHand();
    setActionStatus('已取消提牌');
}

async function handleReactionBarClick(event) {
    const btn = event.target.closest('[data-reaction-type]');
    if (btn) {
        const gameState = roomState?.game?.state || null;
        const pending = gameState?.pendingClaim || null;
        const selfSeatId = session?.seatId === null || session?.seatId === undefined ? '' : String(session.seatId);
        if (pending && selfSeatId && !isSeatActivePendingDecision(pending, selfSeatId)) {
            setActionStatus('当前等待高优先级玩家先决策...');
            return;
        }

        const type = btn.dataset.reactionType;
        if (!type) return;

        let payload = {};
        if (type === 'CHI' && btn.dataset.reactionChoice) {
            try {
                payload = { choice: JSON.parse(btn.dataset.reactionChoice) };
            } catch {
                payload = {};
            }
        }

        await submitIntent(type, payload, {
            pendingText: `响应 ${formatDebugActionTypeText(type)}...`,
            successText: `已提交 ${formatDebugActionTypeText(type)}`
        });
        return;
    }

    const turnBtn = event.target.closest('[data-turn-type]');
    if (!turnBtn) return;
    const type = turnBtn.dataset.turnType;
    if (!type) return;

    const payload = {};
    if (turnBtn.dataset.turnChar) payload.char = turnBtn.dataset.turnChar;
    await submitIntent(type, payload, {
        pendingText: `执行 ${formatDebugActionTypeText(type)}...`,
        successText: `已提交 ${formatDebugActionTypeText(type)}`
    });
}

async function handleLeaveRoom() {
    leaveRoomBtn.disabled = true;
    try {
        await leaveRoom(roomCode, session.uid, session.seatId);
    } catch {
        // 离房失败时仍继续清理会话
    }
    clearSession();
    redirectToLobby();
}

async function handleNextRound() {
    if (!isHost()) {
        setActionStatus('只有房主可以开始下一局', true);
        return;
    }
    await submitIntent('ROUND_START', {}, {
        button: nextRoundBtn,
        pendingText: '提交下一局请求...',
        successText: '已提交下一局请求。'
    });
}

async function bootstrap() {
    debugModeEnabled = loadDebugModePreference();
    hydrateDebugSelectLabels();
    renderDebugControls();

    if (!hasFirebaseConfig()) {
        const { missingKeys } = getFirebaseConfigStatus();
        setActionStatus(`请先填写 src/firebase-config.js，当前缺少：${missingKeys.join(', ')}`, true);
        if (startGameBtn) startGameBtn.disabled = true;
        if (sendActionBtn) sendActionBtn.disabled = true;
        return;
    }

    const roomFromUrl = readRoomCodeFromUrl();
    const cached = loadSession();
    if (!cached) {
        setActionStatus('会话已失效，正在返回大厅', true);
        setTimeout(redirectToLobby, 1200);
        return;
    }

    let authUser = null;
    try {
        authUser = await ensureAnonymousAuth();
    } catch (error) {
        setActionStatus(error.message || '登录失败，正在返回大厅', true);
        return;
    }

    if (cached.uid && authUser.uid !== cached.uid) {
        clearSession();
        setActionStatus('检测到登录身份变化，请重新加入房间。', true);
        setTimeout(redirectToLobby, 1200);
        return;
    }

    roomCode = roomFromUrl || (cached.roomCode || '').toUpperCase();
    session = {
        ...cached,
        uid: authUser.uid,
        roomCode
    };

    if (!roomCode) {
        setActionStatus('缺少房间码，正在返回大厅', true);
        setTimeout(redirectToLobby, 1200);
        return;
    }

    presentationEffects = createPresentationEffects({
        toastEl: actionToastEl,
        canvasEl: huCanvasEl,
        outcomeCardEl,
        getSeatName: (seatId) => seatName(String(seatId))
    });
    presentationEffects.bindUnlockEvents();

    unsubscribeRoom = subscribeRoom(roomCode, async (room) => {
        const prevRoomState = roomState;
        roomState = room;
        if (!roomState) {
            setActionStatus('房间不存在或已关闭', true);
            return;
        }
        updateSyncDiagnostics(prevRoomState, roomState);
        render();
        presentationEffects?.handleStateUpdate(prevRoomState, roomState);
        try {
            const election = await tryElectHost(roomCode, session.uid, roomState);
            if (election?.attempted && election?.committed) {
                pushDiagEvent(`host竞选成功 -> ${String(session.uid || '').slice(0, 8)}`);
            } else if (election?.reason === 'permission-denied') {
                pushDiagEvent('host竞选被拒: permission_denied', true);
            }
        } catch (error) {
            pushDiagEvent(`host竞选异常: ${error.message || error}`, true);
        }
    });

    detachPresence = await attachPresence(roomCode, session.uid, session.seatId, session.nickname);

    startGameBtn?.addEventListener('click', handleStartGame);
    startSingleGoldBtn?.addEventListener('click', () => handleForcedGoldStart(1));
    startDoubleGoldBtn?.addEventListener('click', () => handleForcedGoldStart(2));
    startTripleGoldBtn?.addEventListener('click', () => handleForcedGoldStart(3));
    copyRoomCodeBtn?.addEventListener('click', handleCopyRoomCode);
    leaveRoomBtn?.addEventListener('click', handleLeaveRoom);
    debugModeToggleEl?.addEventListener('change', handleDebugModeToggle);
    applyDebugPresetBtn?.addEventListener('click', handleApplyDebugPreset);
    copyDiagnosticsBtn?.addEventListener('click', handleCopyDiagnostics);
    sendActionBtn?.addEventListener('click', handleSendAction);
    selfHandEl?.addEventListener('click', handleSelfHandClick);
    selfHandEl?.addEventListener('contextmenu', handleSelfHandContextMenu);
    reactionBarEl?.addEventListener('click', handleReactionBarClick);
    nextRoundBtn?.addEventListener('click', handleNextRound);

    ensureHostLoop();
    setActionStatus('已进入房间，等待对局开始。');

    window.addEventListener('beforeunload', () => {
        if (detachPresence) {
            detachPresence();
        }
    });
}

window.addEventListener('unload', () => {
    if (unsubscribeRoom) unsubscribeRoom();
    stopHostLoop();
    presentationEffects?.dispose();
});

bootstrap().catch((error) => {
    setActionStatus(error.message || '页面初始化失败', true);
});




