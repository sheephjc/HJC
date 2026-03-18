import {
    createOnlineGameState,
    applyOnlineGameAction,
    runBotTurns,
    syncSeatControlsToGameState
} from './online-game-engine.js';

export const SEAT_IDS = ['0', '1', '2', '3'];
const BOT_MAX_STEPS_PER_TICK = 1;
const MAX_PROCESSED_ACTION_CLEANUP_PER_TICK = 120;
const DEALER_ONLY_ACTION_TYPES = new Set(['ROUND_START', 'OPEN_GOLD']);

function normalizeForcedHostGoldCount(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 3) return null;
    return n;
}

function findSeatIdByUid(seats = {}, uid = null) {
    if (!uid) return null;
    for (const seatId of SEAT_IDS) {
        const seat = seats?.[seatId];
        if (!seat || seat.isBot) continue;
        if (String(seat.uid || '') === String(uid)) return Number(seatId);
    }
    return null;
}

export function buildHumanSeat(seatId, uid, nickname, online = true, now = Date.now()) {
    return {
        seatId,
        uid,
        reservedUid: uid,
        nickname,
        isBot: false,
        online,
        control: online ? 'human' : 'bot',
        lastSeen: now
    };
}

export function buildBotSeat(seatId, now = Date.now()) {
    return {
        seatId,
        uid: `bot-${seatId}`,
        reservedUid: null,
        nickname: `AI-${Number(seatId) + 1}`,
        isBot: true,
        online: true,
        control: 'bot',
        lastSeen: now
    };
}

export function getOnlineHumanHostUid(seats = {}) {
    for (const seatId of SEAT_IDS) {
        const seat = seats?.[seatId];
        if (!seat || seat.isBot) continue;
        if (seat.online) return seat.uid;
    }
    return null;
}

export function normalizeSeatsForStart(seats = {}, now = Date.now()) {
    const nextSeats = { ...seats };
    for (const seatId of SEAT_IDS) {
        const seat = nextSeats[seatId];
        if (!seat) {
            nextSeats[seatId] = buildBotSeat(seatId, now);
            continue;
        }
        if (!seat.isBot && !seat.online) {
            nextSeats[seatId] = {
                ...seat,
                control: 'bot',
                lastSeen: now
            };
        }
    }
    return nextSeats;
}

export function syncHumanSeatControls(seats = {}, presence = {}, now = Date.now()) {
    const nextSeats = { ...seats };
    let changed = false;

    for (const seatId of SEAT_IDS) {
        const seat = nextSeats[seatId];
        if (!seat || seat.isBot) continue;

        const isOnline = !!presence?.[seat.uid]?.online;
        const expectedControl = isOnline ? 'human' : 'bot';

        if (seat.online !== isOnline || seat.control !== expectedControl) {
            nextSeats[seatId] = {
                ...seat,
                online: isOnline,
                control: expectedControl,
                lastSeen: now
            };
            changed = true;
        }
    }

    return { seats: nextSeats, changed };
}

export function createStartedGameState(seats = {}, now = Date.now(), roundNo = 1, options = {}) {
    const baseState = options?.baseState && typeof options.baseState === 'object'
        ? options.baseState
        : null;
    const forcedHostGoldCount = normalizeForcedHostGoldCount(options?.forcedHostGoldCount);
    const hostUid = typeof options?.hostUid === 'string' && options.hostUid
        ? options.hostUid
        : null;
    const hostSeatId = Number.isInteger(options?.hostSeatId)
        ? options.hostSeatId
        : findSeatIdByUid(seats, hostUid);
    const initialDealerSeat = Number.isInteger(baseState?.dealerSeat)
        ? baseState.dealerSeat
        : (Number.isInteger(hostSeatId) ? hostSeatId : 0);

    const initial = createOnlineGameState({
        seats,
        now,
        roundNo,
        dealerSeat: initialDealerSeat,
        dealerStreak: Number.isInteger(baseState?.dealerStreak) ? baseState.dealerStreak : 0,
        scores: Array.isArray(baseState?.scores) ? baseState.scores : [0, 0, 0, 0],
        hostUid,
        hostSeatId,
        forcedHostGoldCount
    });
    const botResult = runBotTurns(initial, seats, now, BOT_MAX_STEPS_PER_TICK);
    return botResult.state;
}

function stableStringify(value) {
    return JSON.stringify(value || {});
}

export function defaultStateReducer(gameState, actionIntent, now = Date.now(), context = {}) {
    const seats = context.seats || {};
    const hostUid = typeof context.hostUid === 'string' && context.hostUid
        ? context.hostUid
        : null;
    const actorUid = typeof context.actorUid === 'string' && context.actorUid
        ? context.actorUid
        : null;
    let state = syncSeatControlsToGameState(gameState, seats, now);

    if (DEALER_ONLY_ACTION_TYPES.has(String(actionIntent?.type || '').toUpperCase())) {
        const actorSeatId = findSeatIdByUid(seats, actorUid);
        if (!Number.isInteger(actorSeatId) || actorSeatId !== Number(state?.dealerSeat)) {
            return state;
        }
    }

    let normalizedAction = actionIntent;
    if (actionIntent?.type === 'ROUND_START') {
        const forcedHostGoldCount = normalizeForcedHostGoldCount(actionIntent?.payload?.forcedHostGoldCount);
        const payload = {
            ...(actionIntent?.payload || {})
        };
        if (forcedHostGoldCount !== null) {
            payload.forcedHostGoldCount = forcedHostGoldCount;
        }
        if (hostUid) {
            payload.hostUid = hostUid;
            const hostSeatId = findSeatIdByUid(seats, hostUid);
            if (Number.isInteger(hostSeatId)) {
                payload.hostSeatId = hostSeatId;
            }
        }
        normalizedAction = {
            ...(actionIntent || {}),
            payload
        };
    }
    state = applyOnlineGameAction(state, normalizedAction, now);
    return state;
}

export function processPendingActionMap(
    actionMap = {},
    hostUid,
    gameState,
    gameVersion,
    seats = {},
    reducer = defaultStateReducer,
    now = Date.now()
) {
    const normalizedActionMap = (actionMap && typeof actionMap === 'object') ? actionMap : {};
    const actionEntries = Object.entries(normalizedActionMap)
        .filter(([actionId, actionEntry]) => !!actionId && actionEntry && typeof actionEntry === 'object');
    const pendingIds = actionEntries
        .filter(([, entry]) => entry.status === 'pending')
        .map(([id]) => id)
        .sort((a, b) => (normalizedActionMap[a]?.createdAt || 0) - (normalizedActionMap[b]?.createdAt || 0));
    const staleProcessedIds = actionEntries
        .filter(([, entry]) => entry.status !== 'pending')
        .map(([id]) => id)
        .sort((a, b) => (normalizedActionMap[a]?.processedAt || normalizedActionMap[a]?.createdAt || 0)
            - (normalizedActionMap[b]?.processedAt || normalizedActionMap[b]?.createdAt || 0));
    const cleanupIds = staleProcessedIds.slice(0, MAX_PROCESSED_ACTION_CLEANUP_PER_TICK);
    const actionPatch = {};
    const removedActionIds = [];

    for (const actionId of cleanupIds) {
        actionPatch[actionId] = null;
        removedActionIds.push(actionId);
    }

    const beforeControls = stableStringify(gameState?.seatControls);

    let nextState = gameState
        ? syncSeatControlsToGameState(gameState, seats, now)
        : createStartedGameState(seats, now, 1, { hostUid });
    let nextVersion = gameVersion || 0;
    let appliedIntentCount = 0;

    for (const actionId of pendingIds) {
        const intent = normalizedActionMap[actionId];
        if (intent?.action && typeof intent.action === 'object') {
            nextState = reducer(nextState, intent.action, now, { seats, hostUid, actorUid: intent.uid || null });
            nextVersion += 1;
            appliedIntentCount += 1;
        }
        actionPatch[actionId] = null;
        removedActionIds.push(actionId);
    }

    const botResult = runBotTurns(nextState, seats, now, BOT_MAX_STEPS_PER_TICK);
    nextState = botResult.state;
    nextVersion += botResult.appliedSteps;

    const afterControls = stableStringify(nextState?.seatControls);
    const controlChanged = beforeControls !== afterControls;
    if (controlChanged) nextVersion += 1;

    const processedCount = appliedIntentCount + botResult.appliedSteps + (controlChanged ? 1 : 0);
    const gameChanged = processedCount > 0;
    const actionChanged = removedActionIds.length > 0;

    if (!gameChanged && !actionChanged) {
        return {
            actionPatch: {},
            removedActionIds: [],
            gameState,
            gameVersion,
            processedCount: 0,
            hadPendingActions: false,
            removedActionCount: 0,
            changed: false
        };
    }

    return {
        actionPatch,
        removedActionIds,
        gameState: gameChanged ? nextState : gameState,
        gameVersion: gameChanged ? nextVersion : gameVersion,
        processedCount,
        hadPendingActions: pendingIds.length > 0,
        removedActionCount: removedActionIds.length,
        changed: true
    };
}
