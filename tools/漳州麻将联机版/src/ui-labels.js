export function roomStatusLabel(status) {
    const value = String(status || 'waiting');
    if (value === 'waiting') return '等待中';
    if (value === 'playing') return '对局中';
    if (value === 'closed') return '已关闭';
    return value;
}

const DEBUG_ACTION_LABEL_MAP = Object.freeze({
    DISCARD: '出牌',
    PASS: '过',
    HU: '胡牌',
    CHI: '吃',
    PENG: '碰',
    GANG: '杠',
    AN_GANG: '暗杠',
    BU_GANG: '补杠',
    FLOWER_REPLENISH: '补花',
    ROUND_START: '下一局'
});

export function debugActionLabel(type) {
    const key = String(type || '').toUpperCase();
    return DEBUG_ACTION_LABEL_MAP[key] || key;
}

const DEBUG_PRESET_LABEL_MAP = Object.freeze({
    DISCARD_0: '出第1张',
    PASS: '过',
    HU: '胡牌',
    FLOWER_REPLENISH: '补花',
    AN_GANG_W1: '暗杠 W1',
    BU_GANG_W1: '补杠 W1',
    ROUND_START: '下一局'
});

export function debugPresetLabel(presetKey) {
    const key = String(presetKey || '').toUpperCase();
    return DEBUG_PRESET_LABEL_MAP[key] || key;
}
