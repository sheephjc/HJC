export function renderScoresView(state) {
    state.scores.forEach((s, i) => {
        const scoreEl = document.getElementById(`score-${i}`);
        if (!scoreEl) return;

        const boardEl = scoreEl.parentElement;
        if (!boardEl) return;

        const badge = boardEl.querySelector('.dealer-badge');
        if (badge) badge.remove();
        boardEl.classList.remove('dealer-active');

        if (i === state.dealer) {
            const dealerBadge = document.createElement('span');
            dealerBadge.className = 'dealer-badge';
            dealerBadge.innerText = state.dealerStreak > 0 ? `庄 x${state.dealerStreak + 1}` : '庄';
            boardEl.prepend(dealerBadge);
            boardEl.classList.add('dealer-active');
        }

        scoreEl.innerText = Math.floor(s);
    });
}

export function openRuleModalView(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
}

export function closeRuleModalView(param) {
    if (typeof param === 'string') {
        const el = document.getElementById(param);
        if (el) el.style.display = 'none';
        return;
    }
    if (param) param.style.display = 'none';
}

export function renderBoardView(state, { isGoldTile, onSelectTile }) {
    const restEl = document.getElementById('rest-count');
    if (restEl) restEl.innerText = `余牌: ${state.deck.length}`;
    const mobileRestEl = document.getElementById('mobile-rest-count');
    if (mobileRestEl) mobileRestEl.innerText = `余牌: ${state.deck.length}`;

    document.querySelectorAll('.player-area').forEach((el) => el.classList.remove('active-turn'));
    const currentPlayerArea = document.getElementById(`p-${state.players[state.turn].id}`);
    if (currentPlayerArea) currentPlayerArea.classList.add('active-turn');

    state.players.forEach((p, idx) => {
        const showZone = document.getElementById(`show-${p.id}`);
        if (showZone) {
            showZone.innerHTML = '';
            p.show.forEach((group) => {
                const groupDiv = document.createElement('div');
                groupDiv.className = 'group';
                group.tiles.forEach((t) => {
                    const div = document.createElement('div');
                    div.className = `tile ${isGoldTile(t) ? 'is-gold' : ''}`;
                    div.innerText = t.char;
                    groupDiv.appendChild(div);
                });
                showZone.appendChild(groupDiv);
            });
        }

        const handEl = document.getElementById(`hand-${p.id}`);
        if (!handEl) return;
        handEl.innerHTML = '';
        p.hand.forEach((t, i) => {
            const div = document.createElement('div');
            const isNew = p.lastDraw && t.id === p.lastDraw.id;
            const shouldShow = idx === 0 || state.isGameOver;
            const goldClass = shouldShow && isGoldTile(t) ? 'is-gold' : '';
            const isWinning = state.isGameOver
                && state.winningTile
                && state.winningTile.id === t.id
                && state.winnerInfo
                && state.winnerInfo.isSelfDraw
                && idx === state.winnerInfo.winner;

            div.className = `tile ${shouldShow ? '' : 'back'} ${goldClass}`
                + `${idx === 0 && isNew ? ' new-draw' : ''}`
                + `${idx === 0 && state.selectedIndex === i ? ' selected' : ''}`
                + `${isWinning ? ' winning' : ''}`;
            div.innerText = shouldShow ? t.char : '';

            if (idx === 0 && !state.isGameOver && typeof onSelectTile === 'function') {
                div.onclick = (e) => {
                    e.stopPropagation();
                    onSelectTile(i);
                };
            }

            handEl.appendChild(div);
        });

        const riverZone = document.getElementById(`river-${p.id}`);
        if (riverZone) {
            riverZone.innerHTML = p.river.map((t) => {
                const isWinningTile = state.isGameOver
                    && state.winningTile
                    && state.winningTile.id === t.id
                    && state.winnerInfo
                    && !state.winnerInfo.isSelfDraw
                    && idx === state.winnerInfo.loser;
                return `<div class="river-tile${isWinningTile ? ' winning' : ''}">${t.char}</div>`;
            }).join('');
        }
    });
}

export function renderWinTextView(state) {
    document.querySelectorAll('.result-text').forEach((el) => el.remove());
    if (!state.winnerInfo) return;

    const winner = state.winnerInfo.winner;
    const loser = state.winnerInfo.loser;
    const isSelfDraw = state.winnerInfo.isSelfDraw;
    const scoreAsSelfDraw = state.winnerInfo.scoreAsSelfDraw ?? isSelfDraw;
    const specialTypes = state.winnerInfo.specialTypes || [];
    const isYouJin = specialTypes.includes('游金');
    const isSanJinDao = specialTypes.includes('三金倒');

    state.players.forEach((p, idx) => {
        const area = document.getElementById(`p-${p.id}`);
        if (!area) return;

        if (idx === winner) {
            const text = document.createElement('div');
            text.className = 'result-text';
            text.innerText = isYouJin ? '游金' : (isSanJinDao ? '三金倒' : (scoreAsSelfDraw ? '自摸' : '胡牌'));
            area.appendChild(text);
        } else if (!isSelfDraw && idx === loser) {
            const text = document.createElement('div');
            text.className = 'result-text lose-text';
            text.innerText = '点炮';
            area.appendChild(text);
        }
    });
}
