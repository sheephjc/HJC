import { ensureAnonymousAuth, getFirebaseServices } from './firebase-client.js';
import {
    SEAT_IDS,
    buildHumanSeat,
    buildBotSeat,
    getOnlineHumanHostUid,
    createStartedGameState,
    normalizeSeatsForStart,
    syncHumanSeatControls,
    processPendingActionMap,
    defaultStateReducer
} from './room-reducer.js';

const ROOM_CODE_LEN = 6;
const INVALID_PATH_SEGMENT_RE = /[.#$\[\]\/\u0000-\u001F\u007F]/;
const HOST_TICK_IDLE_HINT_MS = 700;
const HOST_TICK_ACTIVE_HINT_MS = 100;

let cachedBindings = null;
let cachedBindingsIdentity = null;

function toSafeString(value) {
    if (value === null || value === undefined) return '';
    return String(value);
}

function normalizePathSegment(segment, label = 'path segment') {
    const value = toSafeString(segment).trim();
    if (!value) {
        throw new Error(`${label} 不能为空。`);
    }
    if (value.includes('[object Object]')) {
        throw new Error(`${label} 包含序列化对象。`);
    }
    if (INVALID_PATH_SEGMENT_RE.test(value)) {
        throw new Error(`${label} 含非法字符：${value}`);
    }
    return value;
}

function validateFirebasePath(path) {
    if (typeof path !== 'string') {
        throw new TypeError(`Firebase路径必须是字符串，收到 ${typeof path}: ${String(path)}`);
    }
    if (path.length === 0) {
        throw new Error('Firebase路径不能为空');
    }
    if (path.includes('[object Object]')) {
        throw new Error('Firebase路径包含序列化对象');
    }
    return true;
}

function joinFirebasePath(...segments) {
    const normalized = segments.map((segment, idx) => normalizePathSegment(segment, `path segment[${idx}]`));
    const path = normalized.join('/');
    validateFirebasePath(path);
    return path;
}

function buildRoomPath(roomCodeInput, ...segments) {
    const roomCode = normalizePathSegment(normalizeRoomCode(roomCodeInput), 'roomCode');
    return joinFirebasePath('rooms', roomCode, ...segments);
}

function buildRoomSubPath(...segments) {
    return joinFirebasePath(...segments);
}

function buildRoomRef(bindings, roomCodeInput, ...segments) {
    const path = buildRoomPath(roomCodeInput, ...segments);
    return {
        path,
        ref: bindings.ref(bindings.db, path)
    };
}

function buildFirebaseContext(bindings, path = '', roomCode = '') {
    const context = {};
    if (path) context.path = path;
    if (roomCode) context.roomCode = roomCode;
    if (bindings?.appName) context.appName = bindings.appName;
    if (bindings?.sourceName) context.sourceName = bindings.sourceName;
    return context;
}

function getDatabaseBindings() {
    const services = getFirebaseServices();
    const dbApi = services?.rtdb || {};
    const requiredFns = ['ref', 'get', 'onValue', 'push', 'runTransaction', 'set', 'update', 'onDisconnect'];
    for (const name of requiredFns) {
        if (typeof dbApi[name] !== 'function') {
            throw new Error(`Firebase SDK 未就绪：缺少 ${name}()`);
        }
    }

    if (cachedBindings) {
        const driftDetected = (
            cachedBindingsIdentity?.db !== services.db
            || cachedBindingsIdentity?.rtdb !== dbApi
        );
        if (driftDetected) {
            throw new Error('检测到 Firebase 运行时实例漂移，已阻断写入。请刷新页面后重试。');
        }
        return cachedBindings;
    }

    const bindings = Object.freeze({
        db: services.db,
        ref: dbApi.ref,
        get: dbApi.get,
        onValue: dbApi.onValue,
        push: dbApi.push,
        runTransaction: dbApi.runTransaction,
        set: dbApi.set,
        update: dbApi.update,
        onDisconnect: dbApi.onDisconnect,
        sourceName: services?.sourceName || dbApi.loadedFrom || 'unknown',
        appName: services?.appName || services?.app?.name || 'unknown'
    });
    cachedBindings = bindings;
    cachedBindingsIdentity = {
        db: services.db,
        rtdb: dbApi
    };
    return bindings;
}

function normalizeUid(uidInput, fieldName = 'uid') {
    const uid = toSafeString(uidInput).trim();
    if (!uid) {
        throw new Error(`${fieldName} 不能为空。`);
    }
    return uid;
}

function normalizeOptionalSeatId(seatIdInput) {
    if (seatIdInput === null || seatIdInput === undefined) return null;
    const seatId = String(seatIdInput).trim();
    if (!isValidSeatId(seatId)) {
        throw new Error(`座位无效：${seatId}`);
    }
    return seatId;
}

function buildUpdateMap(operationName, entries) {
    const updates = {};
    for (const [rawPath, value] of entries) {
        const segments = toSafeString(rawPath)
            .split('/')
            .map((segment) => segment.trim())
            .filter((segment) => segment.length > 0);
        const path = buildRoomSubPath(...segments);
        updates[path] = value;
    }
    return updates;
}

function appendPatchEntry(patch, rawPath, value) {
    const segments = toSafeString(rawPath)
        .split('/')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
    const path = buildRoomSubPath(...segments);
    patch[path] = value;
}

function nowTs() {
    return Date.now();
}

function isValidSeatId(seatId) {
    return SEAT_IDS.includes(String(seatId));
}

function normalizeNickname(nickname) {
    const cleaned = toSafeString(nickname).trim().replace(/\s+/g, ' ');
    return cleaned.slice(0, 16) || '游客';
}

function normalizeRoomCode(code) {
    return toSafeString(code).trim().toUpperCase();
}

function normalizeForcedHostGoldCount(value) {
    const n = Number(value);
    if (!Number.isInteger(n)) return null;
    if (n < 1 || n > 3) return null;
    return n;
}

function isHumanHostOnline(room = {}) {
    const hostUid = room?.meta?.hostUid || null;
    if (!hostUid) return false;

    for (const seatId of SEAT_IDS) {
        const seat = room?.seats?.[seatId];
        if (!seat || seat.isBot) continue;
        if (seat.uid === hostUid && seat.online) return true;
    }

    return !!room?.presence?.[hostUid]?.online;
}

function randomRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i += 1) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function formatFirebaseErrorContext(context = {}) {
    const parts = [];
    if (context.path) parts.push(`path=${context.path}`);
    if (context.roomCode) parts.push(`room=${context.roomCode}`);
    if (context.appName) parts.push(`app=${context.appName}`);
    if (context.sourceName) parts.push(`source=${context.sourceName}`);
    return parts.length ? `（${parts.join(', ')}）` : '';
}

function normalizeFirebaseDbError(error, fallback = '数据库操作失败', operationName = '', context = {}) {
    const code = String(error?.code || '').toLowerCase();
    const rawMessage = String(error?.message || '');
    const message = rawMessage.toLowerCase();
    const scope = operationName ? `${fallback}（${operationName}）` : fallback;
    const contextSuffix = formatFirebaseErrorContext(context);
    const permissionDenied = code.includes('permission_denied') || message.includes('permission_denied');
    if (permissionDenied) {
        return new Error(
            `${scope}：权限被拒绝（permission_denied）。请确认已发布最新 firebase-rules.json，并已启用 Anonymous Authentication。${contextSuffix}`
        );
    }
    if (error instanceof TypeError && message.includes('split is not a function')) {
        return new Error(`${scope}：Firebase 路径参数异常（split is not a function）。${contextSuffix}`);
    }
    if (error instanceof RangeError && message.includes('maximum call stack size exceeded')) {
        return new Error(`${scope}：检测到 Firebase 递归比较异常（Maximum call stack size exceeded）。${contextSuffix}`);
    }
    if (error instanceof Error) {
        return new Error(`${scope}：${rawMessage || error.name}${contextSuffix}`);
    }
    return new Error(`${scope}${contextSuffix}`);
}

function isPermissionDeniedError(error) {
    const code = String(error?.code || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();
    return code.includes('permission_denied') || message.includes('permission_denied');
}

async function isCurrentHost(roomCodeInput, uidInput, bindings = null) {
    await ensureAnonymousAuth();
    const roomCode = normalizeRoomCode(roomCodeInput);
    const uid = toSafeString(uidInput).trim();
    if (!uid) return false;
    const activeBindings = bindings || getDatabaseBindings();
    const { get } = activeBindings;
    const { path: metaPath, ref: metaRef } = buildRoomRef(activeBindings, roomCode, 'meta');
    try {
        const metaSnap = await get(metaRef);
        if (!metaSnap.exists()) return false;
        return String(metaSnap.val()?.hostUid || '') === uid;
    } catch (error) {
        throw normalizeFirebaseDbError(
            error,
            '校验房主失败',
            'isCurrentHost',
            buildFirebaseContext(activeBindings, metaPath, roomCode)
        );
    }
}

export async function createRoom(nicknameInput) {
    const user = await ensureAnonymousAuth();
    const nickname = normalizeNickname(nicknameInput);
    const uid = normalizeUid(user?.uid, 'uid');
    const bindings = getDatabaseBindings();
    const { get, set } = bindings;

    for (let i = 0; i < 12; i += 1) {
        const roomCode = randomRoomCode();
        const roomNode = buildRoomRef(bindings, roomCode);
        const roomRef = roomNode.ref;
        const roomPath = roomNode.path;
        const createdAt = nowTs();
        const initialRoom = {
            meta: {
                roomCode,
                status: 'waiting',
                hostUid: uid,
                version: 0,
                createdAt,
                updatedAt: createdAt
            },
            seats: {
                '0': buildHumanSeat('0', uid, nickname, true, createdAt)
            },
            game: {
                version: 0,
                state: null
            },
            actions: {},
            presence: {
                [uid]: {
                    online: true,
                    seatId: '0',
                    lastSeen: createdAt,
                    nickname
                }
            },
            memberUids: {
                [uid]: true
            }
        };

        try {
            const snap = await get(roomRef);
            if (snap.exists()) continue;
            await set(roomRef, initialRoom);
            return {
                roomCode,
                seatId: '0',
                uid,
                nickname,
                spectator: false
            };
        } catch (error) {
            if (isPermissionDeniedError(error)) {
                continue;
            }
            throw normalizeFirebaseDbError(
                error,
                '创建房间失败',
                'createRoom',
                buildFirebaseContext(bindings, roomPath, roomCode)
            );
        }
    }

    throw new Error('创建房间失败：房间码冲突过多，请重试。');
}

export async function joinRoom(roomCodeInput, nicknameInput) {
    const roomCode = normalizeRoomCode(roomCodeInput);
    if (roomCode.length !== ROOM_CODE_LEN) {
        throw new Error('房间码必须为 6 位。');
    }

    const user = await ensureAnonymousAuth();
    const uid = normalizeUid(user?.uid, 'uid');
    const nickname = normalizeNickname(nicknameInput);
    const bindings = getDatabaseBindings();
    const { get, runTransaction, update, set } = bindings;
    const roomNode = buildRoomRef(bindings, roomCode);
    const roomRef = roomNode.ref;
    const roomPath = roomNode.path;

    let room = null;
    try {
        const snap = await get(roomRef);
        room = snap.exists() ? snap.val() : null;
    } catch (error) {
        throw normalizeFirebaseDbError(
            error,
            '加入房间失败',
            'joinRoom.readRoom',
            buildFirebaseContext(bindings, roomPath, roomCode)
        );
    }

    if (!room) {
        throw new Error('房间不存在。');
    }

    const seats = room.seats || {};
    const status = room.meta?.status || 'waiting';
    const now = nowTs();
    let assignedSeatId = null;

    for (const seatId of SEAT_IDS) {
        const seat = seats[seatId];
        if (!seat) continue;
        if (!seat.isBot && seat.reservedUid === uid) {
            assignedSeatId = seatId;
            break;
        }
    }

    if (assignedSeatId === null && status === 'waiting') {
        for (const seatId of SEAT_IDS) {
            const seatPreview = seats[seatId];
            if (seatPreview && !seatPreview.isBot) continue;
            const seatNode = buildRoomRef(bindings, roomCode, 'seats', seatId);
            const seatRef = seatNode.ref;
            try {
                const tx = await runTransaction(seatRef, (seat) => {
                    if (seat && !seat.isBot) return seat;
                    return buildHumanSeat(seatId, uid, nickname, true, now);
                }, { applyLocally: false });

                const claimedSeat = tx.snapshot?.val();
                if (tx.committed && claimedSeat && claimedSeat.reservedUid === uid && !claimedSeat.isBot) {
                    assignedSeatId = seatId;
                    break;
                }
            } catch (error) {
                const code = String(error?.code || '').toLowerCase();
                const message = String(error?.message || '').toLowerCase();
                if (code.includes('permission_denied') || message.includes('permission_denied')) {
                    continue;
                }
                throw normalizeFirebaseDbError(
                    error,
                    '加入房间失败',
                    'joinRoom.claimSeat',
                    buildFirebaseContext(bindings, seatNode.path, roomCode)
                );
            }
        }
    }

    try {
        if (assignedSeatId !== null) {
            const seatNode = buildRoomRef(bindings, roomCode, 'seats', assignedSeatId);
            const seatRef = seatNode.ref;
            const seatSnap = await get(seatRef);
            const currentSeat = seatSnap.exists() ? seatSnap.val() : null;

            if (currentSeat && currentSeat.reservedUid === uid && !currentSeat.isBot) {
                await update(seatRef, {
                    nickname,
                    online: true,
                    control: 'human',
                    lastSeen: now
                });
            } else if (!currentSeat) {
                await set(seatRef, buildHumanSeat(assignedSeatId, uid, nickname, true, now));
            }
        }

        if (room.memberUids?.[uid] !== true) {
            await set(buildRoomRef(bindings, roomCode, 'memberUids', uid).ref, true);
        }

        await set(buildRoomRef(bindings, roomCode, 'presence', uid).ref, {
            online: true,
            seatId: String(assignedSeatId),
            lastSeen: now,
            nickname
        });
    } catch (error) {
        throw normalizeFirebaseDbError(
            error,
            '加入房间失败',
            'joinRoom.writePresence',
            buildFirebaseContext(bindings, roomPath, roomCode)
        );
    }

    return {
        roomCode,
        seatId: assignedSeatId,
        uid,
        nickname,
        spectator: assignedSeatId === null
    };
}

export async function switchSeat(roomCodeInput, uid, nicknameInput, targetSeatIdInput, currentSeatIdInput = null, runtimeOptions = {}) {
    const roomCode = normalizeRoomCode(roomCodeInput);
    const sessionUid = normalizeUid(uid, 'uid');
    const nickname = normalizeNickname(nicknameInput);
    const targetSeatId = normalizeOptionalSeatId(targetSeatIdInput);
    const currentSeatId = normalizeOptionalSeatId(currentSeatIdInput);

    if (targetSeatId === null) throw new Error('目标座位无效。');

    const user = runtimeOptions?.skipEnsureAuth === true
        ? { uid: sessionUid }
        : await ensureAnonymousAuth();
    if (String(user?.uid || '') !== sessionUid) {
        throw new Error('当前登录身份与会话不一致，请重新加入房间。');
    }
    const bindings = runtimeOptions?.bindings || getDatabaseBindings();
    const { get, runTransaction, update } = bindings;
    const roomNode = buildRoomRef(bindings, roomCode);
    const roomRef = roomNode.ref;
    const roomPath = roomNode.path;

    let room = null;
    try {
        const snap = await get(roomRef);
        room = snap.exists() ? snap.val() : null;
    } catch (error) {
        throw normalizeFirebaseDbError(
            error,
            '切换座位失败',
            'switchSeat.readRoom',
            buildFirebaseContext(bindings, roomPath, roomCode)
        );
    }

    if (!room) throw new Error('房间不存在。');
    if ((room?.meta?.status || 'waiting') !== 'waiting') {
        throw new Error('仅 waiting 状态可换座。');
    }
    if (room?.memberUids?.[sessionUid] !== true) {
        throw new Error('你不在该房间成员列表中。');
    }

    const seats = room?.seats || {};
    const now = nowTs();
    let sourceSeatId = null;

    if (currentSeatId !== null) {
        const sourceSeat = seats[currentSeatId];
        if (sourceSeat && !sourceSeat.isBot && sourceSeat.reservedUid === sessionUid) {
            sourceSeatId = currentSeatId;
        }
    }

    if (sourceSeatId === null) {
        for (const seatId of SEAT_IDS) {
            const seat = seats[seatId];
            if (!seat || seat.isBot) continue;
            if (seat.reservedUid === sessionUid) {
                sourceSeatId = seatId;
                break;
            }
        }
    }

    if (sourceSeatId !== null && sourceSeatId === targetSeatId) {
        try {
            const patch = {};
            appendPatchEntry(patch, `presence/${sessionUid}`, {
                online: true,
                seatId: String(targetSeatId),
                nickname,
                lastSeen: now
            });
            appendPatchEntry(patch, `memberUids/${sessionUid}`, true);
            appendPatchEntry(patch, `seats/${targetSeatId}/online`, true);
            appendPatchEntry(patch, `seats/${targetSeatId}/control`, 'human');
            appendPatchEntry(patch, `seats/${targetSeatId}/nickname`, nickname);
            appendPatchEntry(patch, `seats/${targetSeatId}/lastSeen`, now);
            appendPatchEntry(patch, 'meta/updatedAt', now);
            await update(roomRef, patch);
        } catch (error) {
            throw normalizeFirebaseDbError(
                error,
                '切换座位失败',
                'switchSeat.refreshSameSeat',
                buildFirebaseContext(bindings, roomPath, roomCode)
            );
        }
        return { seatId: targetSeatId };
    }

    const targetSeatNode = buildRoomRef(bindings, roomCode, 'seats', targetSeatId);
    const targetSeatRef = targetSeatNode.ref;
    try {
        const tx = await runTransaction(targetSeatRef, (seat) => {
            if (seat && !seat.isBot && seat.reservedUid !== sessionUid) return seat;
            return buildHumanSeat(targetSeatId, sessionUid, nickname, true, now);
        }, { applyLocally: false });

        const claimedSeat = tx.snapshot?.val();
        const targetClaimedBySelf = !!(
            tx.committed
            && claimedSeat
            && !claimedSeat.isBot
            && claimedSeat.reservedUid === sessionUid
            && claimedSeat.uid === sessionUid
        );
        if (!targetClaimedBySelf) {
            throw new Error('座位已被占用，请选择其他座位。');
        }
    } catch (error) {
        if (String(error?.message || '').includes('座位已被占用')) {
            throw error;
        }
        throw normalizeFirebaseDbError(
            error,
            '切换座位失败',
            'switchSeat.claimTarget',
            buildFirebaseContext(bindings, targetSeatNode.path, roomCode)
        );
    }

    const releaseSeatIds = SEAT_IDS.filter((seatId) => {
        if (String(seatId) === String(targetSeatId)) return false;
        const seat = seats?.[seatId];
        return !!(seat && !seat.isBot && seat.reservedUid === sessionUid && seat.uid === sessionUid);
    });
    if (sourceSeatId !== null && sourceSeatId !== targetSeatId && !releaseSeatIds.includes(sourceSeatId)) {
        releaseSeatIds.push(sourceSeatId);
    }

    try {
        const patch = {};
        appendPatchEntry(patch, `presence/${sessionUid}`, {
            online: true,
            seatId: String(targetSeatId),
            nickname,
            lastSeen: now
        });
        appendPatchEntry(patch, `memberUids/${sessionUid}`, true);
        appendPatchEntry(patch, `seats/${targetSeatId}/online`, true);
        appendPatchEntry(patch, `seats/${targetSeatId}/control`, 'human');
        appendPatchEntry(patch, `seats/${targetSeatId}/nickname`, nickname);
        appendPatchEntry(patch, `seats/${targetSeatId}/lastSeen`, now);
        for (const seatId of releaseSeatIds) {
            appendPatchEntry(patch, `seats/${seatId}`, buildBotSeat(seatId, now));
        }
        appendPatchEntry(patch, 'meta/updatedAt', now);
        await update(roomRef, patch);
    } catch (error) {
        throw normalizeFirebaseDbError(
            error,
            '切换座位失败',
            'switchSeat.writeRoom',
            buildFirebaseContext(bindings, roomPath, roomCode)
        );
    }

    return { seatId: targetSeatId };
}

export function subscribeRoom(roomCodeInput, callback) {
    const roomCode = normalizeRoomCode(roomCodeInput);
    const bindings = getDatabaseBindings();
    const { onValue } = bindings;
    const roomRef = buildRoomRef(bindings, roomCode).ref;
    return onValue(roomRef, (snapshot) => callback(snapshot.val()));
}

export async function attachPresence(roomCodeInput, uid, seatId = null, nickname = '') {
    await ensureAnonymousAuth();
    const roomCode = normalizeRoomCode(roomCodeInput);
    const sessionUid = normalizeUid(uid, 'uid');
    const normalizedSeatId = normalizeOptionalSeatId(seatId);
    const normalizedNickname = normalizeNickname(nickname);
    const bindings = getDatabaseBindings();
    const { set, update, onDisconnect } = bindings;
    const presenceNode = buildRoomRef(bindings, roomCode, 'presence', sessionUid);
    const presenceRef = presenceNode.ref;

    const payload = {
        online: true,
        nickname: normalizedNickname,
        lastSeen: nowTs()
    };
    if (normalizedSeatId !== null) {
        payload.seatId = String(normalizedSeatId);
    }

    try {
        await set(presenceRef, payload);
        const disconnectTask = onDisconnect(presenceRef);
        const disconnectPayload = {
            online: false,
            nickname: normalizedNickname,
            lastSeen: nowTs()
        };
        if (normalizedSeatId !== null) {
            disconnectPayload.seatId = String(normalizedSeatId);
        }
        await disconnectTask.set(disconnectPayload);

        if (normalizedSeatId !== null) {
            await update(buildRoomRef(bindings, roomCode, 'seats', normalizedSeatId).ref, {
                online: true,
                control: 'human',
                lastSeen: nowTs()
            });
        }
    } catch (error) {
        throw normalizeFirebaseDbError(
            error,
            '更新在线状态失败',
            'attachPresence',
            buildFirebaseContext(bindings, presenceNode.path, roomCode)
        );
    }

    return async () => {
        try {
            await set(presenceRef, {
                online: false,
                seatId: normalizedSeatId,
                nickname: normalizedNickname,
                lastSeen: nowTs()
            });
        } catch (error) {
            throw normalizeFirebaseDbError(
                error,
                '更新在线状态失败',
                'attachPresence.cleanup',
                buildFirebaseContext(bindings, presenceNode.path, roomCode)
            );
        }
    };
}

export async function rebindPresence(roomCodeInput, uid, seatId = null, nickname = '') {
    await ensureAnonymousAuth();
    const roomCode = normalizeRoomCode(roomCodeInput);
    const sessionUid = normalizeUid(uid, 'uid');
    const normalizedSeatId = normalizeOptionalSeatId(seatId);
    const normalizedNickname = normalizeNickname(nickname);
    const bindings = getDatabaseBindings();
    const { set, onDisconnect } = bindings;
    const presenceNode = buildRoomRef(bindings, roomCode, 'presence', sessionUid);
    const presenceRef = presenceNode.ref;

    const payload = {
        online: true,
        nickname: normalizedNickname,
        lastSeen: nowTs()
    };
    if (normalizedSeatId !== null) {
        payload.seatId = String(normalizedSeatId);
    }

    const disconnectPayload = {
        online: false,
        nickname: normalizedNickname,
        lastSeen: nowTs()
    };
    if (normalizedSeatId !== null) {
        disconnectPayload.seatId = String(normalizedSeatId);
    }

    try {
        await set(presenceRef, payload);
        const disconnectTask = onDisconnect(presenceRef);
        await disconnectTask.set(disconnectPayload);
    } catch (error) {
        throw normalizeFirebaseDbError(
            error,
            '更新在线状态失败',
            'rebindPresence',
            buildFirebaseContext(bindings, presenceNode.path, roomCode)
        );
    }
}

export async function startRoomGame(roomCodeInput, requesterUid, options = {}) {
    await ensureAnonymousAuth();
    const roomCode = normalizeRoomCode(roomCodeInput);
    const hostUid = normalizeUid(requesterUid, 'requesterUid');
    const bindings = getDatabaseBindings();
    const { get, update } = bindings;
    const roomNode = buildRoomRef(bindings, roomCode);
    const roomRef = roomNode.ref;
    const hostNow = await isCurrentHost(roomCode, hostUid, bindings);
    if (!hostNow) {
        throw new Error('只有当前房主可以开始对局。');
    }

    try {
        const roomSnap = await get(roomRef);
        if (!roomSnap.exists()) {
            throw new Error('房间不存在。');
        }

        const current = roomSnap.val();
        const currentHostUid = current?.meta?.hostUid || null;
        if (currentHostUid !== hostUid) {
            throw new Error('只有当前房主可以开始对局。');
        }

        const now = nowTs();
        const nextSeats = normalizeSeatsForStart(current?.seats || {}, now);
        const forcedHostGoldCount = normalizeForcedHostGoldCount(options?.forcedHostGoldCount);
        const forceNewRound = options?.forceNewRound === true || forcedHostGoldCount !== null;
        const currentGameState = current?.game?.state || null;
        const nextRoundNo = Number.isInteger(currentGameState?.roundNo)
            ? currentGameState.roundNo + 1
            : 1;
        const nextState = forceNewRound || !currentGameState
            ? createStartedGameState(nextSeats, now, nextRoundNo, {
                hostUid,
                forcedHostGoldCount,
                baseState: currentGameState
            })
            : currentGameState;

        const nextMeta = {
            ...(current?.meta || {}),
            status: 'playing',
            updatedAt: now,
            startedAt: current?.meta?.startedAt || now
        };
        const nextGame = {
            ...(current?.game || {}),
            version: current?.game?.version || 0,
            state: nextState
        };

        await update(roomRef, {
            seats: nextSeats,
            meta: nextMeta,
            game: nextGame
        });
    } catch (error) {
        if (isPermissionDeniedError(error)) {
            throw new Error('开始对局失败：当前房主身份已失效，请刷新页面后重试。');
        }
        throw normalizeFirebaseDbError(
            error,
            '开始对局失败',
            'startRoomGame',
            buildFirebaseContext(bindings, roomNode.path, roomCode)
        );
    }
}

export async function tryElectHost(roomCodeInput, requesterUid = null, roomSnapshot = null) {
    await ensureAnonymousAuth();
    const roomCode = normalizeRoomCode(roomCodeInput);
    const normalizedRequesterUid = requesterUid === null || requesterUid === undefined
        ? null
        : normalizeUid(requesterUid, 'requesterUid');
    const bindings = getDatabaseBindings();
    const { get, runTransaction } = bindings;
    const roomNode = buildRoomRef(bindings, roomCode);
    const roomRef = roomNode.ref;
    let room = roomSnapshot;

    if (!room) {
        const snap = await get(roomRef);
        room = snap.exists() ? snap.val() : null;
    }

    if (!room) return { attempted: false, committed: false, reason: 'room-not-found' };
    if (isHumanHostOnline(room)) return { attempted: false, committed: false, reason: 'host-online' };

    const currentHostUid = room?.meta?.hostUid || null;
    const nextHostUid = getOnlineHumanHostUid(room?.seats || {});
    if (!nextHostUid) return { attempted: false, committed: false, reason: 'no-online-human' };
    if (currentHostUid && currentHostUid === nextHostUid) {
        return { attempted: false, committed: false, reason: 'host-unchanged' };
    }
    if (normalizedRequesterUid && normalizedRequesterUid !== nextHostUid) {
        return { attempted: false, committed: false, reason: 'not-election-candidate' };
    }

    const metaNode = buildRoomRef(bindings, roomCode, 'meta');
    const metaRef = metaNode.ref;
    try {
        const tx = await runTransaction(metaRef, (meta) => {
            if (!meta) return meta;
            if ((meta.hostUid || null) !== (currentHostUid || null)) return meta;
            if ((meta.hostUid || null) === nextHostUid) return meta;
            return {
                ...meta,
                hostUid: nextHostUid,
                updatedAt: nowTs(),
                version: Number(meta.version || 0) + 1
            };
        }, { applyLocally: false });
        return { attempted: true, committed: !!tx.committed, reason: tx.committed ? 'elected' : 'not-committed' };
    } catch (error) {
        const code = String(error?.code || '').toLowerCase();
        const msg = String(error?.message || '').toLowerCase();
        if (code.includes('permission_denied') || msg.includes('permission_denied')) {
            return { attempted: true, committed: false, reason: 'permission-denied' };
        }
        throw normalizeFirebaseDbError(
            error,
            '房主迁移失败',
            'tryElectHost.transaction',
            buildFirebaseContext(bindings, metaNode.path, roomCode)
        );
    }
}

export async function runHostTick(roomCodeInput, hostUid, reducer = defaultStateReducer, options = {}) {
    if (options?.skipEnsureAuth !== true) {
        await ensureAnonymousAuth();
    }

    const roomCode = normalizeRoomCode(roomCodeInput);
    const normalizedHostUid = normalizeUid(hostUid, 'hostUid');
    const bindings = options?.bindings || getDatabaseBindings();
    const { get, update } = bindings;
    const roomNode = buildRoomRef(bindings, roomCode);
    const roomRef = roomNode.ref;
    const allowSeatSync = options?.syncSeats !== false;
    const allowProcessActions = options?.processActions !== false;

    try {
        const roomSnap = await get(roomRef);
        if (!roomSnap.exists()) {
            return {
                changed: false,
                reason: 'room-not-found',
                nextTickDelayMs: HOST_TICK_IDLE_HINT_MS
            };
        }

        const current = roomSnap.val() || {};
        if (current?.meta?.hostUid !== normalizedHostUid) {
            return {
                changed: false,
                reason: 'not-host',
                nextTickDelayMs: HOST_TICK_IDLE_HINT_MS
            };
        }

        const now = nowTs();
        const seatSync = allowSeatSync
            ? syncHumanSeatControls(current?.seats || {}, current?.presence || {}, now)
            : { seats: current?.seats || {}, changed: false };
        const seatsForReducer = seatSync.seats || (current?.seats || {});
        const processed = allowProcessActions
            ? processPendingActionMap(
                current?.actions || {},
                normalizedHostUid,
                current?.game?.state || null,
                current?.game?.version || 0,
                seatsForReducer,
                reducer,
                now
            )
            : {
                actionPatch: {},
                removedActionIds: [],
                gameState: current?.game?.state || null,
                gameVersion: current?.game?.version || 0,
                processedCount: 0,
                hadPendingActions: false,
                removedActionCount: 0,
                changed: false
            };

        const patch = {};
        if (seatSync.changed) {
            appendPatchEntry(patch, 'seats', seatsForReducer);
        }

        if (allowProcessActions && processed.actionPatch && typeof processed.actionPatch === 'object') {
            for (const [actionId, actionValue] of Object.entries(processed.actionPatch)) {
                appendPatchEntry(patch, `actions/${actionId}`, actionValue);
            }
        }

        if (allowProcessActions && processed.processedCount > 0) {
            appendPatchEntry(patch, 'game/state', processed.gameState);
            appendPatchEntry(patch, 'game/version', processed.gameVersion);
            appendPatchEntry(patch, 'meta/version', Number(current?.meta?.version || 0) + processed.processedCount);
        }

        if (seatSync.changed || processed.changed) {
            appendPatchEntry(patch, 'meta/updatedAt', now);
        }

        const hasPatch = Object.keys(patch).length > 0;
        if (!hasPatch) {
            return {
                changed: false,
                reason: 'noop',
                seatChanged: false,
                gameChanged: false,
                removedActionCount: 0,
                hadPendingActions: false,
                nextTickDelayMs: HOST_TICK_IDLE_HINT_MS
            };
        }

        await update(roomRef, patch);

        const shouldStayActive = (
            !!processed.hadPendingActions
            || processed.processedCount > 0
            || processed.removedActionCount > 0
        );

        return {
            changed: true,
            reason: 'patched',
            seatChanged: !!seatSync.changed,
            gameChanged: processed.processedCount > 0,
            removedActionCount: Number(processed.removedActionCount || 0),
            hadPendingActions: !!processed.hadPendingActions,
            nextTickDelayMs: shouldStayActive ? HOST_TICK_ACTIVE_HINT_MS : HOST_TICK_IDLE_HINT_MS
        };
    } catch (error) {
        if (isPermissionDeniedError(error)) {
            return {
                changed: false,
                reason: 'permission-denied',
                nextTickDelayMs: HOST_TICK_IDLE_HINT_MS
            };
        }
        throw normalizeFirebaseDbError(
            error,
            '处理房主主循环失败',
            'runHostTick',
            buildFirebaseContext(bindings, roomNode.path, roomCode)
        );
    }
}

export async function syncSeatControls(roomCodeInput, hostUid) {
    return runHostTick(roomCodeInput, hostUid, defaultStateReducer, {
        processActions: false
    });
}

export async function processPendingActions(roomCodeInput, hostUid, reducer = defaultStateReducer) {
    return runHostTick(roomCodeInput, hostUid, reducer, {
        syncSeats: false
    });
}

export async function submitActionIntent(roomCodeInput, uid, action) {
    await ensureAnonymousAuth();
    const roomCode = normalizeRoomCode(roomCodeInput);
    const actionUid = normalizeUid(uid, 'uid');
    const bindings = getDatabaseBindings();
    const { push, set } = bindings;
    const actionsNode = buildRoomRef(bindings, roomCode, 'actions');
    const actionsRef = actionsNode.ref;
    const actionRef = push(actionsRef);

    try {
        await set(actionRef, {
            uid: actionUid,
            action,
            status: 'pending',
            createdAt: nowTs()
        });
    } catch (error) {
        throw normalizeFirebaseDbError(
            error,
            '提交动作失败',
            'submitActionIntent',
            buildFirebaseContext(bindings, actionsNode.path, roomCode)
        );
    }
}

export async function leaveRoom(roomCodeInput, uid, seatId = null) {
    await ensureAnonymousAuth();
    const roomCode = normalizeRoomCode(roomCodeInput);
    const sessionUid = normalizeUid(uid, 'uid');
    const normalizedSeatId = normalizeOptionalSeatId(seatId);
    const bindings = getDatabaseBindings();
    const { update } = bindings;
    const roomNode = buildRoomRef(bindings, roomCode);
    const roomRef = roomNode.ref;
    const presenceValue = {
        online: false,
        lastSeen: nowTs()
    };
    if (normalizedSeatId !== null) {
        presenceValue.seatId = String(normalizedSeatId);
    }
    const updates = [
        [`presence/${sessionUid}`, presenceValue]
    ];

    if (normalizedSeatId !== null) {
        const seatIdStr = String(normalizedSeatId);
        updates.push([`seats/${seatIdStr}/online`, false]);
        updates.push([`seats/${seatIdStr}/control`, 'bot']);
        updates.push([`seats/${seatIdStr}/lastSeen`, nowTs()]);
    }

    try {
        await update(roomRef, buildUpdateMap('leaveRoom', updates));
    } catch (error) {
        throw normalizeFirebaseDbError(
            error,
            '离开房间失败',
            'leaveRoom',
            buildFirebaseContext(bindings, roomNode.path, roomCode)
        );
    }
}

export async function getRoomSnapshot(roomCodeInput) {
    await ensureAnonymousAuth();
    const roomCode = normalizeRoomCode(roomCodeInput);
    const bindings = getDatabaseBindings();
    const { get } = bindings;
    const roomNode = buildRoomRef(bindings, roomCode);
    try {
        const snap = await get(roomNode.ref);
        return snap.exists() ? snap.val() : null;
    } catch (error) {
        throw normalizeFirebaseDbError(
            error,
            '读取房间快照失败',
            'getRoomSnapshot',
            buildFirebaseContext(bindings, roomNode.path, roomCode)
        );
    }
}
