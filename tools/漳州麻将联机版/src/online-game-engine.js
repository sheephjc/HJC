import { evaluateHuInfo } from './shared/hu-rules.js';
const TILE_ORDER = Object.freeze({ W: 0, T: 1, S: 2, Z: 3, H: 4 });
const SEAT_IDS = Object.freeze(['0', '1', '2', '3']);
const CLAIM_TIMEOUT_MS = 5000;
const CLAIM_PRIORITY = Object.freeze({ HU: 0, PENG: 1, GANG: 1, CHI: 2 });
const BOT_ACTION_DELAY_FAST_MS = 280;
const BOT_ACTION_DELAY_NORMAL_MIN_MS = 450;
const BOT_ACTION_DELAY_NORMAL_MAX_MS = 600;
const BOT_CLAIM_DELAY_FAST_MS = 0;
const BOT_CLAIM_DELAY_NORMAL_MIN_MS = 250;
const BOT_CLAIM_DELAY_NORMAL_MAX_MS = 400;
const MAX_INSTANT_SCORE_LOG_SIZE = 400;
const WHITE_DRAGON_TILE = 'Z7';
const AI_SPEED_MODE = Object.freeze({
    NORMAL: 'normal',
    FAST: 'fast'
});
export const SUPPORTED_ONLINE_ACTION_TYPES = Object.freeze([
    'ROUND_START',
    'OPEN_GOLD',
    'SET_AI_SPEED',
    'DRAW',
    'DISCARD',
    'CHI',
    'PENG',
    'GANG',
    'AN_GANG',
    'BU_GANG',
    'HU',
    'PASS',
    'FLOWER_REPLENISH'
]);

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function isFlower(tile) {
    return typeof tile === 'string' && tile.startsWith('H');
}

function isGold(tile, goldTile) {
    return !!goldTile && tile === goldTile;
}

function toLogicTileCode(tile, goldTile) {
    if (tile === WHITE_DRAGON_TILE && goldTile && goldTile !== WHITE_DRAGON_TILE) {
        return goldTile;
    }
    return tile;
}

function parseTile(tile) {
    if (typeof tile !== 'string' || tile.length < 2) return null;
    const suit = tile[0];
    const value = Number(tile.slice(1));
    if (!Number.isInteger(value)) return null;
    return { suit, value };
}

function tileCode(suit, value) {
    return `${suit}${value}`;
}

function buildDeck() {
    const deck = [];
    for (const suit of ['W', 'T', 'S']) {
        for (let v = 1; v <= 9; v += 1) {
            for (let i = 0; i < 4; i += 1) {
                deck.push(tileCode(suit, v));
            }
        }
    }

    for (let v = 1; v <= 7; v += 1) {
        for (let i = 0; i < 4; i += 1) {
            deck.push(tileCode('Z', v));
        }
    }

    for (let v = 1; v <= 8; v += 1) {
        deck.push(tileCode('H', v));
    }

    return deck;
}

function shuffle(deck) {
    const arr = [...deck];
    for (let i = arr.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function sortTiles(tiles, goldTile) {
    const hand = [...tiles];
    hand.sort((a, b) => {
        if (a === goldTile && b !== goldTile) return -1;
        if (a !== goldTile && b === goldTile) return 1;

        const pa = parseTile(toLogicTileCode(a, goldTile));
        const pb = parseTile(toLogicTileCode(b, goldTile));
        if (!pa || !pb) return 0;

        return (TILE_ORDER[pa.suit] - TILE_ORDER[pb.suit]) || (pa.value - pb.value);
    });
    return hand;
}

function ensureSeatMaps() {
    const base = {};
    for (const seatId of SEAT_IDS) base[seatId] = [];
    return base;
}

function ensureSeatArrayMap(rawMap = {}) {
    const normalized = ensureSeatMaps();
    for (const seatId of SEAT_IDS) {
        const list = rawMap?.[seatId];
        normalized[seatId] = Array.isArray(list) ? list : [];
    }
    return normalized;
}

function ensureScoreVector(rawScores = []) {
    const next = [0, 0, 0, 0];
    if (!Array.isArray(rawScores)) return next;
    for (let i = 0; i < 4; i += 1) {
        const value = Number(rawScores[i] || 0);
        next[i] = Number.isFinite(value) ? value : 0;
    }
    return next;
}

function normalizePendingClaim(pendingClaim) {
    if (!pendingClaim || typeof pendingClaim !== 'object') return null;
    const optionsBySeat = pendingClaim.optionsBySeat && typeof pendingClaim.optionsBySeat === 'object'
        ? pendingClaim.optionsBySeat
        : {};
    const originSeatId = pendingClaim?.kind === 'QIANG_GANG'
        ? pendingClaim?.source?.seatId
        : pendingClaim?.discard?.seatId;
    return {
        ...pendingClaim,
        optionsBySeat,
        decisions: pendingClaim.decisions && typeof pendingClaim.decisions === 'object'
            ? pendingClaim.decisions
            : {},
        decisionOrder: Array.isArray(pendingClaim.decisionOrder)
            ? pendingClaim.decisionOrder.map((seatId) => String(seatId))
            : buildPendingDecisionOrderFromOptions(pendingClaim?.kind || 'DISCARD_CLAIM', originSeatId, optionsBySeat)
    };
}

function normalizeRuntimeStateShape(state, now = Date.now()) {
    if (!state || typeof state !== 'object') return {};
    if (!Array.isArray(state.wall)) state.wall = [];
    state.hands = ensureSeatArrayMap(state.hands);
    state.rivers = ensureSeatArrayMap(state.rivers);
    state.flowers = ensureSeatArrayMap(state.flowers);
    state.shows = ensureSeatArrayMap(state.shows);
    state.scores = ensureScoreVector(state.scores);
    state.pendingClaim = normalizePendingClaim(state.pendingClaim);

    if (!Array.isArray(state.actionLog)) state.actionLog = [];
    if (!state.lastAction || typeof state.lastAction !== 'object') {
        state.lastAction = {
            type: 'ROUND_START',
            seatId: Number.isInteger(state.turnSeat) ? state.turnSeat : 0,
            payload: {},
            ts: now
        };
    }

    if (!Number.isInteger(state.dealerSeat)) state.dealerSeat = 0;
    if (!Number.isInteger(state.dealerStreak)) state.dealerStreak = 0;
    if (!Number.isInteger(state.roundNo)) state.roundNo = 1;
    if (!Number.isInteger(state.roundCount)) state.roundCount = 0;
    if (!Number.isInteger(state.turnSeat)) state.turnSeat = state.dealerSeat;
    state.aiSpeedMode = normalizeAiSpeedMode(state.aiSpeedMode);
    if (!Number.isFinite(Number(state.botActionReadyAt))) state.botActionReadyAt = 0;
    if (!Number.isFinite(Number(state.botClaimReadyAt))) state.botClaimReadyAt = 0;
    if (typeof state.goldRevealed !== 'boolean') state.goldRevealed = true;
    if (state.goldRevealed === false) {
        state.goldTile = null;
    }
    if (!Number.isFinite(Number(state.goldRevealedAt))) state.goldRevealedAt = null;
    if (!Number.isInteger(state.goldRevealedBy)) state.goldRevealedBy = null;
    if (typeof state.phase !== 'string') state.phase = 'playing';
    if (!state.chuiFeng) state.chuiFeng = createChuiFengState();
    if (!Array.isArray(state.instantScoreLog)) state.instantScoreLog = [];

    return state;
}

function createSeatControlMap(seats = {}) {
    const controls = {};
    for (const seatId of SEAT_IDS) {
        const seat = seats[seatId];
        controls[seatId] = seat?.control || (seat?.isBot ? 'bot' : 'human');
    }
    return controls;
}

function normalizeForcedHostGoldCount(value) {
    const n = Number(value);
    if (!Number.isInteger(n)) return null;
    if (n < 1 || n > 3) return null;
    return n;
}

function normalizeAiSpeedMode(mode = '') {
    const raw = String(mode || '').trim().toLowerCase();
    if (raw === AI_SPEED_MODE.FAST) return AI_SPEED_MODE.FAST;
    return AI_SPEED_MODE.NORMAL;
}

function randomDelayBetween(minMs, maxMs) {
    const min = Math.max(0, Number(minMs || 0));
    const max = Math.max(min, Number(maxMs || min));
    if (max <= min) return min;
    return min + Math.floor(Math.random() * (max - min + 1));
}

function getBotActionDelayMs(state = {}) {
    const mode = normalizeAiSpeedMode(state?.aiSpeedMode);
    if (mode === AI_SPEED_MODE.FAST) return BOT_ACTION_DELAY_FAST_MS;
    return randomDelayBetween(BOT_ACTION_DELAY_NORMAL_MIN_MS, BOT_ACTION_DELAY_NORMAL_MAX_MS);
}

function getBotClaimDelayMs(state = {}) {
    const mode = normalizeAiSpeedMode(state?.aiSpeedMode);
    if (mode === AI_SPEED_MODE.FAST) return BOT_CLAIM_DELAY_FAST_MS;
    return randomDelayBetween(BOT_CLAIM_DELAY_NORMAL_MIN_MS, BOT_CLAIM_DELAY_NORMAL_MAX_MS);
}

function findHostSeatId(seats = {}, hostUid = null) {
    if (!hostUid) return null;
    for (const seatId of SEAT_IDS) {
        const seat = seats?.[seatId];
        if (!seat || seat.isBot) continue;
        if (String(seat.uid || '') === String(hostUid)) return String(seatId);
    }
    return null;
}

function normalizeSeatId(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 3) return null;
    return String(n);
}

function forceHostOpeningGoldCount(state, seats = {}, hostUid = null, forcedHostGoldCount = null, hostSeatIdInput = null) {
    const target = normalizeForcedHostGoldCount(forcedHostGoldCount);
    if (!target) return;
    if (!state?.goldTile) return;

    const hostSeatId = normalizeSeatId(hostSeatIdInput) || findHostSeatId(seats, hostUid);
    if (!hostSeatId) return;

    const hand = state.hands?.[hostSeatId];
    const wall = state.wall;
    if (!Array.isArray(hand) || !Array.isArray(wall) || !wall.length) return;

    const countGold = () => hand.filter((tile) => tile === state.goldTile).length;
    let current = countGold();

    while (current < target) {
        const wallGoldIndex = wall.findIndex((tile) => tile === state.goldTile);
        const handSwapIndex = hand.findIndex((tile) => tile !== state.goldTile && !isFlower(tile));
        if (wallGoldIndex < 0 || handSwapIndex < 0) break;
        const handTile = hand[handSwapIndex];
        hand[handSwapIndex] = state.goldTile;
        wall[wallGoldIndex] = handTile;
        current += 1;
    }

    while (current > target) {
        const handGoldIndex = hand.findIndex((tile) => tile === state.goldTile);
        const wallSwapIndex = wall.findIndex((tile) => tile !== state.goldTile && !isFlower(tile));
        if (handGoldIndex < 0 || wallSwapIndex < 0) break;
        const wallTile = wall[wallSwapIndex];
        hand[handGoldIndex] = wallTile;
        wall[wallSwapIndex] = state.goldTile;
        current -= 1;
    }

    state.hands[hostSeatId] = sortTiles(hand, state.goldTile);
    if (Number(state.currentDraw?.seatId) === Number(hostSeatId)) {
        const drawTile = state.currentDraw?.tile || null;
        if (!drawTile || !state.hands[hostSeatId].includes(drawTile)) {
            const fallbackTile = state.hands[hostSeatId][state.hands[hostSeatId].length - 1] || null;
            state.currentDraw = {
                ...(state.currentDraw || {}),
                seatId: Number(hostSeatId),
                tile: fallbackTile
            };
        }
    }
}

function seatControlMapToSeatStub(seatControls = {}) {
    const seats = {};
    for (const seatId of SEAT_IDS) {
        const control = seatControls[seatId] || 'human';
        seats[seatId] = {
            seatId,
            isBot: control === 'bot',
            control
        };
    }
    return seats;
}

function drawNonFlowerToHand(state, seatId, now = Date.now(), reason = 'NORMAL') {
    let skippedFlower = false;
    while (state.wall.length > 0) {
        const tile = state.wall.shift();
        if (isFlower(tile)) {
            skippedFlower = true;
            state.flowers[seatId].push(tile);
            continue;
        }
        state.hands[seatId].push(tile);
        const drawReason = skippedFlower
            ? (reason === 'GANG' ? 'GANG_FLOWER' : 'FLOWER')
            : reason;
        state.currentDraw = {
            seatId: Number(seatId),
            tile,
            ts: now,
            reason: drawReason
        };
        return tile;
    }

    state.phase = 'ended';
    state.endedAt = now;
    state.currentDraw = null;
    state.outcome = state.outcome || {
        reason: 'DRAW_WALL_EMPTY',
        ts: now
    };
    return null;
}

function normalizeFlowersInHand(state, seatId, now) {
    let found = true;
    while (found) {
        found = false;
        const hand = state.hands[seatId];
        for (let i = 0; i < hand.length; i += 1) {
            if (!isFlower(hand[i])) continue;
            const flower = hand.splice(i, 1)[0];
            state.flowers[seatId].push(flower);
            drawNonFlowerToHand(state, seatId, now, 'FLOWER');
            found = true;
            break;
        }
    }
}

function pickRandomNonFlowerFromWall(wall = []) {
    if (!Array.isArray(wall) || !wall.length) return null;
    const nonFlowerIndexes = [];
    for (let i = 0; i < wall.length; i += 1) {
        if (!isFlower(wall[i])) nonFlowerIndexes.push(i);
    }
    if (!nonFlowerIndexes.length) return null;

    const randomSlot = Math.floor(Math.random() * nonFlowerIndexes.length);
    const targetIndex = nonFlowerIndexes[randomSlot];
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= wall.length) return null;
    const [tile] = wall.splice(targetIndex, 1);
    return tile || null;
}

function revealGoldTile(state, now = Date.now(), seatId = null) {
    if (!state || state.phase !== 'playing' || state.goldRevealed !== false) return false;
    const picked = pickRandomNonFlowerFromWall(state.wall);
    if (!picked) return false;

    state.goldTile = picked;
    state.goldRevealed = true;
    state.goldRevealedAt = now;
    state.goldRevealedBy = Number.isInteger(Number(seatId)) ? Number(seatId) : null;

    for (const seatKey of SEAT_IDS) {
        state.hands[seatKey] = sortTiles(state.hands[seatKey] || [], state.goldTile);
    }
    return true;
}

function markAction(state, action, now) {
    if (!Array.isArray(state.actionLog)) state.actionLog = [];
    state.lastAction = {
        type: action?.type || 'UNKNOWN',
        seatId: Number.isInteger(action?.seatId) ? action.seatId : null,
        payload: action?.payload || {},
        ts: action?.ts || now
    };

    state.actionLog.push(state.lastAction);
    if (state.actionLog.length > 100) {
        state.actionLog = state.actionLog.slice(-100);
    }
}

function countNonGoldTile(hand, tile, goldTile) {
    const target = toLogicTileCode(tile, goldTile);
    let count = 0;
    for (const t of hand) {
        if (isGold(t, goldTile)) continue;
        if (toLogicTileCode(t, goldTile) === target) count += 1;
    }
    return count;
}

function removeTilesExact(hand, tile, count, goldTile) {
    const removed = [];
    for (let i = hand.length - 1; i >= 0 && removed.length < count; i -= 1) {
        if (hand[i] === tile && !isGold(hand[i], goldTile)) {
            removed.push(hand.splice(i, 1)[0]);
        }
    }
    return removed;
}

function removeOneTileByCode(hand, tile, goldTile) {
    for (let i = 0; i < hand.length; i += 1) {
        if (hand[i] === tile && !isGold(hand[i], goldTile)) {
            hand.splice(i, 1);
            return true;
        }
    }
    return false;
}

function removeOneTileByLogicCode(hand, logicTile, goldTile) {
    const target = toLogicTileCode(logicTile, goldTile);
    for (let i = 0; i < hand.length; i += 1) {
        if (isGold(hand[i], goldTile)) continue;
        if (toLogicTileCode(hand[i], goldTile) === target) {
            const [removed] = hand.splice(i, 1);
            return removed || null;
        }
    }
    return null;
}

function removeTilesByLogic(hand, tile, count, goldTile) {
    const target = toLogicTileCode(tile, goldTile);
    const removed = [];
    for (let i = hand.length - 1; i >= 0 && removed.length < count; i -= 1) {
        if (isGold(hand[i], goldTile)) continue;
        if (toLogicTileCode(hand[i], goldTile) === target) {
            removed.push(hand.splice(i, 1)[0]);
        }
    }
    return removed;
}

function removeOneTileByCodeLoose(hand, tile) {
    const idx = hand.indexOf(tile);
    if (idx < 0) return false;
    hand.splice(idx, 1);
    return true;
}

function chooseDiscardIndex(hand, goldTile) {
    if (!Array.isArray(hand) || !hand.length) return -1;
    const nonGold = hand.findIndex(tile => tile !== goldTile);
    return nonGold >= 0 ? nonGold : 0;
}

function getNeighborCount(counts = {}, suit, value) {
    if (!['W', 'T', 'S'].includes(suit)) return 0;
    let linked = 0;
    if (counts[tileCode(suit, value - 1)] > 0) linked += 1;
    if (counts[tileCode(suit, value + 1)] > 0) linked += 1;
    return linked;
}

function chooseStrategicDiscardIndex(hand, goldTile) {
    if (!Array.isArray(hand) || !hand.length) return -1;

    const counts = {};
    for (const tile of hand) {
        if (isGold(tile, goldTile) || isFlower(tile)) continue;
        const logic = toLogicTileCode(tile, goldTile);
        counts[logic] = (counts[logic] || 0) + 1;
    }

    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < hand.length; i += 1) {
        const tile = hand[i];
        if (isGold(tile, goldTile) || isFlower(tile)) continue;
        const logic = toLogicTileCode(tile, goldTile);
        const parsed = parseTile(logic);
        if (!parsed) continue;

        const sameCount = counts[logic] || 0;
        const linked = getNeighborCount(counts, parsed.suit, parsed.value);

        let discardScore = 0;
        if (sameCount <= 1) discardScore += 2;
        if (sameCount === 2) discardScore -= 1;
        if (sameCount >= 3) discardScore -= 3;

        if (parsed.suit === 'Z') {
            discardScore += 3.5;
        } else {
            if (linked === 0) discardScore += 2;
            if (linked === 1) discardScore += 1;
            if (linked >= 2) discardScore -= 1;
            if (parsed.value === 1 || parsed.value === 9) discardScore += 0.5;
        }

        if (discardScore > bestScore) {
            bestScore = discardScore;
            bestIdx = i;
        }
    }

    if (bestIdx >= 0) return bestIdx;
    return chooseDiscardIndex(hand, goldTile);
}

function chooseFollowChuiFengDiscardIndex(state, seatId, hand) {
    if (!state?.chuiFeng?.active || state.chuiFeng.failed) return -1;
    if (Number(seatId) === Number(state.dealerSeat)) return -1;
    const targetTile = state.chuiFeng.targetTile;
    if (!targetTile) return -1;

    const targetLogic = toLogicTileCode(targetTile, state.goldTile);
    for (let i = 0; i < hand.length; i += 1) {
        const tile = hand[i];
        if (isGold(tile, state.goldTile) || isFlower(tile)) continue;
        if (toLogicTileCode(tile, state.goldTile) === targetLogic) return i;
    }
    return -1;
}

function chooseBotDiscardIndex(state, seatId) {
    const hand = state.hands?.[String(seatId)] || [];
    if (!hand.length) return -1;

    const chuiFengIdx = chooseFollowChuiFengDiscardIndex(state, seatId, hand);
    if (chuiFengIdx >= 0) return chuiFengIdx;

    return chooseStrategicDiscardIndex(hand, state.goldTile);
}

function getHuInfo({ hand, extraTile = null, isSelfDraw = false, winnerSeat = 0, dealerSeat = 0, roundCount = 0, goldTile = null, drawnTile = null, drawReason = 'NORMAL' }) {
    return evaluateHuInfo({
        hand,
        extraTile,
        isSelfDraw,
        winnerSeat,
        dealerSeat,
        roundCount,
        drawnTile,
        drawReason,
        isGoldTile: (tile) => isGold(tile, goldTile),
        logicCodeOf: (tile) => toLogicTileCode(tile, goldTile),
        removeDrawnTile: (tiles, tile) => removeOneTileByCodeLoose(tiles, tile)
    });
}

function getWaterMultiplier(flowerCount) {
    if (flowerCount < 4) return 1;
    return Math.pow(2, flowerCount - 3);
}

function getSpecialMultiplier(types = []) {
    const map = {
        '游金': 2,
        '三金倒': 8,
        '天胡': 8,
        '地胡': 8,
        '杠上开花': 2,
        '花开富贵': 2,
        '抢杠胡': 2
    };

    let mul = 1;
    if (types.includes('三金倒')) {
        mul *= map['三金倒'];
        types.forEach((t) => {
            if (t === '三金倒' || t === '游金') return;
            if (map[t]) mul *= map[t];
        });
        return mul;
    }

    types.forEach((t) => {
        if (map[t]) mul *= map[t];
    });
    return mul;
}

function shouldApplySelfDrawBonus(state, winnerSeat, isSelfDraw, specialTypes = [], drawnTile = null) {
    if (!isSelfDraw) return false;
    if (specialTypes.includes('三金倒')) {
        return !!drawnTile && isGold(drawnTile, state.goldTile);
    }
    return true;
}

function getBasePay(state, winnerSeat, payerSeat, isSelfDraw) {
    const base = 1;
    const dealer = state.dealerSeat;

    let pay = 0;
    if (winnerSeat === dealer) {
        const mul = state.dealerStreak >= 1 ? Math.pow(2, state.dealerStreak) : 1;
        pay = base * 2 * mul;
    } else {
        pay = payerSeat === dealer ? base * 2 : base;
    }

    if (isSelfDraw) pay += 1;
    return pay;
}

function settleWin(state, { winnerSeat, loserSeat = null, isSelfDraw, reason, winTile = null, specialTypes = [], now = Date.now(), drawnTile = null }) {
    const winner = Number(winnerSeat);
    const scoreAsSelfDraw = shouldApplySelfDrawBonus(state, winner, isSelfDraw, specialTypes, drawnTile);
    const flowerCount = (state.flowers[String(winner)] || []).length;
    const waterMul = getWaterMultiplier(flowerCount);
    const rawSpecialMul = getSpecialMultiplier(specialTypes);
    const isQiangGangHu = specialTypes.includes('抢杠胡');
    const specialMul = rawSpecialMul;

    const delta = [0, 0, 0, 0];
    let totalWin = 0;
    const qiangPayer = Number(loserSeat);
    const shouldUseSinglePayer = isQiangGangHu && Number.isInteger(qiangPayer) && qiangPayer >= 0 && qiangPayer <= 3;
    if (shouldUseSinglePayer) {
        let pay = 0;
        for (let i = 0; i < 4; i += 1) {
            if (i === winner) continue;
            pay += getBasePay(state, winner, i, false);
        }
        const finalScore = pay * waterMul * specialMul;
        delta[qiangPayer] -= finalScore;
        delta[winner] += finalScore;
        totalWin = finalScore;
    } else {
        for (let i = 0; i < 4; i += 1) {
            if (i === winner) continue;
            const pay = getBasePay(state, winner, i, scoreAsSelfDraw);
            const finalScore = pay * waterMul * specialMul;
            delta[i] -= finalScore;
            delta[winner] += finalScore;
            totalWin += finalScore;
        }
    }

    for (let i = 0; i < 4; i += 1) {
        state.scores[i] += delta[i];
    }

    const dealerBefore = state.dealerSeat;
    const streakBefore = state.dealerStreak;
    if (winner === dealerBefore) {
        state.dealerStreak += 1;
    } else {
        state.dealerSeat = (dealerBefore + 1) % 4;
        state.dealerStreak = 0;
    }

    state.phase = 'ended';
    state.endedAt = now;
    state.winner = winner;
    state.outcome = {
        winner,
        loser: isSelfDraw ? null : Number(loserSeat),
        isSelfDraw,
        reason,
        winTile,
        specialTypes,
        flowerCount,
        scoreAsSelfDraw,
        waterMul,
        specialMul,
        rawSpecialMul,
        totalWin,
        payout: delta,
        dealerBefore,
        dealerStreakBefore: streakBefore,
        dealerAfter: state.dealerSeat,
        dealerStreakAfter: state.dealerStreak,
        ts: now
    };
    pushInstantScoreEntry(state, {
        type: 'HU_SETTLE',
        seatId: winner,
        winnerSeat: winner,
        loserSeat: isSelfDraw ? null : Number(loserSeat),
        dealerSeat: dealerBefore,
        isSelfDraw: !!isSelfDraw,
        winTile: winTile || null,
        specialTypes: Array.isArray(specialTypes) ? [...specialTypes] : [],
        flowerCount,
        waterMul,
        scoreAsSelfDraw: !!scoreAsSelfDraw,
        totalWin,
        delta,
        ts: now
    });
    state.pendingClaim = null;
    state.currentDraw = null;
}

function pushInstantScoreEntry(state, entry = {}) {
    if (!Array.isArray(state.instantScoreLog)) state.instantScoreLog = [];
    const roundNo = Number.isInteger(Number(entry.roundNo))
        ? Number(entry.roundNo)
        : Number(state.roundNo || 1);
    state.instantScoreLog.push({
        ...entry,
        roundNo
    });
    if (state.instantScoreLog.length > MAX_INSTANT_SCORE_LOG_SIZE) {
        state.instantScoreLog = state.instantScoreLog.slice(-MAX_INSTANT_SCORE_LOG_SIZE);
    }
}

function applyInstantGangScore(state, gangerSeat, isAnGang = false, now = Date.now()) {
    const winner = Number(gangerSeat);
    const unit = isAnGang ? 2 : 1;
    const delta = [0, 0, 0, 0];

    for (let i = 0; i < 4; i += 1) {
        if (i === winner) continue;
        delta[i] -= unit;
        delta[winner] += unit;
    }

    for (let i = 0; i < 4; i += 1) {
        state.scores[i] += delta[i];
    }

    pushInstantScoreEntry(state, {
        type: isAnGang ? 'AN_GANG' : 'MING_GANG',
        seatId: winner,
        delta,
        ts: now
    });
}

function createChuiFengState() {
    return {
        dealerDiscardCount: 0,
        targetTile: null,
        followCount: 0,
        active: false,
        failed: false
    };
}

function applyChuiFengSettlement(state, now = Date.now(), targetTile = null) {
    const dealer = Number(state.dealerSeat) || 0;
    const delta = [0, 0, 0, 0];
    delta[dealer] -= 3;
    for (let i = 0; i < 4; i += 1) {
        if (i !== dealer) delta[i] += 1;
    }

    for (let i = 0; i < 4; i += 1) {
        state.scores[i] += delta[i];
    }

    pushInstantScoreEntry(state, {
        type: 'CHUI_FENG',
        seatId: dealer,
        targetTile,
        delta,
        ts: now
    });
}

function checkChuiFengAfterDiscard(state, discardSeatId, discardTile, now = Date.now()) {
    if (!state.chuiFeng) state.chuiFeng = createChuiFengState();
    const chuiFeng = state.chuiFeng;
    const dealerSeat = Number(state.dealerSeat) || 0;

    if (discardSeatId === dealerSeat) {
        chuiFeng.dealerDiscardCount += 1;
        if (chuiFeng.dealerDiscardCount <= 2) {
            chuiFeng.targetTile = discardTile;
            chuiFeng.followCount = 1;
            chuiFeng.active = true;
            chuiFeng.failed = false;
        } else {
            chuiFeng.targetTile = null;
            chuiFeng.followCount = 0;
            chuiFeng.active = false;
            chuiFeng.failed = false;
        }
        return;
    }

    if (!chuiFeng.active || chuiFeng.failed) return;
    if (discardTile === chuiFeng.targetTile) {
        chuiFeng.followCount += 1;
        if (chuiFeng.followCount >= 4) {
            applyChuiFengSettlement(state, now, discardTile);
            chuiFeng.active = false;
        }
        return;
    }

    chuiFeng.failed = true;
    chuiFeng.active = false;
}

function canHuWithDiscard(state, seatId, discardTile) {
    const hand = state.hands[seatId] || [];
    const info = getHuInfo({
        hand,
        extraTile: discardTile,
        isSelfDraw: false,
        winnerSeat: Number(seatId),
        dealerSeat: state.dealerSeat,
        roundCount: state.roundCount,
        goldTile: state.goldTile,
        drawnTile: null,
        drawReason: 'NORMAL'
    });
    return info;
}

function canHuSelfDraw(state, seatId) {
    const draw = state.currentDraw || null;
    if (!draw) {
        return { canHu: false, types: [] };
    }
    if (Number(draw.seatId) !== Number(seatId) || !draw.tile) {
        return { canHu: false, types: [] };
    }
    const hand = state.hands[String(seatId)] || [];
    const info = getHuInfo({
        hand,
        extraTile: null,
        isSelfDraw: true,
        winnerSeat: Number(seatId),
        dealerSeat: state.dealerSeat,
        roundCount: state.roundCount,
        goldTile: state.goldTile,
        drawnTile: draw.tile || null,
        drawReason: draw.reason || 'NORMAL'
    });
    return info;
}

function isMandatorySanJinHu(state, seatId) {
    const seatNo = Number(seatId);
    if (!state || state.phase !== 'playing') return false;
    if (!Number.isInteger(seatNo) || seatNo !== state.turnSeat) return false;
    const info = canHuSelfDraw(state, seatNo);
    return !!(info?.canHu && Array.isArray(info.types) && info.types.includes('三金倒'));
}

function getAnGangOptions(state, seatId) {
    const hand = state.hands[String(seatId)] || [];
    const counts = {};
    for (const tile of hand) {
        if (isGold(tile, state.goldTile) || isFlower(tile)) continue;
        counts[tile] = (counts[tile] || 0) + 1;
    }
    return Object.keys(counts).filter((tile) => counts[tile] === 4);
}

function getBuGangOptions(state, seatId) {
    const hand = state.hands[String(seatId)] || [];
    const shows = state.shows[String(seatId)] || [];
    const options = new Set();

    for (const group of shows) {
        if (!group || group.type !== 'PENG' || !Array.isArray(group.tiles) || !group.tiles.length) continue;
        const tile = group.tiles[0];
        if (isGold(tile, state.goldTile) || isFlower(tile)) continue;
        if (hand.some((h) => h === tile && !isGold(h, state.goldTile))) {
            options.add(tile);
        }
    }

    return [...options];
}

function findPengGroupByTile(shows = [], tile) {
    return shows.find((g) => g?.type === 'PENG' && Array.isArray(g.tiles) && g.tiles[0] === tile) || null;
}

function buildQiangGangPending(state, seatNo, tile, actionType, now) {
    const optionsBySeat = {};
    for (let i = 1; i < 4; i += 1) {
        const seatId = String((seatNo + i) % 4);
        const huInfo = canHuWithDiscard(state, seatId, tile);
        if (!huInfo.canHu) continue;
        optionsBySeat[seatId] = {
            HU: true,
            huTypes: huInfo.types || [],
            PENG: false,
            GANG: false,
            CHI: []
        };
    }

    if (!Object.keys(optionsBySeat).length) return null;
    const decisionOrder = buildPendingDecisionOrderFromOptions('QIANG_GANG', seatNo, optionsBySeat);
    return {
        kind: 'QIANG_GANG',
        source: { seatId: seatNo, tile, actionType, ts: now },
        optionsBySeat,
        decisions: {},
        decisionOrder,
        expiresAt: now + CLAIM_TIMEOUT_MS
    };
}

function applyAnGangCommit(state, seatId, target, now) {
    const hand = state.hands[seatId] || [];
    const removed = removeTilesExact(hand, target, 4, state.goldTile);
    if (removed.length < 4) return false;

    state.shows[seatId].push({ type: 'AN_GANG', tiles: [...removed] });
    applyInstantGangScore(state, seatId, true, now);
    state.currentDraw = null;
    drawNonFlowerToHand(state, seatId, now, 'GANG');
    state.hands[seatId] = sortTiles(state.hands[seatId], state.goldTile);
    return true;
}

function applyBuGangCommit(state, seatId, target, now) {
    const hand = state.hands[seatId] || [];
    const removed = removeTilesExact(hand, target, 1, state.goldTile);
    if (removed.length < 1) return false;

    const shows = state.shows[seatId] || [];
    const pengGroup = findPengGroupByTile(shows, target);
    if (!pengGroup) return false;

    pengGroup.type = 'BU_GANG';
    pengGroup.tiles.push(removed[0]);

    applyInstantGangScore(state, seatId, false, now);
    state.currentDraw = null;
    drawNonFlowerToHand(state, seatId, now, 'GANG');
    state.hands[seatId] = sortTiles(state.hands[seatId], state.goldTile);
    return true;
}

function applyPendingGangCommit(state, now) {
    const pending = state.pendingClaim;
    if (!pending || pending.kind !== 'QIANG_GANG') return false;

    const source = pending.source || {};
    const seatId = String(source.seatId);
    if (source.actionType === 'AN_GANG') {
        return applyAnGangCommit(state, seatId, source.tile, now);
    }
    if (source.actionType === 'BU_GANG') {
        return applyBuGangCommit(state, seatId, source.tile, now);
    }
    return false;
}

function canChiOptions(hand, discardTile, goldTile) {
    if (isGold(discardTile, goldTile)) return [];
    const parsed = parseTile(toLogicTileCode(discardTile, goldTile));
    if (!parsed || !['W', 'T', 'S'].includes(parsed.suit)) return [];

    const values = [];
    const candidates = [
        [parsed.value - 2, parsed.value - 1],
        [parsed.value - 1, parsed.value + 1],
        [parsed.value + 1, parsed.value + 2]
    ];

    const handCounts = {};
    for (const t of hand) {
        if (isGold(t, goldTile)) continue;
        const logicTile = toLogicTileCode(t, goldTile);
        handCounts[logicTile] = (handCounts[logicTile] || 0) + 1;
    }

    for (const pair of candidates) {
        if (pair[0] < 1 || pair[1] > 9) continue;
        const left = tileCode(parsed.suit, pair[0]);
        const right = tileCode(parsed.suit, pair[1]);

        if (left === right) {
            if ((handCounts[left] || 0) >= 2) values.push([left, right]);
        } else if ((handCounts[left] || 0) >= 1 && (handCounts[right] || 0) >= 1) {
            values.push([left, right]);
        }
    }

    return values;
}

function applyAnGangAction(state, action, now) {
    const seatId = String(action.seatId);
    const seatNo = Number(seatId);
    if (!Number.isInteger(seatNo) || seatNo !== state.turnSeat) return false;
    if (state.pendingClaim) return false;

    const options = getAnGangOptions(state, seatId);
    if (!options.length) return false;
    const target = action.payload?.char || action.payload?.tile || options[0];
    if (!options.includes(target)) return false;

    return applyAnGangCommit(state, seatId, target, now);
}

function applyBuGangAction(state, action, now) {
    const seatId = String(action.seatId);
    const seatNo = Number(seatId);
    if (!Number.isInteger(seatNo) || seatNo !== state.turnSeat) return false;
    if (state.pendingClaim) return false;

    const options = getBuGangOptions(state, seatId);
    if (!options.length) return false;
    const target = action.payload?.char || action.payload?.tile || options[0];
    if (!options.includes(target)) return false;

    const shows = state.shows[seatId] || [];
    const pengGroup = findPengGroupByTile(shows, target);
    if (!pengGroup) return false;

    const hand = state.hands[seatId] || [];
    const canConsumeTile = hand.some((h) => h === target && !isGold(h, state.goldTile));
    if (!canConsumeTile) return false;

    const qiangGang = buildQiangGangPending(state, seatNo, target, 'BU_GANG', now);
    if (qiangGang) {
        state.pendingClaim = qiangGang;
        state.currentDraw = null;
        return true;
    }

    return applyBuGangCommit(state, seatId, target, now);
}

function getReactionOptionsForSeat(state, seatId, discardSeatId, discardTile) {
    const hand = state.hands[seatId] || [];
    const nextSeatId = String((discardSeatId + 1) % 4);

    const huInfo = canHuWithDiscard(state, seatId, discardTile);
    const options = {
        HU: huInfo.canHu,
        huTypes: huInfo.types || [],
        PENG: false,
        GANG: false,
        CHI: []
    };

    if (isGold(discardTile, state.goldTile)) return options;

    const sameCount = countNonGoldTile(hand, discardTile, state.goldTile);
    options.PENG = sameCount >= 2;
    options.GANG = sameCount >= 3;

    if (seatId === nextSeatId) {
        options.CHI = canChiOptions(hand, discardTile, state.goldTile);
    }

    return options;
}

function hasAnyReactionOption(options) {
    return !!(options.HU || options.PENG || options.GANG || (options.CHI && options.CHI.length));
}

function buildPendingClaim(state, discardSeatId, discardTile, now) {
    const optionsBySeat = {};
    for (let i = 1; i < 4; i += 1) {
        const seatId = String((discardSeatId + i) % 4);
        const options = getReactionOptionsForSeat(state, seatId, discardSeatId, discardTile);
        if (hasAnyReactionOption(options)) {
            optionsBySeat[seatId] = options;
        }
    }

    if (!Object.keys(optionsBySeat).length) return null;
    const decisionOrder = buildPendingDecisionOrderFromOptions('DISCARD_CLAIM', discardSeatId, optionsBySeat);

    return {
        kind: 'DISCARD_CLAIM',
        discard: { seatId: discardSeatId, tile: discardTile, ts: now },
        optionsBySeat,
        decisions: {},
        decisionOrder,
        expiresAt: now + CLAIM_TIMEOUT_MS
    };
}

function removeLastDiscardFromRiver(state, discardSeatId, discardTile) {
    const river = state.rivers[String(discardSeatId)] || [];
    for (let i = river.length - 1; i >= 0; i -= 1) {
        if (river[i] === discardTile) {
            river.splice(i, 1);
            return true;
        }
    }
    return false;
}

function seatDistance(discardSeatId, seatId) {
    return (Number(seatId) - Number(discardSeatId) + 4) % 4;
}

function buildPendingDecisionOrderFromOptions(kind, originSeatId, optionsBySeat = {}) {
    const seatIds = Object.keys(optionsBySeat || {});
    if (!seatIds.length) return [];
    const origin = Number(originSeatId);
    const hasOrigin = Number.isInteger(origin) && origin >= 0 && origin <= 3;

    return seatIds.slice().sort((a, b) => {
        const pa = seatClaimPriority(optionsBySeat?.[a] || null);
        const pb = seatClaimPriority(optionsBySeat?.[b] || null);
        if (pa !== pb) return pa - pb;

        if (hasOrigin) {
            const da = seatDistance(origin, a);
            const db = seatDistance(origin, b);
            if (da !== db) return da - db;
        }

        return Number(a) - Number(b);
    });
}

function toChoiceCodes(choice, discardTile, goldTile = null) {
    if (!Array.isArray(choice) || choice.length !== 2) return null;

    if (typeof choice[0] === 'string' && typeof choice[1] === 'string') {
        return [choice[0], choice[1]];
    }

    if (typeof choice[0] === 'number' && typeof choice[1] === 'number') {
        const parsed = parseTile(toLogicTileCode(discardTile, goldTile));
        if (!parsed) return null;
        return [tileCode(parsed.suit, choice[0]), tileCode(parsed.suit, choice[1])];
    }

    return null;
}

function seatClaimPriority(options = {}) {
    if (!options || typeof options !== 'object') return 9;
    if (options.HU) return CLAIM_PRIORITY.HU;
    if (options.PENG || options.GANG) return CLAIM_PRIORITY.PENG;
    if (Array.isArray(options.CHI) && options.CHI.length) return CLAIM_PRIORITY.CHI;
    return 9;
}

function getPendingDecisionOrder(pending = null) {
    const persisted = Array.isArray(pending?.decisionOrder)
        ? pending.decisionOrder.map((seatId) => String(seatId))
        : [];
    if (persisted.length) return persisted;
    const originSeatId = pending?.kind === 'QIANG_GANG'
        ? pending?.source?.seatId
        : pending?.discard?.seatId;
    return buildPendingDecisionOrderFromOptions(pending?.kind || 'DISCARD_CLAIM', originSeatId, pending?.optionsBySeat || {});
}

function getActivePendingSeatId(state, pending) {
    if (!pending?.optionsBySeat || typeof pending.optionsBySeat !== 'object') return null;
    const order = getPendingDecisionOrder(pending);
    for (const rawSeatId of order) {
        const seatId = String(rawSeatId || '');
        if (!seatId || !pending.optionsBySeat?.[seatId]) continue;
        if (pending.decisions?.[seatId]) continue;
        return seatId;
    }

    for (const seatId of Object.keys(pending.optionsBySeat)) {
        if (pending.decisions?.[seatId]) continue;
        return seatId;
    }
    return null;
}

function isSeatEligibleForPendingDecision(state, pending, seatId) {
    const options = pending?.optionsBySeat?.[seatId];
    if (!options) return false;
    const activeSeatId = getActivePendingSeatId(state, pending);
    return !!activeSeatId && String(activeSeatId) === String(seatId);
}

function normalizeClaimDecision(state, seatId, action) {
    const pending = state.pendingClaim;
    if (!pending) return null;

    const options = pending.optionsBySeat[seatId];
    if (!options) return null;

    if (!isSeatEligibleForPendingDecision(state, pending, seatId)) return null;

    const type = action.type;
    if (type === 'PASS') {
        return { type: 'PASS', payload: {}, byAction: true };
    }

    if (pending.kind === 'QIANG_GANG') {
        if (type === 'HU' && options.HU) return { type: 'HU', payload: { huTypes: options.huTypes || [] }, byAction: true };
        return null;
    }

    if (type === 'HU' && options.HU) return { type: 'HU', payload: { huTypes: options.huTypes || [] }, byAction: true };
    if (type === 'PENG' && options.PENG) return { type: 'PENG', payload: {}, byAction: true };
    if (type === 'GANG' && options.GANG) return { type: 'GANG', payload: {}, byAction: true };

    if (type === 'CHI' && options.CHI.length) {
        const rawChoice = action.payload?.choice || action.payload;
        const chosen = toChoiceCodes(rawChoice, pending.discard.tile, state.goldTile);
        if (chosen) {
            const valid = options.CHI.some((opt) => opt[0] === chosen[0] && opt[1] === chosen[1]);
            if (valid) return { type: 'CHI', payload: { choice: chosen }, byAction: true };
        }
        return { type: 'CHI', payload: { choice: options.CHI[0] }, byAction: true };
    }

    return null;
}

function applyClaimWin(state, claim, now) {
    const pending = state.pendingClaim;
    if (!pending) return;

    const seatId = String(claim.seatId);

    if (pending.kind === 'QIANG_GANG') {
        if (claim.type !== 'HU') {
            state.pendingClaim = null;
            return;
        }

        const gangerSeatId = String(pending.source?.seatId);
        const gangTile = pending.source?.tile;
        const huInfo = canHuWithDiscard(state, seatId, gangTile);
        if (!huInfo.canHu) {
            state.pendingClaim = null;
            return;
        }

        const specialTypes = [...new Set([...(huInfo.types || []), '抢杠胡'])];
        settleWin(state, {
            winnerSeat: seatId,
            loserSeat: gangerSeatId,
            isSelfDraw: false,
            reason: 'QIANG_GANG_HU',
            winTile: gangTile,
            specialTypes,
            now,
            drawnTile: null
        });
        state.pendingClaim = null;
        return;
    }

    const discardSeatId = String(pending.discard.seatId);
    const discardTile = pending.discard.tile;

    if (claim.type === 'HU') {
        const huInfo = canHuWithDiscard(state, seatId, discardTile);
        if (!huInfo.canHu) {
            state.pendingClaim = null;
            return;
        }
        settleWin(state, {
            winnerSeat: seatId,
            loserSeat: discardSeatId,
            isSelfDraw: false,
            reason: 'DISCARD_HU',
            winTile: discardTile,
            specialTypes: huInfo.types,
            now,
            drawnTile: null
        });
        state.pendingClaim = null;
        state.lastDiscard = null;
        return;
    }

    removeLastDiscardFromRiver(state, discardSeatId, discardTile);

    const hand = state.hands[seatId] || [];

    if (claim.type === 'PENG') {
        const removed = removeTilesByLogic(hand, discardTile, 2, state.goldTile);
        if (removed.length < 2) {
            state.pendingClaim = null;
            return;
        }
        state.shows[seatId].push({ type: 'PENG', tiles: [discardTile, ...removed] });
        state.turnSeat = Number(seatId);
        state.lastDiscard = null;
        state.currentDraw = null;
        state.hands[seatId] = sortTiles(state.hands[seatId], state.goldTile);
        state.pendingClaim = null;
        return;
    }

    if (claim.type === 'GANG') {
        const removed = removeTilesByLogic(hand, discardTile, 3, state.goldTile);
        if (removed.length < 3) {
            state.pendingClaim = null;
            return;
        }
        state.shows[seatId].push({ type: 'GANG', tiles: [discardTile, ...removed] });
        applyInstantGangScore(state, seatId, false, now);
        state.turnSeat = Number(seatId);
        state.lastDiscard = null;
        state.currentDraw = null;
        drawNonFlowerToHand(state, seatId, now, 'GANG');
        state.hands[seatId] = sortTiles(state.hands[seatId], state.goldTile);
        state.pendingClaim = null;
        return;
    }

    if (claim.type === 'CHI') {
        const choice = toChoiceCodes(claim.payload?.choice, discardTile, state.goldTile) || [];
        if (choice.length !== 2) {
            state.pendingClaim = null;
            return;
        }

        const removedA = removeOneTileByLogicCode(hand, choice[0], state.goldTile);
        const removedB = removeOneTileByLogicCode(hand, choice[1], state.goldTile);
        if (!removedA || !removedB) {
            if (removedA) hand.push(removedA);
            if (removedB) hand.push(removedB);
            state.pendingClaim = null;
            return;
        }

        const meld = sortTiles([removedA, discardTile, removedB], state.goldTile);
        state.shows[seatId].push({ type: 'CHI', tiles: meld });
        state.turnSeat = Number(seatId);
        state.lastDiscard = null;
        state.currentDraw = null;
        state.hands[seatId] = sortTiles(state.hands[seatId], state.goldTile);
        state.pendingClaim = null;
    }
}

function advanceToNextTurnAndDraw(state, discardSeatId, now) {
    state.turnSeat = (Number(discardSeatId) + 1) % 4;
    const nextSeatId = String(state.turnSeat);
    drawNonFlowerToHand(state, nextSeatId, now, 'NORMAL');
    state.hands[nextSeatId] = sortTiles(state.hands[nextSeatId], state.goldTile);

    if (!state.wall.length && state.phase !== 'ended') {
        state.phase = 'ended';
        state.endedAt = now;
    }
}

function buildAutoClaimDecision(option = {}, pendingKind = 'DISCARD_CLAIM') {
    if (pendingKind === 'QIANG_GANG') {
        if (option.HU) return { type: 'HU', payload: { huTypes: option.huTypes || [] }, byAction: false };
        return { type: 'PASS', payload: {}, byAction: false };
    }
    if (option.HU) return { type: 'HU', payload: { huTypes: option.huTypes || [] }, byAction: false };
    if (option.GANG) return { type: 'GANG', payload: {}, byAction: false };
    if (option.PENG) return { type: 'PENG', payload: {}, byAction: false };
    if (Array.isArray(option.CHI) && option.CHI.length) {
        return { type: 'CHI', payload: { choice: option.CHI[0] }, byAction: false };
    }
    return { type: 'PASS', payload: {}, byAction: false };
}

function autoDecideBotClaims(state) {
    if (!state.pendingClaim) return;
    const pending = state.pendingClaim;
    const activeSeatId = getActivePendingSeatId(state, pending);
    if (!activeSeatId) return;
    if (pending.decisions?.[activeSeatId]) return;

    const control = state.seatControls?.[activeSeatId] || 'human';
    if (control !== 'bot') return;

    const option = pending.optionsBySeat?.[activeSeatId] || {};
    pending.decisions[activeSeatId] = buildAutoClaimDecision(option, pending.kind);
}

function resolvePendingClaimIfReady(state, now, force = false) {
    if (!state.pendingClaim) return false;
    const pending = state.pendingClaim;

    const orderedSeatIds = getPendingDecisionOrder(pending);
    const fallbackSeatIds = Object.keys(pending.optionsBySeat || {})
        .map((seatId) => String(seatId))
        .filter((seatId) => !orderedSeatIds.includes(seatId));
    const seatOrder = [...orderedSeatIds, ...fallbackSeatIds];

    for (const rawSeatId of seatOrder) {
        const seatId = String(rawSeatId || '');
        if (!seatId || !pending.optionsBySeat?.[seatId]) continue;

        let decision = pending.decisions?.[seatId] || null;
        if (!decision) {
            const control = state.seatControls?.[seatId] || 'human';
            if (control === 'bot') {
                const option = pending.optionsBySeat?.[seatId] || {};
                decision = buildAutoClaimDecision(option, pending.kind);
                pending.decisions[seatId] = decision;
            } else if (force) {
                decision = { type: 'PASS', payload: {}, byAction: false };
                pending.decisions[seatId] = decision;
            } else {
                return false;
            }
        }

        if (decision.type === 'PASS') continue;

        const selectedClaim = {
            seatId: Number(seatId),
            ...decision
        };
        if (!selectedClaim.byAction) {
            markAction(state, {
                type: selectedClaim.type,
                seatId: selectedClaim.seatId,
                payload: selectedClaim.payload || {},
                ts: now
            }, now);
        }
        applyClaimWin(state, selectedClaim, now);
        return true;
    }

    if (pending.kind === 'QIANG_GANG') {
        applyPendingGangCommit(state, now);
        state.pendingClaim = null;
        return true;
    }

    const discardSeatId = pending.discard.seatId;
    state.pendingClaim = null;
    advanceToNextTurnAndDraw(state, discardSeatId, now);
    return true;
}

function applyDiscardAction(state, action, now) {
    const seatId = String(action.seatId);
    const seatNo = Number(seatId);
    if (!Number.isInteger(seatNo) || seatNo !== state.turnSeat) {
        markAction(state, action, now);
        return state;
    }

    if (state.pendingClaim) {
        markAction(state, action, now);
        return state;
    }

    const hand = state.hands[seatId] || [];
    if (!hand.length) {
        markAction(state, action, now);
        return state;
    }

    let discardIndex = -1;
    if (Number.isInteger(action.payload?.index)) {
        discardIndex = action.payload.index;
    } else if (typeof action.payload?.tile === 'string') {
        discardIndex = hand.findIndex(tile => tile === action.payload.tile);
    }

    if (discardIndex < 0 || discardIndex >= hand.length) {
        discardIndex = chooseDiscardIndex(hand, state.goldTile);
    }

    if (discardIndex < 0) {
        markAction(state, action, now);
        return state;
    }

    if (hand[discardIndex] === state.goldTile) {
        const fallback = chooseDiscardIndex(hand, state.goldTile);
        if (fallback >= 0 && hand[fallback] !== state.goldTile) {
            discardIndex = fallback;
        }
    }

    const discarded = hand.splice(discardIndex, 1)[0];
    state.rivers[seatId].push(discarded);
    state.lastDiscard = { seatId: seatNo, tile: discarded, ts: now };
    state.currentDraw = null;
    state.roundCount = (state.roundCount || 0) + 1;
    checkChuiFengAfterDiscard(state, seatNo, discarded, now);

    const pending = buildPendingClaim(state, seatNo, discarded, now);
    if (pending) {
        state.pendingClaim = pending;
    } else {
        advanceToNextTurnAndDraw(state, seatNo, now);
    }

    markAction(state, action, now);
    return state;
}

function isReactionAction(type) {
    return ['CHI', 'PENG', 'GANG', 'HU', 'PASS'].includes(type);
}

function applyReactionAction(state, action, now) {
    if (!state.pendingClaim) {
        markAction(state, action, now);
        return state;
    }

    const seatId = String(action.seatId);
    const decision = normalizeClaimDecision(state, seatId, action);
    if (!decision) {
        markAction(state, action, now);
        return state;
    }

    state.pendingClaim.decisions[seatId] = decision;
    markAction(state, action, now);
    if (decision.type !== 'PASS') {
        applyClaimWin(state, {
            seatId: Number(seatId),
            ...decision
        }, now);
        return state;
    }
    resolvePendingClaimIfReady(state, now, false);
    return state;
}

function createInitialGameState({
    seats = {},
    dealerSeat = 0,
    dealerStreak = 0,
    scores = [0, 0, 0, 0],
    now = Date.now(),
    roundNo = 1,
    hostUid = null,
    forcedHostGoldCount = null,
    hostSeatId = null
} = {}) {
    const wall = shuffle(buildDeck());

    const state = {
        phase: 'playing',
        startedAt: now,
        endedAt: null,
        roundNo,
        roundCount: 0,
        dealerSeat,
        dealerStreak,
        turnSeat: dealerSeat,
        goldTile: null,
        goldRevealed: false,
        goldRevealedAt: null,
        goldRevealedBy: null,
        wall,
        hands: ensureSeatMaps(),
        rivers: ensureSeatMaps(),
        flowers: ensureSeatMaps(),
        shows: ensureSeatMaps(),
        scores: [...scores],
        lastDiscard: null,
        currentDraw: null,
        pendingClaim: null,
        winner: null,
        outcome: null,
        instantScoreLog: [],
        chuiFeng: createChuiFengState(),
        aiSpeedMode: AI_SPEED_MODE.NORMAL,
        botActionReadyAt: 0,
        botClaimReadyAt: 0,
        seatControls: createSeatControlMap(seats),
        lastAction: {
            type: 'ROUND_START',
            seatId: dealerSeat,
            payload: {},
            ts: now
        },
        actionLog: []
    };

    for (const seatId of SEAT_IDS) {
        state.hands[seatId] = state.wall.splice(0, 16);
        normalizeFlowersInHand(state, seatId, now);
        state.hands[seatId] = sortTiles(state.hands[seatId], state.goldTile);
    }

    drawNonFlowerToHand(state, String(dealerSeat), now, 'NORMAL');
    state.hands[String(dealerSeat)] = sortTiles(state.hands[String(dealerSeat)], state.goldTile);
    forceHostOpeningGoldCount(state, seats, hostUid, forcedHostGoldCount, hostSeatId);
    return state;
}

function createNextRoundState(previousState, now = Date.now(), options = {}) {
    const forcedHostGoldCount = normalizeForcedHostGoldCount(options?.forcedHostGoldCount);
    const hostUid = typeof options?.hostUid === 'string' && options.hostUid
        ? options.hostUid
        : null;
    const hostSeatId = normalizeSeatId(options?.hostSeatId);
    const nextState = createInitialGameState({
        seats: seatControlMapToSeatStub(previousState.seatControls || {}),
        dealerSeat: previousState.dealerSeat || 0,
        dealerStreak: previousState.dealerStreak || 0,
        scores: previousState.scores || [0, 0, 0, 0],
        now,
        roundNo: (previousState.roundNo || 1) + 1,
        hostUid,
        forcedHostGoldCount,
        hostSeatId
    });

    const previousInstantLog = Array.isArray(previousState?.instantScoreLog) ? previousState.instantScoreLog : [];
    nextState.instantScoreLog = previousInstantLog.slice(-MAX_INSTANT_SCORE_LOG_SIZE);
    nextState.aiSpeedMode = normalizeAiSpeedMode(previousState?.aiSpeedMode);
    nextState.botActionReadyAt = 0;
    nextState.botClaimReadyAt = 0;
    return nextState;
}

export function createOnlineGameState(config = {}) {
    return createInitialGameState(config);
}

export function syncSeatControlsToGameState(gameState, seats = {}, now = Date.now()) {
    const state = normalizeRuntimeStateShape(clone(gameState || {}), now);
    state.seatControls = createSeatControlMap(seats);
    state.updatedAt = now;
    return state;
}

export function applyOnlineGameAction(gameState, action, now = Date.now()) {
    const current = normalizeRuntimeStateShape(clone(gameState || {}), now);
    if (!action || !action.type) return current;

    if (action.type === 'ROUND_START') {
        const forcedHostGoldCount = normalizeForcedHostGoldCount(action?.payload?.forcedHostGoldCount);
        const hostUid = typeof action?.payload?.hostUid === 'string' && action.payload.hostUid
            ? action.payload.hostUid
            : null;
        const hostSeatId = normalizeSeatId(action?.payload?.hostSeatId);
        const nextRoundOptions = {
            forcedHostGoldCount,
            hostUid,
            hostSeatId
        };
        if (current.phase === 'ended' || !current.hands) {
            return createNextRoundState(current, now, nextRoundOptions);
        }
        markAction(current, action, now);
        return current;
    }

    if (action.type === 'OPEN_GOLD') {
        const actionSeatNo = Number.isInteger(action.seatId) ? action.seatId : current.dealerSeat;
        const canOpen = current.phase === 'playing'
            && current.goldRevealed === false
            && Number(actionSeatNo) === Number(current.dealerSeat);
        if (canOpen) {
            revealGoldTile(current, now, actionSeatNo);
        }
        markAction(current, action, now);
        return current;
    }

    if (action.type === 'SET_AI_SPEED') {
        const mode = normalizeAiSpeedMode(action?.payload?.mode);
        current.aiSpeedMode = mode;
        current.botActionReadyAt = 0;
        current.botClaimReadyAt = 0;
        markAction(current, action, now);
        return current;
    }

    if (current.phase !== 'playing') {
        markAction(current, action, now);
        return current;
    }

    if (current.goldRevealed === false) {
        markAction(current, action, now);
        return current;
    }

    if (isReactionAction(action.type) && current.pendingClaim) {
        return applyReactionAction(current, action, now);
    }

    const actionSeatNo = Number.isInteger(action.seatId) ? action.seatId : current.turnSeat;
    if (action.type !== 'HU' && actionSeatNo === current.turnSeat && isMandatorySanJinHu(current, actionSeatNo)) {
        markAction(current, action, now);
        return current;
    }

    if (action.type === 'HU') {
        const seatNo = Number.isInteger(action.seatId) ? action.seatId : current.turnSeat;
        if (seatNo === current.turnSeat) {
            const huInfo = canHuSelfDraw(current, seatNo);
            if (huInfo.canHu) {
                settleWin(current, {
                    winnerSeat: seatNo,
                    isSelfDraw: true,
                    reason: 'SELF_HU',
                    winTile: current.currentDraw?.tile || null,
                    specialTypes: huInfo.types,
                    now,
                    drawnTile: current.currentDraw?.tile || null
                });
            }
        }
        markAction(current, action, now);
        return current;
    }

    if (action.type === 'AN_GANG') {
        const ok = applyAnGangAction(current, action, now);
        markAction(current, action, now);
        if (!ok) return current;
        return current;
    }

    if (action.type === 'BU_GANG') {
        const ok = applyBuGangAction(current, action, now);
        markAction(current, action, now);
        if (!ok) return current;
        return current;
    }

    if (current.pendingClaim) {
        markAction(current, action, now);
        return current;
    }

    if (action.type === 'DISCARD') {
        return applyDiscardAction(current, action, now);
    }

    if (action.type === 'DRAW') {
        const seatNo = Number.isInteger(action.seatId) ? action.seatId : current.turnSeat;
        drawNonFlowerToHand(current, String(seatNo), now, 'NORMAL');
        current.hands[String(seatNo)] = sortTiles(current.hands[String(seatNo)], current.goldTile);
        markAction(current, action, now);
        return current;
    }

    if (action.type === 'FLOWER_REPLENISH') {
        const seatNo = Number.isInteger(action.seatId) ? action.seatId : current.turnSeat;
        drawNonFlowerToHand(current, String(seatNo), now, 'FLOWER');
        current.hands[String(seatNo)] = sortTiles(current.hands[String(seatNo)], current.goldTile);
        markAction(current, action, now);
        return current;
    }

    markAction(current, action, now);
    return current;
}

export function runBotTurns(gameState, seats = {}, now = Date.now(), maxSteps = 12) {
    let state = syncSeatControlsToGameState(gameState, seats, now);
    state.botActionReadyAt = Number.isFinite(Number(state.botActionReadyAt || 0))
        ? Number(state.botActionReadyAt || 0)
        : 0;
    state.botClaimReadyAt = Number.isFinite(Number(state.botClaimReadyAt || 0))
        ? Number(state.botClaimReadyAt || 0)
        : 0;
    let appliedSteps = 0;

    if (state.phase === 'ended') {
        state.botActionReadyAt = 0;
        state.botClaimReadyAt = 0;
        return { state, appliedSteps };
    }

    while (state.phase === 'playing' && appliedSteps < maxSteps) {
        const tick = now + appliedSteps;

        if (state.goldRevealed === false) {
            state.botActionReadyAt = 0;
            state.botClaimReadyAt = 0;
            break;
        }

        if (state.pendingClaim) {
            autoDecideBotClaims(state);
            const pending = state.pendingClaim;
            const hasUndecidedSeat = !!getActivePendingSeatId(state, pending);
            const claimReadyAt = Number(state.botClaimReadyAt || 0);
            if (!claimReadyAt) {
                if (hasUndecidedSeat) {
                    const claimDelay = getBotClaimDelayMs(state);
                    if (claimDelay > 0) {
                        state.botClaimReadyAt = tick + claimDelay;
                        break;
                    }
                }
                state.botClaimReadyAt = tick;
            }
            if (tick < Number(state.botClaimReadyAt || 0)) break;

            const resolved = resolvePendingClaimIfReady(state, tick, false);
            state.botClaimReadyAt = 0;
            if (resolved) {
                appliedSteps += 1;
                state.botActionReadyAt = tick + getBotActionDelayMs(state);
                continue;
            }
            break;
        }
        state.botClaimReadyAt = 0;

        const seatId = String(state.turnSeat);
        const control = state.seatControls?.[seatId];
        if (control !== 'bot') {
            state.botActionReadyAt = 0;
            state.botClaimReadyAt = 0;
            break;
        }

        const readyAt = Number(state.botActionReadyAt || 0);
        if (!readyAt) {
            const actionDelay = getBotActionDelayMs(state);
            if (actionDelay > 0) {
                state.botActionReadyAt = tick + actionDelay;
                break;
            }
            state.botActionReadyAt = tick;
        }
        if (tick < Number(state.botActionReadyAt || 0)) break;

        const huInfo = canHuSelfDraw(state, seatId);
        if (huInfo.canHu) {
            state = applyOnlineGameAction(state, {
                type: 'HU',
                seatId: Number(seatId),
                payload: { reason: 'AUTO_BOT_SELF_HU' },
                ts: tick
            }, tick);
            appliedSteps += 1;
            state.botActionReadyAt = tick + getBotActionDelayMs(state);
            continue;
        }

        const buGangOptions = getBuGangOptions(state, seatId);
        if (buGangOptions.length) {
            state = applyOnlineGameAction(state, {
                type: 'BU_GANG',
                seatId: Number(seatId),
                payload: { char: buGangOptions[0], reason: 'AUTO_BOT_BU_GANG' },
                ts: tick
            }, tick);
            appliedSteps += 1;
            state.botActionReadyAt = tick + getBotActionDelayMs(state);
            continue;
        }

        const anGangOptions = getAnGangOptions(state, seatId);
        if (anGangOptions.length) {
            state = applyOnlineGameAction(state, {
                type: 'AN_GANG',
                seatId: Number(seatId),
                payload: { char: anGangOptions[0], reason: 'AUTO_BOT_AN_GANG' },
                ts: tick
            }, tick);
            appliedSteps += 1;
            state.botActionReadyAt = tick + getBotActionDelayMs(state);
            continue;
        }

        const discardIndex = chooseBotDiscardIndex(state, seatId);
        if (discardIndex < 0) break;

        state = applyOnlineGameAction(state, {
            type: 'DISCARD',
            seatId: Number(seatId),
            payload: { index: discardIndex, reason: 'AUTO_BOT' },
            ts: tick
        }, tick);

        appliedSteps += 1;
        state.botActionReadyAt = tick + getBotActionDelayMs(state);
        if (!state.wall.length) break;
    }

    return { state, appliedSteps };
}

export function getSelfDrawHuInfo(gameState, seatId) {
    return canHuSelfDraw(gameState, seatId);
}

export function hasMandatorySanJinHu(gameState, seatId) {
    return isMandatorySanJinHu(gameState, seatId);
}

