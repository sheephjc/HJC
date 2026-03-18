function parseLogicCode(code) {
    if (typeof code !== 'string' || code.length < 2) return null;
    const suit = code[0];
    const value = Number.parseInt(code.slice(1), 10);
    if (!Number.isFinite(value)) return null;
    return { suit, value };
}

function buildLogicCode(suit, value) {
    return `${suit}${value}`;
}

function pushType(types, value) {
    if (!types.includes(value)) types.push(value);
}

export function buildCountsWithoutGold(tiles = [], { isGoldTile, logicCodeOf }) {
    const counts = {};
    for (const tile of tiles) {
        if (isGoldTile(tile)) continue;
        const key = logicCodeOf(tile);
        if (!key) continue;
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

export function canSearchMelds(counts = {}, golds = 0) {
    const keys = Object.keys(counts).filter((key) => counts[key] > 0).sort();
    if (!keys.length) return true;

    const key = keys[0];
    const parsed = parseLogicCode(key);
    if (!parsed) return false;

    if ((counts[key] || 0) >= 3) {
        counts[key] -= 3;
        if (canSearchMelds(counts, golds)) return true;
        counts[key] += 3;
    }

    if (golds >= 1 && (counts[key] || 0) >= 2) {
        counts[key] -= 2;
        if (canSearchMelds(counts, golds - 1)) return true;
        counts[key] += 2;
    }

    if (golds >= 2 && (counts[key] || 0) >= 1) {
        counts[key] -= 1;
        if (canSearchMelds(counts, golds - 2)) return true;
        counts[key] += 1;
    }

    if (['W', 'T', 'S'].includes(parsed.suit)) {
        const k2 = buildLogicCode(parsed.suit, parsed.value + 1);
        const k3 = buildLogicCode(parsed.suit, parsed.value + 2);

        if ((counts[k2] || 0) > 0 && (counts[k3] || 0) > 0) {
            counts[key] -= 1;
            counts[k2] -= 1;
            counts[k3] -= 1;
            if (canSearchMelds(counts, golds)) return true;
            counts[key] += 1;
            counts[k2] += 1;
            counts[k3] += 1;
        }

        if (golds >= 1) {
            if ((counts[k2] || 0) > 0) {
                counts[key] -= 1;
                counts[k2] -= 1;
                if (canSearchMelds(counts, golds - 1)) return true;
                counts[key] += 1;
                counts[k2] += 1;
            }
            if ((counts[k3] || 0) > 0) {
                counts[key] -= 1;
                counts[k3] -= 1;
                if (canSearchMelds(counts, golds - 1)) return true;
                counts[key] += 1;
                counts[k3] += 1;
            }
        }
    }

    if (golds >= 3) {
        if (canSearchMelds(counts, golds - 3)) return true;
    }

    return false;
}

export function canHuPattern(tiles = [], resolvers = {}) {
    const { isGoldTile, logicCodeOf } = resolvers;
    const full = Array.isArray(tiles) ? tiles : [];
    const golds = full.filter((tile) => isGoldTile(tile)).length;
    if (full.length < 2) return false;

    const counts = buildCountsWithoutGold(full, { isGoldTile, logicCodeOf });
    for (const key of Object.keys(counts)) {
        if ((counts[key] || 0) >= 2) {
            const next = { ...counts };
            next[key] -= 2;
            if (canSearchMelds(next, golds)) return true;
        } else if ((counts[key] || 0) >= 1 && golds >= 1) {
            const next = { ...counts };
            next[key] -= 1;
            if (canSearchMelds(next, golds - 1)) return true;
        }
    }

    if (golds >= 2 && canSearchMelds({ ...counts }, golds - 2)) return true;
    return false;
}

export function canHuAsYouJin(fullHand = [], drawnTile = null, resolvers = {}) {
    const { isGoldTile, logicCodeOf, removeDrawnTile } = resolvers;
    if (!drawnTile) return false;

    const beforeDraw = [...fullHand];
    if (!removeDrawnTile(beforeDraw, drawnTile)) return false;

    const goldsBeforeDraw = beforeDraw.filter((tile) => isGoldTile(tile)).length;
    if (goldsBeforeDraw < 1 || goldsBeforeDraw > 2) return false;

    const handCopy = [...beforeDraw];
    const goldIdx = handCopy.findIndex((tile) => isGoldTile(tile));
    if (goldIdx < 0) return false;
    handCopy.splice(goldIdx, 1);

    const remGolds = handCopy.filter((tile) => isGoldTile(tile)).length;
    const counts = buildCountsWithoutGold(handCopy, { isGoldTile, logicCodeOf });
    return canSearchMelds(counts, remGolds);
}

export function appendDrawBonusTypes(types = [], drawReason = 'NORMAL') {
    const reason = String(drawReason || 'NORMAL');
    if (reason === 'GANG' || reason === 'GANG_FLOWER') {
        pushType(types, '杠上开花');
    }
    if (reason === 'FLOWER' || reason === 'GANG_FLOWER') {
        pushType(types, '花开富贵');
    }
    return types;
}

export function evaluateHuInfo(params = {}) {
    const {
        hand = [],
        extraTile = null,
        isSelfDraw = false,
        winnerSeat = 0,
        dealerSeat = 0,
        roundCount = 0,
        drawnTile = null,
        drawReason = 'NORMAL',
        isGoldTile,
        logicCodeOf,
        removeDrawnTile
    } = params;

    const full = [...hand];
    if (extraTile) full.push(extraTile);

    const result = { canHu: false, types: [] };
    const golds = full.filter((tile) => isGoldTile(tile)).length;

    if (golds >= 2 && !isSelfDraw) return result;

    const resolvers = { isGoldTile, logicCodeOf, removeDrawnTile };
    const isFirstRound = roundCount === 0;
    const getTianDiType = () => (winnerSeat === dealerSeat ? '天胡' : '地胡');

    if (golds >= 3) {
        result.canHu = true;
        const canAlsoTianDiHu = isFirstRound && canHuPattern(full, resolvers);
        if (canAlsoTianDiHu) {
            pushType(result.types, getTianDiType());
        } else {
            pushType(result.types, '三金倒');
        }
        appendDrawBonusTypes(result.types, drawReason);
        return result;
    }

    if (isSelfDraw && golds >= 1 && canHuAsYouJin(full, drawnTile, resolvers)) {
        result.canHu = true;
        pushType(result.types, '游金');
        appendDrawBonusTypes(result.types, drawReason);
        return result;
    }

    if (canHuPattern(full, resolvers)) {
        result.canHu = true;
    }

    if (result.canHu) {
        if (isFirstRound && !result.types.includes('天胡') && !result.types.includes('地胡')) {
            pushType(result.types, getTianDiType());
        }
        appendDrawBonusTypes(result.types, drawReason);
    }

    return result;
}
