import { evaluateHuInfo } from '../shared/hu-rules.js';
import {
    setupActionAudioUnlock,
    getActionVoiceProfile,
    playActionVoice
} from '../effects/action-audio.js';
import { startHuParticles, stopHuParticles } from '../effects/hu-particles.js';
import {
    renderBoardView,
    renderScoresView,
    renderWinTextView,
    openRuleModalView,
    closeRuleModalView
} from '../ui/render-view.js';
import {
    resetRoundVisualStateView,
    setGoldDisplayView,
    hideActionBarView,
    showActionBarView,
    showChiSubMenuView,
    isActionBarVisibleView,
    showCenterFlashTextView,
    showPlayerActionEffectView
} from '../ui/action-bar-view.js';
import { showHuOverlayView } from '../ui/hu-overlay-view.js';

    const TILE_TYPES = { W:0, T:1, S:2, Z:3, H:4 };
    const MAHJONG_TILES = {
        W: ['🀇','🀈','🀉','🀊','🀋','🀌','🀍','🀎','🀏'],
        T: ['🀙','🀚','🀛','🀜','🀝','🀞','🀟','🀠','🀡'],
        S: ['🀐','🀑','🀒','🀓','🀔','🀕','🀖','🀗','🀘'],
        Z: ['🀀','🀁','🀂','🀃','🀄','🀅','🀆']
    };

    let state = {
        deck: [], gold: null, turn: 0, dealer: 0,
actionQueue: [], // 新增：用于存放待处理的玩家响应
winnerInfo: null,
dealerStreak: 0,
roundCount: 0,
        scores: [0, 0, 0, 0],
        players: [
            { id: 'bottom', hand: [], river: [], show: [], lastDraw: null },
            { id: 'right', hand: [], river: [], show: [], lastDraw: null },
            { id: 'top', hand: [], river: [], show: [], lastDraw: null },
            { id: 'left', hand: [], river: [], show: [], lastDraw: null }
        ],
        selectedIndex: -1, waitingAction: false, lastDiscard: null, 
        currentActions: null, isGameOver: false,
        winningTile: null, // 自摸或点炮的牌对象
	        chuiFeng: {
            dealerDiscardCount: 0,
            targetChar: null,
            followCount: 0,
            active: false,
		 failed: false
        },
        pendingDealerUpdate: null,
        forcedBottomGoldCount: 0
    };
    const runtime = {
        uiEnabled: true,
        timersEnabled: true,
        alertsEnabled: true
    };

    function defer(callback, delay = 0) {
        if (runtime.timersEnabled) return setTimeout(callback, delay);
        callback();
        return null;
    }

    function withRuntimeOptions(options, runner) {
        const prev = { ...runtime };
        if (options && typeof options === 'object') {
            if (typeof options.uiEnabled === 'boolean') runtime.uiEnabled = options.uiEnabled;
            if (typeof options.timersEnabled === 'boolean') runtime.timersEnabled = options.timersEnabled;
            if (typeof options.alertsEnabled === 'boolean') runtime.alertsEnabled = options.alertsEnabled;
        }
        try {
            return runner();
        } finally {
            runtime.uiEnabled = prev.uiEnabled;
            runtime.timersEnabled = prev.timersEnabled;
            runtime.alertsEnabled = prev.alertsEnabled;
        }
    }

    const WHITE_DRAGON_CHAR = '🀆';

    function isGoldTile(tile) {
        return !!tile && !!state.gold && tile.char === state.gold.char;
    }

    function getTileKey(tile) {
        const logic = getLogic(tile);
        return logic ? (logic.type + logic.val) : '';
    }

    function isSameLogicTile(a, b) {
        if (!a || !b) return false;
        return getTileKey(a) === getTileKey(b);
    }

    function getLogic(tile) {
        if (!tile) return null;
        // 金牌不是白板时，白板代替金牌原本身份（非万能）
        if (tile.char === WHITE_DRAGON_CHAR && state.gold && state.gold.char !== WHITE_DRAGON_CHAR) {
            return { ...state.gold, char: tile.char, id: tile.id };
        }
        return tile;
    }

    function toHuLogicCode(tile) {
        const logic = getLogic(tile);
        if (!logic) return '';
        return `${logic.type}${logic.val + 1}`;
    }

    function sortHand(pIdx) {
        state.players[pIdx].hand.sort((a, b) => {
            if (isGoldTile(a) && !isGoldTile(b)) return -1;
            if (!isGoldTile(a) && isGoldTile(b)) return 1;
            const la = getLogic(a), lb = getLogic(b);
            return (TILE_TYPES[la.type] - TILE_TYPES[lb.type]) || (la.val - lb.val);
        });
    }

function applyPendingDealerUpdate() {
    if (!state.pendingDealerUpdate) return;
    const { winnerIdx, dealer } = state.pendingDealerUpdate;
    if (winnerIdx === dealer) {
        state.dealerStreak++;
    } else {
        state.dealer = (dealer + 1) % 4;
        state.dealerStreak = 0;
    }
    state.pendingDealerUpdate = null;
    renderScores();
}

function forceBottomGoldTilesForTest(targetCount) {
    if (!Number.isInteger(targetCount) || targetCount <= 0) return;
    const bottom = state.players[0];
    const countGoldsInBottom = () => bottom.hand.filter(t => isGoldTile(t)).length;
    let need = targetCount - countGoldsInBottom();

    // 若当前金牌超出目标，先换出多余金牌。
    while (need < 0) {
        const bottomGoldIdx = bottom.hand.findIndex(t => isGoldTile(t));
        let replacement = null;
        let from = null;
        const deckNonGoldIdx = state.deck.findIndex(t => !isGoldTile(t));
        if (deckNonGoldIdx !== -1) {
            replacement = state.deck.splice(deckNonGoldIdx, 1)[0];
            from = 'deck';
        } else {
            for (let pIdx = 1; pIdx < 4; pIdx++) {
                const idx = state.players[pIdx].hand.findIndex(t => !isGoldTile(t));
                if (idx !== -1) {
                    replacement = state.players[pIdx].hand.splice(idx, 1)[0];
                    from = pIdx;
                    break;
                }
            }
        }
        if (bottomGoldIdx === -1 || !replacement) break;
        const out = bottom.hand[bottomGoldIdx];
        bottom.hand[bottomGoldIdx] = replacement;
        if (from === 'deck') {
            state.deck.push(out);
        } else {
            state.players[from].hand.push(out);
        }
        need++;
    }

    if (need <= 0) return;

    // 优先从牌堆换入金牌，保证对局其他逻辑不变。
    while (need > 0) {
        const deckGoldIdx = state.deck.findIndex(t => isGoldTile(t));
        const bottomNonGoldIdx = bottom.hand.findIndex(t => !isGoldTile(t));
        if (deckGoldIdx === -1 || bottomNonGoldIdx === -1) break;
        const goldFromDeck = state.deck.splice(deckGoldIdx, 1)[0];
        const replaced = bottom.hand[bottomNonGoldIdx];
        bottom.hand[bottomNonGoldIdx] = goldFromDeck;
        state.deck.push(replaced);
        need--;
    }

    // 牌堆金牌不足时，再与其余玩家手牌交换。
    if (need > 0) {
        for (let pIdx = 1; pIdx < 4 && need > 0; pIdx++) {
            const other = state.players[pIdx];
            while (need > 0) {
                const otherGoldIdx = other.hand.findIndex(t => isGoldTile(t));
                const bottomNonGoldIdx = bottom.hand.findIndex(t => !isGoldTile(t));
                if (otherGoldIdx === -1 || bottomNonGoldIdx === -1) break;
                const temp = bottom.hand[bottomNonGoldIdx];
                bottom.hand[bottomNonGoldIdx] = other.hand[otherGoldIdx];
                other.hand[otherGoldIdx] = temp;
                need--;
            }
        }
    }
}

function applyForcedBottomGoldForTest() {
    const target = state.forcedBottomGoldCount;
    if (!target || target <= 0) return;
    forceBottomGoldTilesForTest(target);

    // 若南家为庄，确保开局补摸第一张不是金牌，避免目标张数被随机+1。
    if (state.dealer === 0) {
        const nonGoldTopIdx = state.deck.findIndex(t => !isGoldTile(t));
        if (nonGoldTopIdx > 0) {
            [state.deck[0], state.deck[nonGoldTopIdx]] = [state.deck[nonGoldTopIdx], state.deck[0]];
        }
    }

    state.forcedBottomGoldCount = 0;
    for (let i = 0; i < 4; i++) sortHand(i);
}

// helper to reset pending reactions
function clearActionQueue() {
    state.actionQueue = [];
    state.currentActions = null;
    state.waitingAction = false;
}

    function nextRound() {
        // 进入下一局，但保持分数和庄家状态
        applyPendingDealerUpdate();
        state.winnerInfo = null;
        state.winningTile = null;
        resetRoundVisualStateView();
        // ===== 重置所有动作状态 =====
        state.waitingAction = false;
        state.currentActions = null;
        clearActionQueue();
        state.qiangGangPending = null;
        state.chuiFeng = { dealerDiscardCount: 0, targetChar: null, followCount: 0, active: false };
        state.isGameOver = false;
        
        // 重新洗牌
        let d = [];
        for(let t in MAHJONG_TILES) MAHJONG_TILES[t].forEach((char, idx) => { for(let i=0; i<4; i++) d.push({char, type:t, val:idx, id: Math.random()}); });
        ['🀢','🀣','🀤','🀥','🀦','🀧','🀨','🀩'].forEach((char, idx) => d.push({char, type:'H', val:idx, id: Math.random()}));
        
        state.deck = d.sort(() => Math.random() - 0.5);
        let goldTile = state.deck.shift();
        while(goldTile.type === 'H') { state.deck.push(goldTile); goldTile = state.deck.shift(); }
        state.gold = goldTile;
        setGoldDisplayView(state.gold.char);

        state.roundCount = 0;
        state.lastDiscard = null;
        state.waitingAction = false;
        state.players.forEach((p, idx) => {
            p.hand = state.deck.splice(0, 16);
            p.river = []; p.show = []; p.lastDraw = null;
            handleFlowers(idx);
            sortHand(idx);
        });
        applyForcedBottomGoldForTest();

        state.turn = state.dealer;
        drawTile(state.turn);
        render();
        renderScores();
    }

    function resetAll() { 
        // 重置所有状态，包括分数和庄家
        state.scores = [0,0,0,0]; 
        state.dealer = 0;
        state.dealerStreak = 0;
        state.pendingDealerUpdate = null;
        initGame();
    }

function resetScores() { 
    state.scores = [0,0,0,0]; 
    state.dealer = 0;
    state.dealerStreak = 0;
    state.pendingDealerUpdate = null;
    renderScores(); 
}
function renderScores() {
    if (!runtime.uiEnabled) return;
    renderScoresView(state);
}

// 打开弹窗
function openRuleModal(id) {
    if (!runtime.uiEnabled) return;
    openRuleModalView(id);
}

// 关闭弹窗 (支持传入 ID 或 元素本身对象)
function closeRuleModal(param) {
    if (!runtime.uiEnabled) return;
    closeRuleModalView(param);
}

function initGame() {
applyPendingDealerUpdate();
state.winnerInfo = null;
    state.winningTile = null;
resetRoundVisualStateView();
    // ===== 重置所有动作状态 =====
    state.waitingAction = false;
    state.currentActions = null;
    clearActionQueue();
    state.qiangGangPending = null;
    // 注意：这里不重置 dealerStreak 和 dealer，让它们保持
        state.chuiFeng = { dealerDiscardCount: 0, targetChar: null, followCount: 0, active: false };
        state.isGameOver = false;
        let d = [];
        for(let t in MAHJONG_TILES) MAHJONG_TILES[t].forEach((char, idx) => { for(let i=0; i<4; i++) d.push({char, type:t, val:idx, id: Math.random()}); });
        ['🀢','🀣','🀤','🀥','🀦','🀧','🀨','🀩'].forEach((char, idx) => d.push({char, type:'H', val:idx, id: Math.random()}));
        
        state.deck = d.sort(() => Math.random() - 0.5);
        let goldTile = state.deck.shift();
        while(goldTile.type === 'H') { state.deck.push(goldTile); goldTile = state.deck.shift(); }
        state.gold = goldTile;
        setGoldDisplayView(state.gold.char);

        state.roundCount = 0;
        state.lastDiscard = null;
        state.waitingAction = false;
	        state.players.forEach((p, idx) => {
            p.hand = state.deck.splice(0, 16);
            p.river = []; p.show = []; p.lastDraw = null;
            handleFlowers(idx);
            sortHand(idx);
        });
        applyForcedBottomGoldForTest();

        state.turn = state.dealer;
        drawTile(state.turn);
        render();
        renderScores();
    }

function checkChuiFengLogic(pIdx, tileChar) {

    // 庄家出前两手
    if (pIdx === state.dealer) {

        state.chuiFeng.dealerDiscardCount++;

        if (state.chuiFeng.dealerDiscardCount <= 2) {

            state.chuiFeng.targetChar = tileChar;
            state.chuiFeng.followCount = 1;
            state.chuiFeng.active = true;
            state.chuiFeng.failed = false;

        } else {
            state.chuiFeng.active = false;
        }

        return;
    }

    // 闲家阶段
    if (!state.chuiFeng.active || state.chuiFeng.failed) return;

    if (tileChar === state.chuiFeng.targetChar) {

        state.chuiFeng.followCount++;

        if (state.chuiFeng.followCount === 4) {
            executeChuiFengSettlement();
            state.chuiFeng.active = false;
        }

    } else {
        // 🔥 有人没跟，直接失败
        state.chuiFeng.failed = true;
        state.chuiFeng.active = false;
    }
}

    function executeChuiFengSettlement() {
        state.scores[state.dealer] -= 3;
        for (let i = 0; i < 4; i++) {
            if (i !== state.dealer) state.scores[i] += 1;
        }
        renderScores();
        showChuiFengEffect();
    }

    function showChuiFengEffect() {
        if (!runtime.uiEnabled) return;
        showCenterFlashTextView('吹风');
    }

function normalizeDrawReason(drawReason = 'NORMAL') {
    if (drawReason === true) return 'GANG';
    if (drawReason === false || drawReason === null || drawReason === undefined) return 'NORMAL';
    const normalized = String(drawReason).toUpperCase();
    if (normalized === 'NORMAL' || normalized === 'GANG' || normalized === 'FLOWER') return normalized;
    return 'NORMAL';
}

function buildDrawHuFlags(drawReason = 'NORMAL', gotNewFlower = false) {
    const reason = normalizeDrawReason(drawReason);
    return {
        isGang: reason === 'GANG',
        isFlower: !!gotNewFlower || reason === 'FLOWER'
    };
}

    function drawTile(pIdx, drawReason = 'NORMAL') {
        if(state.deck.length === 0) {
            if (runtime.alertsEnabled && typeof alert !== 'undefined') alert("流局了！");
            initGame();
            return;
        }
        const p = state.players[pIdx];
        state.players.forEach(pl => pl.lastDraw = null);
        
        const tile = state.deck.shift();
        p.hand.push(tile);
        p.lastDraw = tile;
        
        let gotNewFlower = handleFlowers(pIdx);
        const drawHuFlags = buildDrawHuFlags(drawReason, gotNewFlower);
        
        if(pIdx === 0) {
            checkSelfOptions(drawHuFlags); 
        } else {
            let hu = checkHuInfo(pIdx, null, true, drawHuFlags.isGang, drawHuFlags.isFlower);
            if(hu.canHu) {
                defer(() => settle(pIdx, pIdx, true, hu.types), 600);
            } else {
                defer(() => aiAction(pIdx), 800);
            }
        }
        render();
    }

	    function handleFlowers(pIdx) {
        let p = state.players[pIdx];
        let found = false;
        for (let i = p.hand.length - 1; i >= 0; i--) {
            if (p.hand[i].type === 'H') {
                p.show.push({type:'FLOWER', tiles:[p.hand.splice(i, 1)[0]]});
                found = true;
                if(state.deck.length > 0) {
                    const next = state.deck.shift();
                    p.hand.push(next);
                    if(pIdx === 0) p.lastDraw = next;
                    handleFlowers(pIdx);
                }
            }
        }
        sortHand(pIdx);
        return found;
    }

function removeOneTileByRef(tiles, target) {
    if (!target) return false;
    let idx = -1;
    if (target.id !== undefined && target.id !== null) {
        idx = tiles.findIndex(t => t.id === target.id);
    }
    if (idx < 0) idx = tiles.indexOf(target);
    if (idx < 0) {
        idx = tiles.findIndex(t => t.char === target.char && t.type === target.type && t.val === target.val);
    }
    if (idx < 0) return false;
    tiles.splice(idx, 1);
    return true;
}

function getYouJinDebugInfo(fullHand, drawnTile) {
    const info = {
        ok: false,
        reason: "",
        drawn: drawnTile ? drawnTile.char : null,
        goldChar: state.gold ? state.gold.char : null,
        fullHand: fullHand.map(t => t.char),
        beforeDraw: [],
        remaining: [],
        remGolds: 0,
        counts: {},
        goldsBeforeDraw: 0
    };

    if (!drawnTile) {
        info.reason = "缺少本次摸牌(drawnTile)";
        return info;
    }

    const beforeDraw = fullHand.slice();
    if (!removeOneTileByRef(beforeDraw, drawnTile)) {
        info.reason = "手牌中找不到本次摸牌，无法还原摸牌前手牌";
        return info;
    }
    info.beforeDraw = beforeDraw.map(t => t.char);

    const goldsBeforeDraw = beforeDraw.filter(t => isGoldTile(t)).length;
    info.goldsBeforeDraw = goldsBeforeDraw;
    if (goldsBeforeDraw < 1 || goldsBeforeDraw > 2) {
        info.reason = `摸牌前金牌数=${goldsBeforeDraw}，不在[1,2]`;
        return info;
    }

    const handCopy = beforeDraw.slice();
    const goldIdx = handCopy.findIndex(t => isGoldTile(t));
    if (goldIdx < 0) {
        info.reason = "摸牌前没有可用于作将的金牌";
        return info;
    }
    handCopy.splice(goldIdx, 1);

    const remGolds = handCopy.filter(t => isGoldTile(t)).length;
    info.remGolds = remGolds;
    info.remaining = handCopy.map(t => t.char);

    const cnts = {};
    handCopy
        .filter(t => !isGoldTile(t))
        .map(t => getLogic(t))
        .forEach(t => {
            const k = t.type + t.val;
            cnts[k] = (cnts[k] || 0) + 1;
        });
    info.counts = { ...cnts };

    const ok = canSearch({ ...cnts }, remGolds);
    info.ok = ok;
    info.reason = ok ? "满足游金：摸牌+金作将后，剩余可成3n" : "不满足游金：摸牌+金作将后，剩余无法成3n";
    return info;
}

function canHuAsYouJin(fullHand, drawnTile) {
    return getYouJinDebugInfo(fullHand, drawnTile).ok;
}

function checkHuInfo(pIdx, extraTile = null, isSelfDraw = false, isGang = false, isFlower = false) {
    const p = state.players[pIdx];
    const drawReason = isGang && isFlower ? 'GANG_FLOWER' : (isGang ? 'GANG' : (isFlower ? 'FLOWER' : 'NORMAL'));
    return evaluateHuInfo({
        hand: p.hand,
        extraTile,
        isSelfDraw,
        winnerSeat: pIdx,
        dealerSeat: state.dealer,
        roundCount: state.roundCount,
        drawnTile: extraTile || p.lastDraw || null,
        drawReason,
        isGoldTile,
        logicCodeOf: toHuLogicCode,
        removeDrawnTile: (tiles, tile) => removeOneTileByRef(tiles, tile)
    });
}

    function canSearch(counts, g) {
        let keys = Object.keys(counts).filter(k => counts[k] > 0).sort();
        if(keys.length === 0) return true;
        let k = keys[0];
        let type = k[0], val = parseInt(k.substring(1));
        if(counts[k] >= 3) { counts[k] -= 3; if(canSearch(counts, g)) return true; counts[k] += 3; }
        if(g >= 1 && counts[k] >= 2) { counts[k] -= 2; if(canSearch(counts, g-1)) return true; counts[k] += 2; }
        if(g >= 2 && counts[k] >= 1) { counts[k] -= 1; if(canSearch(counts, g-2)) return true; counts[k] += 1; }
        if(['W','T','S'].includes(type)) {
            let k2 = type + (val+1), k3 = type + (val+2);
            if(counts[k2] > 0 && counts[k3] > 0) {
                counts[k]--; counts[k2]--; counts[k3]--;
                if(canSearch(counts, g)) return true;
                counts[k]++; counts[k2]++; counts[k3]++;
            }
            if(g >= 1) {
                if(counts[k2] > 0) { counts[k]--; counts[k2]--; if(canSearch(counts, g-1)) return true; counts[k]++; counts[k2]++; }
                if(counts[k3] > 0) { counts[k]--; counts[k3]--; if(canSearch(counts, g-1)) return true; counts[k]++; counts[k3]++; }
            }
        }
        if(g >= 3) { if(canSearch(counts, g-3)) return true; }
        return false;
    }

    function playActionEffect(pIdx, text) {
        if (!runtime.uiEnabled) return;
        showPlayerActionEffectView(state.players[pIdx].id, text);
    }

function getBasePay(winner, payer, isSelfDraw) {

    const base = 1;
    const dealer = state.dealer;

    let pay = 0;

    // 庄家胡
    if (winner === dealer) {
        let mul = 1;
        // 只有连庄次数 ≥ 1 时才翻倍
        if (state.dealerStreak >= 1) {
            mul = Math.pow(2, state.dealerStreak);
        }
        pay = base * 2 * mul;
    }

    // 闲家胡
    else {

        if (payer === dealer) {
            pay = base * 2;
        } else {
            pay = base;
        }
    }

    // 自摸 +1
    if (isSelfDraw) pay += 1;

    return pay;
}

function shouldApplySelfDrawBonus(winnerIdx, isSelfDraw, specialTypes = []) {
    if (!isSelfDraw) return false;
    // 三金倒：只有本次摸到金牌才算自摸+1；否则只算三金倒
    if (specialTypes.includes("三金倒")) {
        const drawn = state.players[winnerIdx]?.lastDraw || null;
        return !!drawn && isGoldTile(drawn);
    }
    // 其他（含游金）按正常自摸+1
    return true;
}

function settle(winnerIdx, loserIdx, isSelfDraw, specialTypes = []) {
    const scoreAsSelfDraw = shouldApplySelfDrawBonus(winnerIdx, isSelfDraw, specialTypes);

	state.winnerInfo = {
	    winner: winnerIdx,
	    loser: isSelfDraw ? null : loserIdx,
	    isSelfDraw: isSelfDraw,
        scoreAsSelfDraw: scoreAsSelfDraw,
        specialTypes: [...specialTypes]
	};
    state.isGameOver = true;
    render();

    const dealer = state.dealer;
    const streak = state.dealerStreak;

    // mark winning tile for highlighting later
    state.winningTile = isSelfDraw ? state.players[winnerIdx].lastDraw : state.lastDiscard;

    function getDealerWinMultiplier() {
        return Math.pow(2, streak + 1);
    }

    const flowerCount = state.players[winnerIdx].show
        .filter(g => g.type === 'FLOWER').length;

    const waterMul = getWaterMultiplier(flowerCount);
    let specialMul = getSpecialMultiplier(specialTypes);

    // 抢杠胡已经单独处理倍率
	    if (specialTypes.includes("抢杠胡")) {
        specialMul /= 2;
    }

    let totalWin = 0;

    if (specialTypes.includes("抢杠胡")) {

        let pay = getBasePay(winnerIdx, loserIdx, false);
        let finalScore = pay * waterMul * specialMul;

        state.scores[loserIdx] -= finalScore;
        state.scores[winnerIdx] += finalScore;
        totalWin = finalScore;

    } else {

	        for (let i = 0; i < 4; i++) {

            if (i === winnerIdx) continue;

	            let pay = getBasePay(winnerIdx, i, scoreAsSelfDraw);
	            let finalScore = pay * waterMul * specialMul;

            state.scores[i] -= finalScore;
            state.scores[winnerIdx] += finalScore;
            totalWin += finalScore;
        }
    }

	    renderScores();

	    // 先显示（使用原始的dealerStreak值）
	    showHuOverlay(winnerIdx, specialTypes, totalWin, flowerCount, isSelfDraw, scoreAsSelfDraw);

    // 结算展示后再更新连庄/换庄
    state.pendingDealerUpdate = { winnerIdx, dealer };
}

    function getWaterMultiplier(count) {
        if (count < 4) return 1;
        return Math.pow(2, count - 3);
    }

function getSpecialMultiplier(types){

    const map = {
        "游金":2,
        "三金倒":8,
        "天胡":8,
        "地胡":8,
        "杠上开花":2,
        "花开富贵":2,
        "抢杠胡":2
    };

    let mul = 1;

    // 如果有三金倒
    if(types.includes("三金倒")){

        mul *= 8;

        // 其他可叠加
        types.forEach(t=>{
            if(t==="三金倒") return;
            if(t==="游金") return;   // 游金不叠
            if(map[t]) mul *= map[t];
        });

        return mul;
    }

    // 普通叠加
    types.forEach(t=>{
        if(map[t]) mul *= map[t];
    });

    return mul;

}



function showHuOverlay(winnerIdx, specialTypes, totalWin, flowerCount, isSelfDraw, scoreAsSelfDraw) {
    if (!runtime.uiEnabled) return;
    showHuOverlayView({
        winnerIdx,
        specialTypes,
        totalWin,
        flowerCount,
        isSelfDraw,
        scoreAsSelfDraw,
        dealer: state.dealer,
        dealerStreak: state.dealerStreak,
        lastDiscarder: state.lastDiscarder ?? -1,
        getBasePay,
        onOverlayClose: () => {
            applyPendingDealerUpdate();
            stopHuParticles();
        },
        startHuParticles
    });
}

function normalizeSelfOptionDrawMeta(drawMeta = {}) {
    if (typeof drawMeta === 'boolean') {
        return { isGang: false, isFlower: drawMeta };
    }
    if (!drawMeta || typeof drawMeta !== 'object') {
        return { isGang: false, isFlower: false };
    }
    return {
        isGang: !!drawMeta.isGang,
        isFlower: !!drawMeta.isFlower
    };
}

    function checkSelfOptions(drawMeta = {}) {
        const p = state.players[0];
        const meta = normalizeSelfOptionDrawMeta(drawMeta);
        let hu = checkHuInfo(0, null, true, meta.isGang, meta.isFlower);
        const mustHu = hu.canHu && Array.isArray(hu.types) && hu.types.includes("三金倒");
        let acts = { HU: hu.canHu, AN_GANG: [], BU_GANG: [], huTypes: hu.types, isSelfDraw: true, mustHu };
        
        let counts = {};
        p.hand.forEach(t => { if(!isGoldTile(t)) counts[t.char] = (counts[t.char]||0)+1; });
        if (!mustHu) {
            for(let c in counts) if(counts[c]===4) acts.AN_GANG.push(c);
            p.hand.forEach(t => { if(p.show.some(g=>g.type==='PENG' && g.tiles[0].char===t.char)) acts.BU_GANG.push(t.char); });
        }
        
        if(acts.HU || acts.AN_GANG.length || acts.BU_GANG.length) {
            // 确保自摸胡时 isSelfDraw 始终为 true
            acts.isSelfDraw = true;
            showActionBar(acts);
        }
    }

// 抢杠胡检查：gangerIdx 是谁在杠，tileChar 是杠的那张牌，isAnGang 是否是暗杠
function checkQiangGang(gangerIdx, tileChar, isAnGang) {

    const tile = { char: tileChar };

    for (let i = 1; i < 4; i++) {
        let pIdx = (gangerIdx + i) % 4;

        // ❗用正确的胡牌检测函数
        let huInfo = checkHuInfo(pIdx, tile, false, false, false);

        if (huInfo.canHu) {

            if (pIdx === 0) {
                // 玩家抢杠：显示按钮并挂起状态
                state.waitingAction = true;
                state.qiangGangPending = { gangerIdx, char: tileChar, isAnGang };
                showActionBar({ HU: true, huTypes: ["抢杠胡"], isSelfDraw: false });
                return true;
            } else {
                // AI 抢杠：立即结算并清空任何挂起动作
                playActionVoice('HU');
                clearActionQueue();
                settle(pIdx, gangerIdx, false, ["抢杠胡"]);
                return true;
            }
        }
    }
    return false;
}    

function showActionBar(acts) {
    if (runtime.uiEnabled) primeActionVoiceEngine();
    state.currentActions = acts;
    if (runtime.uiEnabled) showActionBarView(acts);
    state.waitingAction = true;
}

function showChiSubMenu() {
    if (!runtime.uiEnabled) return;
    showChiSubMenuView(state, {
        getLogic,
        MAHJONG_TILES,
        isGoldChar: (ch) => !!state.gold && ch === state.gold.char
    });
}

function decodeActionPayload(payload) {
    if (payload === null || payload === undefined || payload === '') return undefined;
    try {
        return JSON.parse(payload);
    } catch {
        return payload;
    }
}

function handleActionButton(type, rawPayload) {
    if (!type) return;
    if (type === 'SHOW_CHI_MENU') {
        showChiSubMenu();
        return;
    }
    if (type === 'BACK_TO_ACTIONS') {
        showActionBar(state.currentActions || {});
        return;
    }
    const payload = decodeActionPayload(rawPayload);
    execute(type, payload);
}

	function execute(type, data) {
    if(state.isGameOver) return;
    const p = state.players[0];
    if (runtime.uiEnabled) hideActionBarView();
    state.waitingAction = false;

    if (['CHI', 'PENG', 'GANG', 'AN_GANG', 'BU_GANG', 'HU'].includes(type)) {
        playActionVoice(type);
    }

    // 胡牌处理
    if (type === 'HU') { 
        // 如果存在抢杠暂存信息
        if (state.qiangGangPending) {
            const info = state.qiangGangPending;
            settle(0, info.gangerIdx, false, ["抢杠胡"]); // 玩家抢杠胡结算
            state.qiangGangPending = null;
            clearActionQueue();
            return;
        }
        
        // 保存当前动作信息，因为 clearActionQueue() 会清空它
        const currentActs = state.currentActions;
        
        // 自摸胡：检查当前是否是玩家回合（如果是玩家回合，则是自摸）
        let isSelfDrawWin = state.turn === 0 || (currentActs && currentActs.isSelfDraw === true);
        // 兜底：以“动作栏缓存番型 + 实时胡牌检测番型”做并集，避免游金等番型在动作栏丢失
        const cachedTypes = Array.isArray(currentActs?.huTypes) ? currentActs.huTypes : [];
        const liveHu = checkHuInfo(0, isSelfDrawWin ? null : state.lastDiscard, isSelfDrawWin);
        const liveTypes = Array.isArray(liveHu?.types) ? liveHu.types : [];
        const huTypes = Array.from(new Set([...cachedTypes, ...liveTypes]));
        console.log('[HU execute] cachedTypes=', cachedTypes, 'liveTypes=', liveTypes, 'finalTypes=', huTypes, 'isSelfDrawWin=', isSelfDrawWin);
        if (isSelfDrawWin) {
            settle(0, null, true, huTypes);
        } else {
            // 点炮胡
            settle(0, state.turn, false, huTypes);
        }
        clearActionQueue();
        return; 
    }

    // 过 处理
	if (type === 'PASS') { 
if (state.currentActions?.mustHu) {
            render();
            return;
        }
// 如果玩家点“过”，且之前是在询问抢杠胡
    if (state.qiangGangPending) {
        const info = state.qiangGangPending;
        state.qiangGangPending = null;
        clearActionQueue();  // 清除等待状态
        // 恢复原本那个人的杠牌流程
        completeGangLogic(info.gangerIdx, info.char, info.isAnGang);
        return;
    }
if (state.turn === 0) {
            // 【核心修改】：如果是自摸点“过”
            // 只清空动作和队列，不执行 processActionQueue()
            clearActionQueue();
            render(); // 刷新界面，按钮会消失，你可以继续选牌打出
        } else {
            // 如果是别人出牌点“过”
            // 1. 移除队列中属于当前玩家(0号)的所有动作
            state.actionQueue = state.actionQueue.filter(a => a.pIdx !== 0);
            // 2. 处理剩下的最高优先级动作
            processActionQueue(); 
            render(); 
        }
        return; 
    }
    const typeMap = { 'PENG': '碰', 'GANG': '杠', 'CHI': '吃', 'AN_GANG': '暗杠', 'BU_GANG': '补杠' };
    playActionEffect(0, typeMap[type] || type);

    // 暗杠或补杠
if (type === 'AN_GANG' || type === 'BU_GANG') {

    let char = data || 
        (type === 'AN_GANG' ? state.currentActions?.AN_GANG[0] : state.currentActions?.BU_GANG[0]);

    // fallback: recompute from hand/show if button earlier did not supply one
    if (!char && type === 'BU_GANG') {
        const p0 = state.players[0];
        for (let g of p0.show) {
            if (g.type === 'PENG') {
                let idx = p0.hand.findIndex(t => t.char === g.tiles[0].char);
                if (idx >= 0) {
                    char = g.tiles[0].char;
                    break;
                }
            }
        }
    }

    if (!char) {
        console.warn('执行杠时未找到牌，type=', type, 'currentActions=', state.currentActions, 'data=', data);
        // 保护：直接清空并返回
        clearActionQueue();
        return;
    }

    // 抢杠胡检测（暗杠也允许被抢）
    if (checkQiangGang(0, char, type === 'AN_GANG')) return;

    // 真正执行杠
    completeGangLogic(0, char, type === 'AN_GANG');

    clearActionQueue();

    return;
}

    // 吃、碰、大明杠逻辑
    state.players[state.turn].river.pop();
    let targetTile = state.lastDiscard;
    let tiles = [targetTile];

    if (type === 'CHI') {
        data.forEach(v => {
            let idx = p.hand.findIndex(t => getLogic(t).val === v && getLogic(t).type === getLogic(targetTile).type);
            tiles.push(p.hand.splice(idx, 1)[0]);
        });
    } else {
        let needed = (type === 'PENG' ? 2 : 3);
        for(let i=0; i<needed; i++) {
            let idx = p.hand.findIndex(t => !isGoldTile(t) && isSameLogicTile(t, targetTile));
            tiles.push(p.hand.splice(idx, 1)[0]);
        }
    }

    p.show.push({ type, tiles });
    clearActionQueue();
    // 牌已经被你拿来吃/碰/杠了，队列里如果还有人想碰这张牌，必须作废
    state.turn = 0;
    state.currentActions = null;
    sortHand(0); 
    render();

    if(type === 'GANG') {
        immediateScore(0, false);
        defer(() => drawTile(0, 'GANG'), 500);
    }
}

    function selectTile(idx) {
        const hasVisibleActionBar = runtime.uiEnabled ? isActionBarVisibleView() : false;
        // 有未决动作时（例如可胡）必须先点“胡/过”，不能直接出牌
        if(state.isGameOver || state.turn !== 0 || state.waitingAction || state.currentActions || hasVisibleActionBar) return;
        if(isGoldTile(state.players[0].hand[idx])) return; 
        
        if(state.selectedIndex === idx) {
            state.lastDiscard = state.players[0].hand.splice(idx, 1)[0];
            state.players[0].river.push(state.lastDiscard);
            checkChuiFengLogic(0, state.lastDiscard.char);
            state.selectedIndex = -1;
            state.roundCount++;
            render();
            defer(nextTurn, 400);
        } else { 
            state.selectedIndex = idx; 
            render(); 
        }
    }

// 补充一个执行杠牌结果的辅助函数
function completeGangLogic(pIdx, char, isAnGang) {
    const p = state.players[pIdx];
    if (isAnGang) {
        let tiles = p.hand.filter(t => t.char === char);
        p.hand = p.hand.filter(t => t.char !== char);
        p.show.push({ type: 'AN_GANG', tiles: tiles });
        immediateScore(pIdx, true); // 暗杠分
    } else {
        let g = p.show.find(group => group.type === 'PENG' && group.tiles[0].char === char);
        if (!g) {
            console.error('补杠失败：找不到对应的碰组', pIdx, char, p.show);
            return;
        }
        let idx = p.hand.findIndex(t => t.char === char);
        if (idx === -1) {
            console.error('补杠失败：手牌中找不到要补的牌', pIdx, char, p.hand);
            return;
        }
        g.tiles.push(p.hand.splice(idx, 1)[0]);
        g.type = 'BU_GANG';
        immediateScore(pIdx, false); // 补杠分
    }
    state.currentActions = null;
state.waitingAction = false;
    sortHand(pIdx);
    render();
    defer(() => drawTile(pIdx, 'GANG'), 500); // 杠完摸最后一张
}

function nextTurn() {
        if(state.isGameOver) return;
        clearActionQueue(); // 清空之前的队列

        // 1. 搜集所有玩家对当前弃牌的可能动作
        for (let i = 1; i < 4; i++) {
            let pIdx = (state.turn + i) % 4;
            if (pIdx === 0) {
                // 检查玩家(自己)是否有动作
                let acts = getReactionOptions(state.lastDiscard, (pIdx === (state.turn + 1) % 4));
                if (acts.HU) state.actionQueue.push({ pIdx, type: 'HU', priority: 0, data: acts });
                if (acts.PENG) state.actionQueue.push({ pIdx, type: 'PENG', priority: 1, data: acts });
                if (acts.GANG) state.actionQueue.push({ pIdx, type: 'GANG', priority: 1, data: acts });
                if (acts.CHI && acts.CHI.length > 0) state.actionQueue.push({ pIdx, type: 'CHI', priority: 2, data: acts });
            } else {
                // 检查 AI 是否有动作
                let aiAct = checkAIReaction(pIdx);
                if (aiAct) {
                    let prio = (aiAct.type === 'HU' ? 0 : (aiAct.type === 'CHI' ? 2 : 1));
                    state.actionQueue.push({ pIdx, type: aiAct.type, priority: prio, aiData: aiAct.data });
                }
            }
        }

        // 2. 排序：按优先级 (0:胡 > 1:碰杠 > 2:吃)
        // 同优先级时，按距离出牌者的座位顺序排列（实现“截胡”逻辑）
        state.actionQueue.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            let distA = (a.pIdx - state.turn + 4) % 4;
            let distB = (b.pIdx - state.turn + 4) % 4;
            return distA - distB;
        });

        // 3. 开始执行/询问队列中的第一个动作
        processActionQueue();
    }
   

function processActionQueue() {
        if (state.isGameOver) return;

        if (state.actionQueue.length === 0) {
            // 无人响应，轮到下家摸牌
            state.turn = (state.turn + 1) % 4;
            drawTile(state.turn);
            clearActionQueue();
            return;
        }

        // 获取当前优先级最高的动作
        let action = state.actionQueue[0];

        if (action.pIdx === 0) {
            // 如果是玩家，弹出动作条
            showActionBar(action.data);
        } else {
            // 如果是 AI，直接执行并结束本次队列处理（因为牌被拿走了）
            executeAIAction(action.pIdx, action.type, action.aiData);
            clearActionQueue();
        }
    }

// 找到 checkAIReaction 函数，整体替换为以下内容
function checkAIReaction(pIdx) {
    const p = state.players[pIdx];
    const tile = state.lastDiscard;

    // 自摸阶段没有上一个人打出的牌，直接返回
    if (!tile) return null;

    if(isGoldTile(tile)) return null;

    // 1. 优先检查胡牌
    let hu = checkHuInfo(pIdx, tile, false);
if (hu.types.includes("游金") ) {
    hu.canHu = false;
}
    if (hu.canHu) return { type: 'HU', data: hu.types };

    // 【修复点 3】：排除金牌后再判断吃碰杠
    const handWithoutGold = p.hand.filter(t => !isGoldTile(t));
    const count = handWithoutGold.filter(t => isSameLogicTile(t, tile)).length;
    if (count === 3) return { type: 'GANG' };
    if (count === 2) return { type: 'PENG' };

    const isNextPlayer = (state.turn + 1) % 4 === pIdx;
    const tileType = getLogic(tile).type;
    
    if (isNextPlayer && ['W', 'T', 'S'].includes(tileType)) {
        const lt = getLogic(tile);
        // 获取手中同花色且非金牌的数值
        const vs = handWithoutGold.filter(t => getLogic(t).type === tileType).map(t => getLogic(t).val);

        if (vs.includes(lt.val - 2) && vs.includes(lt.val - 1)) return { type: 'CHI', data: [lt.val - 2, lt.val - 1] };
        if (vs.includes(lt.val - 1) && vs.includes(lt.val + 1)) return { type: 'CHI', data: [lt.val - 1, lt.val + 1] };
        if (vs.includes(lt.val + 1) && vs.includes(lt.val + 2)) return { type: 'CHI', data: [lt.val + 1, lt.val + 2] };
    }

    return null;
}

function executeAIAction(pIdx, type, data) {
    const p = state.players[pIdx];
    if (['CHI', 'PENG', 'GANG', 'AN_GANG', 'BU_GANG', 'HU'].includes(type)) {
        playActionVoice(type);
    }

    // 1. 胡牌处理 (最高优先级)
    if (type === 'HU') { 
        settle(pIdx, state.turn, false, data); 
        clearActionQueue();
        return; 
    }

    // 2. 暗杠与补杠处理 (AI 自己摸牌后的动作，不涉及牌河)
    if (type === 'AN_GANG' || type === 'BU_GANG') {
        // 拦截检查：检查玩家或其他 AI 是否可以抢杠胡
        if (checkQiangGang(pIdx, data, type === 'AN_GANG')) return;
        
        // 无人抢杠，执行杠牌结果
        completeGangLogic(pIdx, data, type === 'AN_GANG');
        return;
    }

    // 3. 吃、碰、大明杠处理 (对别人打出的牌做反应)
    const typeMap = { 'PENG': '碰', 'GANG': '杠', 'CHI': '吃' };
    playActionEffect(pIdx, typeMap[type] || type);

    // 从上一家的牌河中移除那张弃牌
    state.players[state.turn].river.pop();
    clearActionQueue();
    let tiles = [state.lastDiscard];

    if (type === 'CHI') {
        // 根据传入的 data（数值数组）从手牌中找出对应的牌
        data.forEach(v => {
            let idx = p.hand.findIndex(t => getLogic(t).val === v && getLogic(t).type === getLogic(state.lastDiscard).type);
            if (idx !== -1) tiles.push(p.hand.splice(idx, 1)[0]);
        });
    } else {
        // 碰或大明杠
        let num = (type === 'PENG') ? 2 : 3;
        for (let i = 0; i < num; i++) {
            let idx = p.hand.findIndex(t => !isGoldTile(t) && isSameLogicTile(t, state.lastDiscard));
            if (idx !== -1) tiles.push(p.hand.splice(idx, 1)[0]);
        }
    }

    // 更新玩家副露区（show 区域）
    p.show.push({ type, tiles });
    
    // 关键：牌被拿走了，清空所有排队的动作，并将回合移交给该 AI
    clearActionQueue();
    state.turn = pIdx;
    
    sortHand(pIdx);
    render();

    if (type === 'GANG') {
        immediateScore(pIdx, false); // 明杠立即加分
        // 杠牌后需要补牌
        defer(() => drawTile(pIdx, 'GANG'), 600);
    } else {
        // 吃、碰后，AI 需要思考出哪张牌
        // 注意：这里建议统一使用 aiAction(pIdx) 
        defer(() => aiAction(pIdx), 800);
    }
}

    function immediateScore(winnerIdx, isAnGang) {
        const points = isAnGang ? 2 : 1;
        for (let i = 0; i < 4; i++) {
            if (i === winnerIdx) continue;
            state.scores[i] -= points;
            state.scores[winnerIdx] += points;
        }
        renderScores(); 
    }

function aiAction(pIdx) {
    if (state.isGameOver || state.turn !== pIdx) return;

    const p = state.players[pIdx];

    // =========================
    // 1. 自摸胡判断
    // =========================
let huInfo = checkHuInfo(pIdx, null, true);
    if (huInfo.canHu) {
        playActionVoice('HU');
        settle(pIdx, pIdx, true, huInfo.types);
        return;
    }

    // =========================
    // 2. 暗杠判断
    // =========================
    let countMap = {};
    p.hand.forEach(t => {
        if (!isGoldTile(t)) {
            countMap[t.char] = (countMap[t.char] || 0) + 1;
        }
    });

    for (let char in countMap) {
        if (countMap[char] === 4) {
            if (checkQiangGang(pIdx, char, true)) return;
            playActionVoice('AN_GANG');
            completeGangLogic(pIdx, char, true);
            return;
        }
    }

    // =========================
    // 3. 补杠判断
    // =========================
    for (let group of p.show) {
        if (group.type === 'PENG') {
            let char = group.tiles[0].char;
            let idx = p.hand.findIndex(t => t.char === char);
            if (idx !== -1) {
                if (checkQiangGang(pIdx, char, false)) return;
                playActionVoice('BU_GANG');
                completeGangLogic(pIdx, char, false);
                return;
            }
        }
    }

    // =========================
    // 4. 进入出牌逻辑
    // =========================
    let playable = p.hand.filter(t => !isGoldTile(t));
    if (playable.length === 0) playable = [p.hand[0]];

    // =========================
    // 强制吹风跟牌系统（严格规则版）
    // =========================
    if (state.chuiFeng.active && !state.chuiFeng.failed) {
        const target = state.chuiFeng.targetChar;
        const canFollow = p.hand.find(t => t.char === target);

        // 能跟必须跟
        if (canFollow) {
            const idx = p.hand.indexOf(canFollow);
            state.lastDiscard = p.hand.splice(idx, 1)[0];
            p.river.push(state.lastDiscard);

            checkChuiFengLogic(pIdx, state.lastDiscard.char);
            p.lastDraw = null;

            render();
            defer(nextTurn, 400);
            return; // 强制结束本回合
        }

        // 有人没跟 → 吹风失败
        state.chuiFeng.failed = true;
        state.chuiFeng.active = false;
    }

    // =========================
    // 正常AI出牌评估系统
    // =========================
    let bestTile = null;
    let maxScrap = -999;

    playable.forEach(tile => {
        let scrap = 0;
        const lt = getLogic(tile);
        const sameCount = p.hand.filter(t => t.char === tile.char).length;

        // 拆对子严重扣分
        if (sameCount >= 2) scrap -= 40;

        if (lt.type === 'Z') {
            if (sameCount === 1) scrap += 50;
        } else {
            const has1 = p.hand.some(t =>
                getLogic(t).type === lt.type &&
                Math.abs(getLogic(t).val - lt.val) === 1
            );

            const has2 = p.hand.some(t =>
                getLogic(t).type === lt.type &&
                Math.abs(getLogic(t).val - lt.val) === 2
            );

            if (!has1 && !has2) scrap += 40;
            if (lt.val === 0 || lt.val === 8) scrap += 10;
        }

        if (scrap > maxScrap) {
            maxScrap = scrap;
            bestTile = tile;
        }
    });

    // =========================
    // 执行出牌
    // =========================
    const idx = p.hand.indexOf(bestTile);
    state.lastDiscard = p.hand.splice(idx, 1)[0];
    p.river.push(state.lastDiscard);

    checkChuiFengLogic(pIdx, state.lastDiscard.char);
    p.lastDraw = null;

    render();
    defer(nextTurn, 400);
}

// 找到 getReactionOptions 函数，整体替换为以下内容
function getReactionOptions(tile, canChi, pIdx = 0) {
    let hu = checkHuInfo(pIdx, tile, false);
    let res = { HU: hu.canHu, PENG: false, GANG: false, CHI: [], huTypes: hu.types, isSelfDraw: false };
    
    // 如果打出的是金牌，或者自己没有反应，直接返回
    if(isGoldTile(tile)) return res;
    
    // 【修复点 2】：只在非金牌的手牌中寻找组合
    const handWithoutGold = state.players[pIdx].hand.filter(t => !isGoldTile(t));
    const count = handWithoutGold.filter(t => isSameLogicTile(t, tile)).length;
    if(count >= 2) res.PENG = true;
    if(count === 3) res.GANG = true;
    
    if(canChi && ['W','T','S'].includes(getLogic(tile).type)) {
        const lt = getLogic(tile);
        // 同样，吃牌的候选牌也必须排除金牌
        const vs = handWithoutGold.filter(t => getLogic(t).type === lt.type).map(t => getLogic(t).val);
        const v = lt.val;
        if(vs.includes(v-2) && vs.includes(v-1)) res.CHI.push([v-2, v-1]);
        if(vs.includes(v-1) && vs.includes(v+1)) res.CHI.push([v-1, v+1]);
        if(vs.includes(v+1) && vs.includes(v+2)) res.CHI.push([v+1, v+2]);
    }
    return res;
}

function render() {
    if (!runtime.uiEnabled) return;
    renderBoardView(state, { isGoldTile, onSelectTile: selectTile });
    renderScores();
    renderWinText();
}

    function deselectAll() { state.selectedIndex = -1; render(); }
    function resumeGameAfterPass() {
        state.turn = (state.turn + 1) % 4;
        defer(() => drawTile(state.turn), 400);
    }

function renderWinText() {
    if (!runtime.uiEnabled) return;
    renderWinTextView(state);
}

// --------- Debug/test helpers ----------
function makeTile(char) {
    for (let t in MAHJONG_TILES) {
        let idx = MAHJONG_TILES[t].indexOf(char);
        if (idx !== -1) return { char, type: t, val: idx, id: Math.random() };
    }
    return { char, type: 'H', val: 0, id: Math.random() };
}

function testHu(desc, goldChar, handChars, extraChar = null, isSelfDraw = false) {
    state.gold = makeTile(goldChar);
    const p = state.players[0];
    p.hand = handChars.map(makeTile);
    const extra = extraChar ? makeTile(extraChar) : null;
    const res = checkHuInfo(0, extra, isSelfDraw);
    console.log(`Test: ${desc}`);
    console.log(`  gold=${goldChar}, hand=[${handChars.join(' ')}], extra=${extraChar}, self=${isSelfDraw}`);
    console.log('  result:', res);
    return res;
}

function runHuTests() {
    console.log('--- running hu logic tests ---');
    testHu('normal simple', '🀀', ['🀇', '🀈', '🀉', '🀊', '🀋', '🀌', '🀍', '🀎', '🀏', '🀙', '🀚', '🀛', '🀐', '🀑', '🀒', '🀓'], null, true);
    testHu('youjin example', '🀀', ['🀀', '🀇', '🀈', '🀉', '🀊', '🀋', '🀌', '🀍', '🀎', '🀏', '🀙', '🀚', '🀛', '🀐', '🀑', '🀒'], '🀓', true);
    testHu('youjin two-gold', '🀀', ['🀀', '🀀', '🀇', '🀈', '🀉', '🀊', '🀋', '🀌', '🀍', '🀎', '🀏', '🀙', '🀚', '🀛', '🀐', '🀑'], '🀒', true);
    testHu('double gold cannot hu on discard', '🀀', ['🀀', '🀀', '🀇', '🀈', '🀉', '🀊', '🀋', '🀌', '🀍', '🀎', '🀏', '🀙', '🀚', '🀛', '🀐', '🀑'], '🀒', false);
    testHu('san jindao', '🀀', ['🀀', '🀀', '🀀', '🀇', '🀈', '🀉', '🀊', '🀋', '🀌', '🀍', '🀎', '🀏', '🀙', '🀚', '🀛', '🀐'], null, true);
    initGame();
}

function runRuleRegressionChecks() {
    const backup = cloneSnapshot(state);
    const report = [];
    const p = state.players[0];

    const addCase = (name, pass, detail = '') => {
        report.push({ name, pass, detail });
    };

    const hasAll = (types = [], required = []) => required.every(t => types.includes(t));

    try {
        state.dealer = 0;
        state.turn = 0;

        // Case 1: 游金可叠杠开+花开（补杠补花补牌）
        state.gold = makeTile('🀀');
        state.roundCount = 3;
        p.hand = ['🀀', '🀇', '🀈', '🀉', '🀊', '🀋', '🀌', '🀍', '🀎', '🀏', '🀙', '🀚', '🀛', '🀐', '🀑', '🀒', '🀓'].map(makeTile);
        p.lastDraw = p.hand[p.hand.length - 1];
        let hu = checkHuInfo(0, null, true, true, true);
        addCase(
            'youjin_stacks_gang_flower',
            hu.canHu && hasAll(hu.types, ['游金', '杠上开花', '花开富贵']),
            JSON.stringify(hu.types || [])
        );

        // Case 2: 三金倒可叠杠开+花开（非首巡）
        state.gold = makeTile('🀇');
        state.roundCount = 2;
        p.hand = ['🀇', '🀇', '🀇', '🀈', '🀉', '🀊', '🀚', '🀛', '🀜', '🀑', '🀒', '🀓', '🀀', '🀀', '🀀', '🀡', '🀠'].map(makeTile);
        p.lastDraw = p.hand[0];
        hu = checkHuInfo(0, null, true, true, true);
        addCase(
            'sanjin_stacks_gang_flower',
            hu.canHu && hasAll(hu.types, ['三金倒', '杠上开花', '花开富贵']) && !hu.types.includes('天胡') && !hu.types.includes('地胡'),
            JSON.stringify(hu.types || [])
        );

        // Case 3: 三金倒与天地胡同时出现，仅判天地胡（不叠三金倒）
        state.gold = makeTile('🀄');
        state.roundCount = 0;
        p.hand = ['🀄', '🀄', '🀄', '🀇', '🀈', '🀉', '🀙', '🀚', '🀛', '🀐', '🀑', '🀒', '🀀', '🀀', '🀀', '🀊', '🀊'].map(makeTile);
        p.lastDraw = p.hand[0];
        hu = checkHuInfo(0, null, true, false, false);
        addCase(
            'sanjin_vs_tianhu_only_tianhu',
            hu.canHu && hu.types.includes('天胡') && !hu.types.includes('三金倒'),
            JSON.stringify(hu.types || [])
        );

        // Case 4: 三金倒强制胡（仅保留 HU，不提供弃牌/杠）
        state.gold = makeTile('🀇');
        state.roundCount = 2;
        p.hand = ['🀇', '🀇', '🀇', '🀈', '🀉', '🀊', '🀚', '🀛', '🀜', '🀑', '🀒', '🀓', '🀀', '🀀', '🀀', '🀡', '🀠'].map(makeTile);
        p.lastDraw = p.hand[0];
        const legal = getTurnSelfOptions(0);
        const onlyHu = legal.length > 0 && legal.every(action => action.type === 'HU');
        addCase(
            'sanjin_forced_hu_only',
            onlyHu,
            JSON.stringify(legal.map(a => a.type))
        );
    } finally {
        state = backup;
        render();
        renderScores();
    }

    const ok = report.every(item => item.pass);
    if (console.table) console.table(report);
    console.log(`[rule-regression] ${ok ? 'PASS' : 'FAIL'} (${report.filter(r => r.pass).length}/${report.length})`);
    return { ok, report };
}

function testQiangGang(desc, goldChar, hands, gangerIdx, tileChar, isAnGang) {
    console.log('--- running qiang gang test:', desc);
    state.gold = makeTile(goldChar);
    state.players.forEach((p, idx) => {
        p.hand = (hands[idx] || []).map(makeTile);
        p.show = [];
        p.river = [];
    });
    const result = checkQiangGang(gangerIdx, tileChar, isAnGang);
    console.log('result', result, 'waitingAction', state.waitingAction, 'qiangGangPending', state.qiangGangPending);
    return result;
}

function startForcedGoldTestRound(goldCount) {
    state.forcedBottomGoldCount = goldCount;
    nextRound();
    console.log(`[test] 已开局：南家手牌目标金牌数=${goldCount}`);
}

function youjinDebug(drawnIndex = -1) {
    const p = state.players[0];
    let drawn = null;
    if (Number.isInteger(drawnIndex) && drawnIndex >= 0 && drawnIndex < p.hand.length) {
        drawn = p.hand[drawnIndex];
    } else {
        drawn = p.lastDraw || null;
    }
    const info = getYouJinDebugInfo([...p.hand], drawn);
    const hu = checkHuInfo(0, null, true, false, false);
    console.log('[youjin_debug] drawn=', drawn ? drawn.char : null);
    console.log('[youjin_debug] detail=', info);
    console.log('[youjin_debug] checkHuInfo=', hu);
    return { info, hu };
}

function cloneSnapshot(input) {
    return JSON.parse(JSON.stringify(input));
}

function getStateSnapshot() {
    return cloneSnapshot(state);
}

function serializeState(inputState = state) {
    return cloneSnapshot(inputState);
}

function restoreState(snapshot) {
    if (!snapshot) return getStateSnapshot();
    state = cloneSnapshot(snapshot);
    render();
    renderScores();
    return getStateSnapshot();
}

function getTurnSelfOptions(seatId) {
    const p = state.players[seatId];
    if (!p) return [];
    const options = [];
    const huInfo = checkHuInfo(seatId, null, true);
    if (huInfo.canHu) options.push({ type: 'HU', payload: { huTypes: huInfo.types, isSelfDraw: true } });
    const mustHu = huInfo.canHu && Array.isArray(huInfo.types) && huInfo.types.includes('三金倒');
    if (mustHu) return options;

    const counts = {};
    p.hand.forEach(t => {
        if (!isGoldTile(t)) counts[t.char] = (counts[t.char] || 0) + 1;
    });
    for (const char in counts) {
        if (counts[char] === 4) options.push({ type: 'AN_GANG', payload: { char } });
    }
    p.show.forEach(g => {
        if (g.type === 'PENG') {
            const pengChar = g.tiles[0].char;
            if (p.hand.some(t => t.char === pengChar)) {
                options.push({ type: 'BU_GANG', payload: { char: pengChar } });
            }
        }
    });
    p.hand.forEach((t, index) => {
        if (!isGoldTile(t)) options.push({ type: 'DISCARD', payload: { index, char: t.char } });
    });
    return options;
}

function getLegalActions(inputState = null, seatId = state.turn) {
    const prev = getStateSnapshot();
    if (inputState) {
        state = cloneSnapshot(inputState);
    }

    let actions = [];
    if (!state.isGameOver) {
        if (seatId === state.turn) {
            actions = getTurnSelfOptions(seatId);
        } else if (state.lastDiscard) {
            const canChi = seatId === ((state.turn + 1) % 4);
            const res = getReactionOptions(state.lastDiscard, canChi, seatId);
            if (res.HU) actions.push({ type: 'HU', payload: { huTypes: res.huTypes, isSelfDraw: false } });
            if (res.PENG) actions.push({ type: 'PENG' });
            if (res.GANG) actions.push({ type: 'GANG' });
            res.CHI.forEach(choice => actions.push({ type: 'CHI', payload: { choice } }));
            if (actions.length) actions.push({ type: 'PASS' });
        }
    }

    if (inputState) {
        state = prev;
    }
    return actions;
}

function normalizeAction(action = {}) {
    return {
        type: action.type,
        seatId: Number.isInteger(action.seatId) ? action.seatId : state.turn,
        payload: action.payload || {},
        clientActionId: action.clientActionId || '',
        ts: action.ts || Date.now()
    };
}

function applyAction(inputStateOrAction, maybeAction) {
    let inputState = null;
    let action = null;
    if (maybeAction === undefined) {
        action = normalizeAction(inputStateOrAction || {});
    } else {
        inputState = inputStateOrAction;
        action = normalizeAction(maybeAction || {});
    }

    const run = () => {
        switch (action.type) {
            case 'ROUND_START':
                nextRound();
                break;
            case 'DRAW':
                drawTile(action.seatId, action.payload?.drawReason || (action.payload?.isFlowerReplenish ? 'FLOWER' : 'NORMAL'));
                break;
            case 'DISCARD':
                if (action.seatId === 0) {
                    selectTile(action.payload.index);
                    if (state.selectedIndex === action.payload.index) selectTile(action.payload.index);
                } else {
                    const p = state.players[action.seatId];
                    const index = Number.isInteger(action.payload.index) ? action.payload.index : 0;
                    const tile = p.hand[index];
                    if (tile && !isGoldTile(tile)) {
                        p.hand.splice(index, 1);
                        p.river.push(tile);
                        state.lastDiscard = tile;
                        state.roundCount++;
                        render();
                        nextTurn();
                    }
                }
                break;
            case 'CHI':
            case 'PENG':
            case 'GANG':
            case 'AN_GANG':
            case 'BU_GANG':
            case 'HU':
            case 'PASS':
                execute(action.type, action.payload.choice || action.payload.char || action.payload);
                break;
            case 'FLOWER_REPLENISH':
                handleFlowers(action.seatId);
                render();
                break;
            default:
                break;
        }
        return serializeState();
    };

    if (!inputState) return run();

    const prevState = getStateSnapshot();
    return withRuntimeOptions(
        { uiEnabled: false, timersEnabled: false, alertsEnabled: false },
        () => {
            state = cloneSnapshot(inputState);
            try {
                return run();
            } finally {
                state = prevState;
            }
        }
    );
}

function runAITurn(inputState = null, seatId = state.turn) {
    if (!inputState) {
        aiAction(seatId);
        return serializeState();
    }

    const prevState = getStateSnapshot();
    return withRuntimeOptions(
        { uiEnabled: false, timersEnabled: false, alertsEnabled: false },
        () => {
            state = cloneSnapshot(inputState);
            try {
                aiAction(seatId);
                return serializeState();
            } finally {
                state = prevState;
            }
        }
    );
}

function createGame(initialConfig = {}) {
    if (initialConfig.resetScores) resetScores();
    if (Number.isInteger(initialConfig.dealer) && initialConfig.dealer >= 0 && initialConfig.dealer < 4) {
        state.dealer = initialConfig.dealer;
    }
    if (Number.isInteger(initialConfig.dealerStreak) && initialConfig.dealerStreak >= 0) {
        state.dealerStreak = initialConfig.dealerStreak;
    }
    if (Number.isInteger(initialConfig.forcedBottomGoldCount) && initialConfig.forcedBottomGoldCount > 0) {
        state.forcedBottomGoldCount = initialConfig.forcedBottomGoldCount;
    }
    if (initialConfig.autoStart === false) {
        initGame();
    } else {
        nextRound();
    }
    return serializeState();
}

export {
    TILE_TYPES,
    MAHJONG_TILES,
    state,
    initGame,
    nextRound,
    resetAll,
    resetScores,
    render,
    renderScores,
    openRuleModal,
    closeRuleModal,
    selectTile,
    deselectAll,
    execute,
    handleActionButton,
    setupActionAudioUnlock,
    getActionVoiceProfile,
    runHuTests,
    runRuleRegressionChecks,
    testHu,
    testQiangGang,
    startForcedGoldTestRound,
    youjinDebug,
    createGame,
    getLegalActions,
    applyAction,
    runAITurn,
    serializeState,
    restoreState,
    getStateSnapshot
};





