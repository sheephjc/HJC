function appendActionButton(container, text, type, payload = null, styleText = '') {
    const btn = document.createElement('div');
    btn.className = 'btn-act';
    btn.innerText = text;
    btn.dataset.actionType = type;
    if (payload !== null && payload !== undefined) {
        btn.dataset.actionPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
    }
    if (styleText) btn.style.cssText = styleText;
    container.appendChild(btn);
}

export function resetRoundVisualStateView() {
    document.querySelectorAll('.result-text').forEach((el) => el.remove());
    document.querySelectorAll('.player-area').forEach((el) => {
        el.classList.remove('win-mark', 'lose-mark');
    });

    const bar = document.getElementById('action-bar');
    if (bar) {
        bar.classList.remove('chi-three-mobile');
        bar.innerHTML = '';
        bar.style.display = 'none';
    }

    const overlay = document.getElementById('hu-overlay');
    if (overlay) overlay.style.display = 'none';
}

export function setGoldDisplayView(goldChar) {
    const goldDisplay = document.getElementById('gold-display');
    if (goldDisplay) goldDisplay.innerText = goldChar || '';
}

export function hideActionBarView() {
    const bar = document.getElementById('action-bar');
    if (!bar) return;
    bar.style.display = 'none';
}

export function isActionBarVisibleView() {
    const bar = document.getElementById('action-bar');
    return !!(bar && bar.style.display !== 'none');
}

export function showCenterFlashTextView(text) {
    const table = document.getElementById('table');
    if (!table) return;
    const el = document.createElement('div');
    el.style = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #ff3d00; font-size: 60px; font-weight: 900; text-shadow: 0 0 15px rgba(255, 255, 255, 0.8), 2px 2px 0 #000; z-index: 1000; pointer-events: none; animation: chui-feng-anim 1s ease-out forwards;';
    el.innerText = text;
    table.appendChild(el);
    setTimeout(() => el.remove(), 1000);
}

export function showPlayerActionEffectView(playerId, text) {
    const area = document.getElementById(`p-${playerId}`);
    if (!area) return;
    const effect = document.createElement('div');
    effect.className = 'action-effect';
    effect.innerText = text;
    area.appendChild(effect);
    setTimeout(() => effect.remove(), 800);
}

export function showActionBarView(acts) {
    const bar = document.getElementById('action-bar');
    if (!bar) return;

    bar.classList.remove('chi-three-mobile');
    bar.style.display = 'flex';
    bar.innerHTML = '';

    if (acts.HU) appendActionButton(bar, '胡', 'HU');
    if (acts.PENG) appendActionButton(bar, '碰', 'PENG');
    if (acts.GANG) appendActionButton(bar, '杠', 'GANG');
    if (acts.CHI && acts.CHI.length > 0) appendActionButton(bar, '吃', 'SHOW_CHI_MENU');
    if (acts.AN_GANG && acts.AN_GANG.length) {
        if (acts.AN_GANG.length === 1) {
            appendActionButton(bar, '暗', 'AN_GANG');
        } else {
            acts.AN_GANG.forEach((c) => appendActionButton(bar, `暗${c}`, 'AN_GANG', c));
        }
    }
    if (acts.BU_GANG && acts.BU_GANG.length) {
        if (acts.BU_GANG.length === 1) {
            appendActionButton(bar, '补', 'BU_GANG');
        } else {
            acts.BU_GANG.forEach((c) => appendActionButton(bar, `补${c}`, 'BU_GANG', c));
        }
    }
    if (!acts.mustHu) {
        appendActionButton(bar, '过', 'PASS', null, 'background:#7f8c8d');
    }
}

export function showChiSubMenuView(state, helpers) {
    const bar = document.getElementById('action-bar');
    if (!bar) return;
    bar.innerHTML = '';

    const isMobilePortrait = !!(
        window.matchMedia
        && window.matchMedia('(max-width: 767px) and (orientation: portrait)').matches
    );
    const isThreeChiMobile = isMobilePortrait
        && Array.isArray(state.currentActions?.CHI)
        && state.currentActions.CHI.length === 3;
    bar.classList.toggle('chi-three-mobile', isThreeChiMobile);

    const targetTile = state.lastDiscard;
    const targetLogic = helpers.getLogic(targetTile);

    function getChiOptionChars(choice) {
        if (!targetTile || !targetLogic) return [];
        const hand = state.players[0].hand;
        const usedIdx = new Set();
        const pickByLogic = (val) => {
            for (let i = 0; i < hand.length; i++) {
                if (usedIdx.has(i)) continue;
                const t = hand[i];
                const lt = helpers.getLogic(t);
                if (lt && lt.type === targetLogic.type && lt.val === val) {
                    usedIdx.add(i);
                    return t;
                }
            }
            return null;
        };

        const left = pickByLogic(choice[0]);
        const right = pickByLogic(choice[1]);
        const seq = [
            { val: choice[0], char: left ? left.char : (helpers.MAHJONG_TILES[targetLogic.type] || [])[choice[0]] },
            { val: targetLogic.val, char: targetTile.char },
            { val: choice[1], char: right ? right.char : (helpers.MAHJONG_TILES[targetLogic.type] || [])[choice[1]] }
        ].sort((a, b) => a.val - b.val);

        return seq.map((x) => x.char).filter(Boolean);
    }

    state.currentActions.CHI.forEach((choice) => {
        const btn = document.createElement('div');
        btn.className = 'btn-act chi-option-btn';
        const chars = getChiOptionChars(choice);
        if (chars.length === 3) {
            const wrap = document.createElement('div');
            wrap.className = 'chi-option-tiles';
            chars.forEach((ch) => {
                const t = document.createElement('span');
                t.className = `chi-option-tile${helpers.isGoldChar(ch) ? ' is-gold' : ''}`;
                t.innerText = ch;
                wrap.appendChild(t);
            });
            btn.appendChild(wrap);
        } else {
            btn.style.fontSize = '14px';
            btn.innerText = choice.map((v) => v + 1).join('');
        }
        btn.dataset.actionType = 'CHI';
        btn.dataset.actionPayload = JSON.stringify(choice);
        bar.appendChild(btn);
    });

    const back = document.createElement('div');
    back.className = 'btn-act';
    back.innerText = '取消';
    back.dataset.actionType = 'BACK_TO_ACTIONS';
    bar.appendChild(back);
}
