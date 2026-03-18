function buildSettlementTable({
    winnerIdx,
    payerIdx,
    totalWin,
    isSelfDraw,
    isQiangGang,
    waterMul,
    specialMul,
    getBasePay
}) {
    const names = ['南（你）', '东', '北', '西'];
    const scores = [0, 0, 0, 0];
    let html = '<div class="settle-title" style="text-align:center;">结算</div>';

    if (isQiangGang) {
        scores[payerIdx] -= totalWin;
        scores[winnerIdx] += totalWin;
    } else {
        for (let i = 0; i < 4; i++) {
            if (i === winnerIdx) continue;
            const pay = getBasePay(winnerIdx, i, isSelfDraw);
            const finalScore = pay * waterMul * specialMul;
            scores[i] -= finalScore;
            scores[winnerIdx] += finalScore;
        }
    }

    scores.forEach((s, i) => {
        const color = s >= 0 ? '#00ff90' : '#ff6060';
        const sign = s >= 0 ? '+' : '';
        html += `
        <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.1);">
            <div style="color:#ffffff; font-weight:bold;">${names[i]}</div>
            <div style="color:${color}; min-width:40px; text-align:right;">${sign}${s}</div>
        </div>`;
    });

    return html;
}

function getWaterText(count) {
    const numCN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    if (count < 4) return '';
    return `${numCN[count - 3]}水`;
}

function getStreakText(streak) {
    if (streak <= 1) return '';
    if (streak === 2) return '连庄';
    return `连${streak - 1}次庄`;
}

export function showHuOverlayView({
    winnerIdx,
    specialTypes,
    totalWin,
    flowerCount,
    isSelfDraw,
    scoreAsSelfDraw,
    dealer,
    dealerStreak,
    lastDiscarder,
    getBasePay,
    onOverlayClose,
    startHuParticles
}) {
    const overlay = document.getElementById('hu-overlay');
    const mainText = document.getElementById('hu-main-text');
    const detailText = document.getElementById('hu-detail-text');
    const scoreText = document.getElementById('hu-score-text');
    const formulaText = document.getElementById('hu-formula-text');
    const settlePanel = document.getElementById('settle-panel');
    if (!overlay || !mainText || !detailText || !scoreText || !formulaText || !settlePanel) return;

    overlay.style.display = 'flex';
    overlay.onclick = null;
    formulaText.innerText = '';
    settlePanel.innerHTML = '';
    overlay.className = '';
    mainText.className = '';

    const parts = [];
    const waterText = getWaterText(flowerCount);
    const streakText = getStreakText(dealerStreak);
    if (waterText) parts.push(waterText);
    if (streakText) parts.push(streakText);

    if (!specialTypes.includes('游金')) {
        if (scoreAsSelfDraw) {
            parts.push('自摸');
        } else if (!isSelfDraw) {
            parts.push('点炮');
        }
    }
    specialTypes.forEach((t) => parts.push(t));

    mainText.innerText = parts.join(' ');
    detailText.innerText = '';
    scoreText.innerText = Math.floor(totalWin);

    const dealerMul = Math.pow(2, dealerStreak);
    const baseMul = winnerIdx === dealer ? dealerMul * 2 : 1;
    const waterCount = flowerCount >= 4 ? flowerCount - 3 : 0;
    const waterMul = waterCount > 0 ? Math.pow(2, waterCount) : 1;
    const waterName = ['', '一', '二', '三', '四', '五', '六'];

    const specialMap = {
        游金: 2,
        三金倒: 8,
        天胡: 8,
        地胡: 8,
        杠上开花: 2,
        花开富贵: 2,
        抢杠胡: 2
    };

    const specialList = [];
    let specialMul = 1;
    const hasSanJin = specialTypes.includes('三金倒');
    specialTypes.forEach((t) => {
        if (hasSanJin && t === '游金') return;
        const m = specialMap[t];
        if (!m) return;
        specialMul *= m;
        specialList.push({ name: t, mul: m });
    });

    const people = specialTypes.includes('抢杠胡') ? 1 : 3;
    const lines = [];
    if (winnerIdx === dealer) {
        const streakLabel = dealerStreak >= 1 ? '连庄' : '庄';
        lines.push(`${streakLabel} ×${baseMul}`);
    }
    if (scoreAsSelfDraw) lines.push('自摸 +1');
    if (waterCount > 0) lines.push(`${waterName[waterCount]}水 ×${waterMul}`);
    specialList.forEach((s) => lines.push(`${s.name} ×${s.mul}`));

    let formula = '';
    if (winnerIdx === dealer) {
        formula = `(1×${baseMul}`;
        if (scoreAsSelfDraw) formula += '+1';
        formula += ')';
        if (waterMul > 1) formula += `×${waterMul}`;
        specialList.forEach((s) => {
            formula += `×${s.mul}`;
        });
        formula += `×${people}`;
        formula += ` = ${Math.floor(totalWin)}`;
    } else {
        const baseStr = scoreAsSelfDraw ? '1底+1自摸' : '1底';
        const waterStr = waterMul > 1 ? `×${waterMul}` : '';
        const specStr = specialMul > 1 ? `×${specialMul}` : '';
        formula = `(${baseStr})${waterStr}${specStr}×2闲家 + (${baseStr}+1庄)${waterStr}${specStr}×1庄家 = ${Math.floor(totalWin)}`;
    }

    formulaText.style.marginTop = '15px';
    formulaText.style.fontSize = '20px';
    formulaText.style.color = '#ffd700';
    formulaText.style.textAlign = 'center';
    formulaText.innerHTML = `
${lines.join('<br>')}
<br><br>
${formula}
`;

    const isQiangGang = specialTypes.includes('抢杠胡');
    let tableHTML = buildSettlementTable({
        winnerIdx,
        payerIdx: lastDiscarder ?? -1,
        totalWin: Math.floor(totalWin),
        isSelfDraw: scoreAsSelfDraw,
        isQiangGang,
        waterMul,
        specialMul,
        getBasePay
    });
    if (!tableHTML || tableHTML.trim() === '') {
        tableHTML = '<div style="color:#fff;text-align:center;">结算数据异常</div>';
    }
    settlePanel.innerHTML = tableHTML;
    settlePanel.style.display = 'block';

    overlay.onclick = () => {
        overlay.style.display = 'none';
        if (typeof onOverlayClose === 'function') onOverlayClose();
    };

    mainText.className = '';
    overlay.className = '';
    if (flowerCount >= 4) mainText.classList.add('hu-blue-wave');
    if (dealerStreak >= 2) mainText.classList.add('hu-shake-strong');

    specialTypes.forEach((type) => {
        if (type === '游金') mainText.classList.add('hu-gold-pulse');
        if (type === '三金倒') {
            mainText.classList.add('hu-super-gold');
            mainText.classList.add('hu-shake-strong');
        }
        if (type === '天胡' || type === '地胡') mainText.classList.add('hu-red-glow');
        if (type === '杠上开花') mainText.classList.add('hu-gold-pulse');
        if (type === '抢杠胡') mainText.classList.add('hu-purple-flash');
    });

    if (specialTypes.includes('三金倒')) overlay.classList.add('flash-gold');
    if (specialTypes.includes('天胡') || specialTypes.includes('地胡')) overlay.classList.add('flash-red');
    if (flowerCount >= 5) overlay.classList.add('flash-blue');

    if (typeof startHuParticles === 'function') startHuParticles(specialTypes, flowerCount);
    if (dealerStreak >= 2) overlay.classList.add('hu-shake-strong');
}
