import {
    attachPresence,
    createRoom,
    joinRoom,
    leaveRoom,
    rebindPresence,
    startRoomGame,
    subscribeRoom,
    switchSeat,
    tryElectHost
} from './room-service.js';
import { ensureAnonymousAuth, getFirebaseConfigStatus, hasFirebaseConfig } from './firebase-client.js';
import { clearSession, loadSession, saveSession } from './session.js';
import { initMobileScreenGuard } from './mobile-screen-guard.js';
import { showActionToast } from './ui-toast.js';
import { initLobbyGuestbook } from './lobby-guestbook.js';

// 文案门禁关键短语（勿删）：
// 等待房间状态同步

const nicknameInput = document.getElementById('nickname-input');
const roomCodeInput = document.getElementById('room-code-input');
const createRoomBtn = document.getElementById('create-room-btn');
const createRoomDebugBtn = document.getElementById('create-room-debug-btn');
const joinRoomBtn = document.getElementById('join-room-btn');
const joinRoomDebugBtn = document.getElementById('join-room-debug-btn');
const debugRoomActionsEl = document.getElementById('debug-room-actions');
const statusEl = document.getElementById('lobby-status');
const lobbyFormCard = document.getElementById('lobby-form-card');
const battleRoomPanel = document.getElementById('battle-room-panel');
const battleRoomMetaEl = document.getElementById('battle-room-meta');
const battleStartBtn = document.getElementById('battle-start-btn');
const battleStandUpBtn = document.getElementById('battle-standup-btn');
const battleCopyRoomBtn = document.getElementById('battle-copy-room-btn');
const battleLeaveBtn = document.getElementById('battle-leave-btn');
const battleSeatBoardEl = document.getElementById('battle-seat-board');

let session = null;
let roomCode = '';
let roomState = null;
let unsubscribeRoom = null;
let detachPresence = null;
let redirecting = false;
let seatSwitchBusy = false;
let pendingSeatSwitch = null;
let debugEntryUnlocked = false;
let disposeGuestbook = null;
const disposeScreenGuard = initMobileScreenGuard({
    expectedOrientation: 'portrait',
    rootSelector: 'main.page',
    pageName: '大厅',
    enforceOrientation: false
});

function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.style.color = isError ? '#b91c1c' : '#1f2937';
}

function getNickname() {
    return (nicknameInput.value || '').trim();
}

function setFormBusy(busy) {
    [createRoomBtn, createRoomDebugBtn, joinRoomBtn, joinRoomDebugBtn].forEach((btn) => {
        if (!btn) return;
        btn.disabled = !!busy;
    });
}

function applyDebugEntryVisibility() {
    const visible = !!debugEntryUnlocked;
    if (debugRoomActionsEl) {
        debugRoomActionsEl.classList.toggle('hidden', !visible);
        debugRoomActionsEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
    }
    if (createRoomDebugBtn) createRoomDebugBtn.classList.toggle('hidden', !visible);
    if (joinRoomDebugBtn) joinRoomDebugBtn.classList.toggle('hidden', !visible);
}

function unlockDebugEntry(fromConsole = false) {
    if (debugEntryUnlocked) return true;
    debugEntryUnlocked = true;
    applyDebugEntryVisibility();
    setStatus('调试房间入口已解锁（仅当前页面有效）。');
    if (fromConsole) {
        console.info('[lobby] 调试房间入口已解锁（仅当前页面有效）');
    }
    return true;
}

function ensureDebugEntryUnlocked() {
    if (debugEntryUnlocked) return true;
    setStatus('调试入口已隐藏，请在控制台输入 tiaoshi 解锁。', true);
    return false;
}

function registerDebugUnlockToken() {
    const unlockToken = () => {
        unlockDebugEntry(true);
        return 'debug-room-unlocked';
    };

    try {
        Object.defineProperty(window, 'tiaoshi', {
            configurable: true,
            get() {
                unlockToken();
                return unlockToken;
            },
            set() {
                unlockToken();
            }
        });
    } catch {
        window.tiaoshi = unlockToken;
    }
}

function setWaitingMode(inWaitingRoom) {
    if (lobbyFormCard) lobbyFormCard.classList.toggle('hidden', !!inWaitingRoom);
    if (battleRoomPanel) battleRoomPanel.classList.toggle('hidden', !inWaitingRoom);
}

function normalizeRoomCode(code) {
    return (code || '').trim().toUpperCase();
}

function seatNameAbsolute(seatId) {
    const n = Number(seatId);
    if (n === 0) return '南';
    if (n === 1) return '东';
    if (n === 2) return '北';
    if (n === 3) return '西';
    return `座位${n + 1}`;
}

function getBattleSeatOrder() {
    return [
        { seatId: '2', pos: 'top' },
        { seatId: '3', pos: 'left' },
        { seatId: '1', pos: 'right' },
        { seatId: '0', pos: 'bottom' }
    ];
}

function findSelfSeatIdFromRoom(room, uid) {
    if (!room || !uid) return null;
    const seats = room?.seats || {};
    for (const seatId of ['0', '1', '2', '3']) {
        const seat = seats?.[seatId];
        if (!seat || seat.isBot) continue;
        if (String(seat.reservedUid || '') === String(uid)) return String(seatId);
    }
    return null;
}

function getCurrentSeatId() {
    if (!session) return null;
    return session.seatId === null || session.seatId === undefined ? null : String(session.seatId);
}

function isHost() {
    return !!(roomState && session && roomState.meta?.hostUid === session.uid);
}

function getRoomEntryPath(entryMode) {
    return entryMode === 'debug' ? './game-debug.html' : './game.html';
}

function gotoRoomPage(targetSession, entryMode = 'battle') {
    saveSession(targetSession);
    const targetPath = getRoomEntryPath(entryMode);
    window.location.href = `${targetPath}?room=${encodeURIComponent(targetSession.roomCode)}`;
}

function redirectToBattleGame() {
    if (!session || !roomCode || redirecting) return;
    redirecting = true;
    const payload = {
        ...session,
        roomCode,
        entryMode: 'battle'
    };
    gotoRoomPage(payload, 'battle');
}

function setBattleButtonsBusy(busy) {
    if (battleStartBtn) battleStartBtn.disabled = !!busy;
    if (battleLeaveBtn) battleLeaveBtn.disabled = !!busy;
    if (battleStandUpBtn) battleStandUpBtn.disabled = !!busy;
}

function renderBattleRoomMeta() {
    if (!battleRoomMetaEl || !session || !roomState) return;

    const role = isHost() ? '房主' : '成员';
    battleRoomMetaEl.textContent = `房间 ${roomCode} | ${role}`;
}

function syncBattleStartButtonState() {
    if (!battleStartBtn) return;
    if (!roomState) {
        battleStartBtn.disabled = true;
        return;
    }

    const status = roomState?.meta?.status || 'waiting';
    if (status !== 'waiting') {
        battleStartBtn.disabled = true;
        return;
    }

    battleStartBtn.disabled = false;
}

function syncBattleStandUpButtonState() {
    if (!battleStandUpBtn) return;
    if (!roomState || !session) {
        battleStandUpBtn.style.display = 'none';
        battleStandUpBtn.disabled = true;
        return;
    }

    const waiting = (roomState?.meta?.status || 'waiting') === 'waiting';
    const seated = getCurrentSeatId() !== null;
    const visible = waiting && seated;
    battleStandUpBtn.style.display = visible ? 'inline-block' : 'none';
    battleStandUpBtn.disabled = !visible || seatSwitchBusy;
}

function buildOptimisticSeats(baseSeats = {}) {
    if (!pendingSeatSwitch || !session) return baseSeats;
    const fromSeatId = pendingSeatSwitch?.fromSeatId || null;
    const toSeatId = pendingSeatSwitch?.toSeatId || null;
    if (!toSeatId) return baseSeats;

    const now = Date.now();
    const seats = { ...baseSeats };

    if (fromSeatId && seats[fromSeatId] && !seats[fromSeatId].isBot && seats[fromSeatId].reservedUid === session.uid) {
        seats[fromSeatId] = {
            seatId: fromSeatId,
            uid: `bot-${fromSeatId}`,
            reservedUid: null,
            nickname: '切换中...',
            isBot: true,
            online: true,
            control: 'bot',
            lastSeen: now
        };
    }

    const target = seats[toSeatId];
    if (!target || target.isBot || target.reservedUid === session.uid) {
        seats[toSeatId] = {
            seatId: toSeatId,
            uid: session.uid,
            reservedUid: session.uid,
            nickname: `${session.nickname}(切换中)`,
            isBot: false,
            online: true,
            control: 'human',
            lastSeen: now
        };
    }

    return seats;
}

function seatBadge(label, className) {
    return `<span class="badge ${className}">${label}</span>`;
}

function renderBattleSeatBoard() {
    if (!battleSeatBoardEl || !roomState || !session) return;
    const seats = buildOptimisticSeats(roomState?.seats || {});
    const hostUid = roomState?.meta?.hostUid || '';
    const waiting = (roomState?.meta?.status || 'waiting') === 'waiting';

    const cards = getBattleSeatOrder().map(({ seatId, pos }) => {
        const seat = seats?.[seatId] || null;
        const isHuman = !!(seat && !seat.isBot);
        const isSelf = !!(isHuman && seat.reservedUid === session.uid);
        const isHostSeat = !!(isHuman && seat.uid === hostUid);
        const isAvailable = !isHuman;
        const canChoose = waiting && isAvailable;
        const occupiedByOthers = isHuman && !isSelf;

        const classes = ['battle-seat-card', `pos-${pos}`];
        if (isSelf) classes.push('self');
        if (isHostSeat) classes.push('host');
        if (canChoose && !seatSwitchBusy) classes.push('available');
        if (pendingSeatSwitch?.toSeatId === seatId || pendingSeatSwitch?.fromSeatId === seatId) {
            classes.push('switching');
        }

        const seatMain = isHuman ? (seat.nickname || '(未命名)') : '空位';
        const seatSub = isHuman ? '已入座' : '等待入座';
        const badges = [];
        if (isHuman) {
            badges.push(seatBadge(seat.online ? '在线' : '离线', seat.online ? 'online' : 'offline'));
            if (seat.control === 'bot') badges.push(seatBadge('AI接管', 'takeover'));
            if (isHostSeat) badges.push(seatBadge('房主', 'takeover'));
            if (isSelf) badges.push(seatBadge('你', 'online'));
        } else {
            badges.push(seatBadge('可选', 'bot'));
        }

        return `
            <button
                type="button"
                class="${classes.join(' ')}"
                data-seat-id="${seatId}"
                ${canChoose && !seatSwitchBusy ? '' : 'disabled'}
                title="${occupiedByOthers ? '该座位已被占用' : `切换到${seatNameAbsolute(seatId)}位`}"
            >
                <div class="battle-seat-title">${seatNameAbsolute(seatId)}位</div>
                <div class="battle-seat-main">${seatMain}</div>
                <div class="battle-seat-sub">${seatSub}</div>
                <div class="badges">${badges.join('')}</div>
            </button>
        `;
    }).join('');

    battleSeatBoardEl.innerHTML = `${cards}<div class="battle-seat-empty" aria-hidden="true"></div>`;
}

function renderWaitingRoom() {
    renderBattleRoomMeta();
    syncBattleStartButtonState();
    syncBattleStandUpButtonState();
    renderBattleSeatBoard();
}

async function detachPresenceSafe() {
    if (!detachPresence) return;
    const fn = detachPresence;
    detachPresence = null;
    try {
        await fn();
    } catch {
        // 忽略 presence 清理失败
    }
}

function disposeRoomSubscription() {
    if (!unsubscribeRoom) return;
    try {
        unsubscribeRoom();
    } catch {
        // 忽略取消订阅失败
    }
    unsubscribeRoom = null;
}

async function cleanupWaitingRoom({ clearStored = false } = {}) {
    disposeRoomSubscription();
    await detachPresenceSafe();
    roomState = null;
    roomCode = '';
    seatSwitchBusy = false;
    pendingSeatSwitch = null;
    redirecting = false;
    if (clearStored) {
        clearSession();
        session = null;
    }
    setWaitingMode(false);
    setBattleButtonsBusy(false);
    syncBattleStandUpButtonState();
}

async function reattachPresenceForSeat() {
    await detachPresenceSafe();
    detachPresence = await attachPresence(roomCode, session.uid, session.seatId, session.nickname);
}

async function subscribeWaitingRoom() {
    disposeRoomSubscription();
    unsubscribeRoom = subscribeRoom(roomCode, async (room) => {
        roomState = room;
        if (!roomState) {
            setStatus('房间不存在或已销毁，已返回大厅。', true);
            await cleanupWaitingRoom({ clearStored: true });
            return;
        }

        if (pendingSeatSwitch && session?.uid) {
            const confirmedSeatId = findSelfSeatIdFromRoom(roomState, session.uid);
            const targetSeatId = pendingSeatSwitch.toSeatId ?? null;
            const switchedToTarget = targetSeatId === null
                ? confirmedSeatId === null
                : (confirmedSeatId === targetSeatId);
            if (switchedToTarget) {
                pendingSeatSwitch = null;
            }
        }

        if ((roomState?.meta?.status || 'waiting') === 'waiting' && session?.uid) {
            try {
                await tryElectHost(roomCode, session.uid, roomState);
            } catch {
                // 房主迁移失败时不阻断等待房间渲染
            }
        }

        renderWaitingRoom();
        const status = roomState?.meta?.status || 'waiting';
        if (status === 'playing') {
            redirectToBattleGame();
        }
    });
}

async function enterWaitingRoom(nextSession) {
    await cleanupWaitingRoom({ clearStored: false });

    session = {
        ...nextSession,
        roomCode: normalizeRoomCode(nextSession.roomCode),
        entryMode: 'battle_waiting'
    };
    roomCode = session.roomCode;
    saveSession(session);

    setWaitingMode(true);
    setStatus(`已进入房间 ${roomCode}，等待房主开局。`);
    renderWaitingRoom();

    await subscribeWaitingRoom();
    await reattachPresenceForSeat();
}

async function handleCreateRoomBattle() {
    const nickname = getNickname();
    if (!nickname) {
        setStatus('请输入昵称后再创建房间。', true);
        return;
    }

    setFormBusy(true);
    setStatus('创建实战房间中...');
    try {
        const nextSession = await createRoom(nickname);
        setStatus(`实战房间创建成功：${nextSession.roomCode}`);
        await enterWaitingRoom(nextSession);
    } catch (error) {
        setStatus(error.message || '创建房间失败。', true);
    } finally {
        setFormBusy(false);
    }
}

async function handleJoinRoomBattle() {
    const nickname = getNickname();
    const inputRoomCode = normalizeRoomCode(roomCodeInput.value);

    if (!nickname) {
        setStatus('请输入昵称后再加入房间。', true);
        return;
    }
    if (!inputRoomCode) {
        setStatus('请输入房间码。', true);
        return;
    }

    setFormBusy(true);
    setStatus(`加入实战房间 ${inputRoomCode} 中...`);
    try {
        const nextSession = await joinRoom(inputRoomCode, nickname);
        const roomStatus = String(nextSession?.roomStatus || 'waiting');
        const renamedHint = nextSession.nickname !== nickname ? `（昵称已调整为 ${nextSession.nickname}）` : '';

        if (roomStatus === 'playing') {
            if (nextSession.spectator) {
                setStatus(`牌局进行中，已作为观战进入实战页。${renamedHint}`);
            } else {
                setStatus(`已重新加入对局：${seatNameAbsolute(nextSession.seatId)}位${renamedHint}`);
            }
            gotoRoomPage({
                ...nextSession,
                roomCode: inputRoomCode,
                entryMode: 'battle'
            }, 'battle');
            return;
        }

        if (nextSession.spectator) {
            setStatus(`房间已满，已作为观战进入等待页。${renamedHint}`);
        } else {
            setStatus(`加入成功：${seatNameAbsolute(nextSession.seatId)}位${renamedHint}`);
        }
        await enterWaitingRoom(nextSession);
    } catch (error) {
        setStatus(error.message || '加入房间失败。', true);
    } finally {
        setFormBusy(false);
    }
}

async function handleCreateRoomDebug() {
    if (!ensureDebugEntryUnlocked()) return;

    const nickname = getNickname();
    if (!nickname) {
        setStatus('请输入昵称后再创建调试房间。', true);
        return;
    }

    setFormBusy(true);
    setStatus('创建调试房间中...');
    try {
        const nextSession = await createRoom(nickname);
        setStatus(`调试房间创建成功：${nextSession.roomCode}`);
        gotoRoomPage({ ...nextSession, entryMode: 'debug' }, 'debug');
    } catch (error) {
        setStatus(error.message || '创建调试房间失败。', true);
    } finally {
        setFormBusy(false);
    }
}

async function handleJoinRoomDebug() {
    if (!ensureDebugEntryUnlocked()) return;

    const nickname = getNickname();
    const inputRoomCode = normalizeRoomCode(roomCodeInput.value);
    if (!nickname) {
        setStatus('请输入昵称后再加入调试房间。', true);
        return;
    }
    if (!inputRoomCode) {
        setStatus('请输入房间码。', true);
        return;
    }

    setFormBusy(true);
    setStatus(`加入调试房间 ${inputRoomCode} 中...`);
    try {
        const nextSession = await joinRoom(inputRoomCode, nickname);
        const renamedHint = nextSession.nickname !== nickname ? `（昵称已调整为 ${nextSession.nickname}）` : '';
        if (nextSession.spectator) {
            setStatus(`房间已满，已作为观战进入调试页。${renamedHint}`);
        } else {
            setStatus(`加入成功：${seatNameAbsolute(nextSession.seatId)}位${renamedHint}`);
        }
        gotoRoomPage({ ...nextSession, entryMode: 'debug' }, 'debug');
    } catch (error) {
        setStatus(error.message || '加入调试房间失败。', true);
    } finally {
        setFormBusy(false);
    }
}

async function handleStartBattleGame() {
    if (!roomState || !session) return;
    if (!isHost()) {
        setStatus('请由房主开启游戏。', true);
        showActionToast('请由房主开启游戏。', { isError: true });
        return;
    }

    setBattleButtonsBusy(true);
    setStatus('开始对局中...');
    try {
        await startRoomGame(roomCode, session.uid);
        setStatus('已开始对局，正在进入实战页面...');
    } catch (error) {
        setStatus(error.message || '开始对局失败。', true);
    } finally {
        setBattleButtonsBusy(false);
        syncBattleStartButtonState();
    }
}

async function handleLeaveBattleRoom() {
    if (!session || !roomCode) {
        await cleanupWaitingRoom({ clearStored: true });
        setStatus('已返回大厅。');
        return;
    }

    setBattleButtonsBusy(true);
    setStatus('离开房间中...');
    try {
        await leaveRoom(roomCode, session.uid, session.seatId ?? null);
    } catch {
        // 忽略离开失败，继续本地清理
    }

    await cleanupWaitingRoom({ clearStored: true });
    setStatus('已离开房间。');
}

async function handleCopyBattleRoomCode() {
    if (!roomCode) {
        setStatus('房间码为空，暂不可复制。', true);
        return;
    }

    try {
        await navigator.clipboard.writeText(roomCode);
        setStatus(`已复制房间码：${roomCode}`);
        showActionToast('复制成功');
    } catch {
        setStatus('复制失败，请检查浏览器剪贴板权限。', true);
        showActionToast('复制失败，请检查剪贴板权限', { isError: true });
    }
}

async function handleStandUpClick() {
    if (!session || !roomState || seatSwitchBusy) return;

    const status = roomState?.meta?.status || 'waiting';
    const currentSeatId = getCurrentSeatId();
    if (status !== 'waiting' || currentSeatId === null) return;

    seatSwitchBusy = true;
    pendingSeatSwitch = {
        fromSeatId: currentSeatId,
        toSeatId: null
    };
    syncBattleStandUpButtonState();
    renderBattleSeatBoard();
    setStatus('站起中...');

    try {
        const result = await switchSeat(roomCode, session.uid, session.nickname, null, currentSeatId);
        session = {
            ...session,
            seatId: result?.seatId ?? null,
            entryMode: 'battle_waiting'
        };
        saveSession(session);
        await rebindPresence(roomCode, session.uid, session.seatId, session.nickname);
        setStatus('已站起，当前为观战状态。');
    } catch (error) {
        pendingSeatSwitch = null;
        setStatus(error.message || '站起失败。', true);
    } finally {
        seatSwitchBusy = false;
        renderWaitingRoom();
    }
}

async function handleSeatBoardClick(event) {
    if (!session || !roomState || seatSwitchBusy) return;

    const status = roomState?.meta?.status || 'waiting';
    if (status !== 'waiting') return;

    const btn = event.target.closest('[data-seat-id]');
    if (!btn) return;

    const targetSeatId = String(btn.dataset.seatId || '');
    const currentSeatId = getCurrentSeatId();
    if (!targetSeatId || targetSeatId === currentSeatId) return;

    const seat = roomState?.seats?.[targetSeatId] || null;
    if (seat && !seat.isBot && seat.reservedUid !== session.uid) {
        setStatus('座位已被占用，请选择其他座位。', true);
        return;
    }

    seatSwitchBusy = true;
    pendingSeatSwitch = {
        fromSeatId: currentSeatId,
        toSeatId: targetSeatId
    };
    syncBattleStandUpButtonState();
    renderBattleSeatBoard();
    setStatus(`切换到${seatNameAbsolute(targetSeatId)}位中...`);

    try {
        const result = await switchSeat(roomCode, session.uid, session.nickname, targetSeatId, currentSeatId);
        session = {
            ...session,
            seatId: result.seatId,
            entryMode: 'battle_waiting'
        };
        saveSession(session);
        await rebindPresence(roomCode, session.uid, session.seatId, session.nickname);
        setStatus(`已切换到${seatNameAbsolute(result.seatId)}位。`);
    } catch (error) {
        pendingSeatSwitch = null;
        setStatus(error.message || '切换座位失败。', true);
    } finally {
        seatSwitchBusy = false;
        renderWaitingRoom();
    }
}
function bindEvents() {
    createRoomBtn?.addEventListener('click', handleCreateRoomBattle);
    joinRoomBtn?.addEventListener('click', handleJoinRoomBattle);
    createRoomDebugBtn?.addEventListener('click', handleCreateRoomDebug);
    joinRoomDebugBtn?.addEventListener('click', handleJoinRoomDebug);

    battleStartBtn?.addEventListener('click', handleStartBattleGame);
    battleStandUpBtn?.addEventListener('click', handleStandUpClick);
    battleCopyRoomBtn?.addEventListener('click', handleCopyBattleRoomCode);
    battleLeaveBtn?.addEventListener('click', handleLeaveBattleRoom);
    battleSeatBoardEl?.addEventListener('click', handleSeatBoardClick);

    roomCodeInput?.addEventListener('input', () => {
        roomCodeInput.value = normalizeRoomCode(roomCodeInput.value).replace(/[^A-Z0-9]/g, '').slice(0, 6);
    });
}

async function tryRestoreWaitingSession() {
    const cached = loadSession();
    if (!cached || !cached.roomCode) return false;

    if (cached.nickname && !nicknameInput.value) {
        nicknameInput.value = String(cached.nickname);
    }

    if (cached.entryMode !== 'battle_waiting') {
        return false;
    }

    try {
        const authUser = await ensureAnonymousAuth();
        if (cached.uid && authUser.uid !== cached.uid) {
            clearSession();
            return false;
        }

        const restored = {
            ...cached,
            uid: authUser.uid,
            roomCode: normalizeRoomCode(cached.roomCode)
        };

        await enterWaitingRoom(restored);
        setStatus(`已恢复房间 ${restored.roomCode} 等待页。`);
        return true;
    } catch {
        clearSession();
        return false;
    }
}

async function bootstrap() {
    setWaitingMode(false);
    applyDebugEntryVisibility();
    registerDebugUnlockToken();

    if (!hasFirebaseConfig()) {
        const { missingKeys } = getFirebaseConfigStatus();
        setStatus(`请先填写 src/firebase-config.js，当前缺少：${missingKeys.join(', ')}。`, true);
        setFormBusy(true);
        return;
    }

    bindEvents();
    disposeGuestbook = initLobbyGuestbook();

    const restored = await tryRestoreWaitingSession();
    if (!restored) {
        setStatus('准备就绪，输入昵称后可创建或加入房间。');
    }

    window.addEventListener('beforeunload', () => {
        if (detachPresence) {
            detachPresence();
        }
    });

    window.addEventListener('unload', () => {
        disposeRoomSubscription();
        if (typeof disposeGuestbook === 'function') {
            disposeGuestbook();
            disposeGuestbook = null;
        }
        if (typeof disposeScreenGuard === 'function') {
            disposeScreenGuard();
        }
    });
}

bootstrap().catch((error) => {
    setStatus(error.message || '大厅初始化失败。', true);
});

