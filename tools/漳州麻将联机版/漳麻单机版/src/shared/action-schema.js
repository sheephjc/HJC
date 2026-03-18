export const ACTION_TYPES = Object.freeze([
    'ROUND_START',
    'OPEN_GOLD',
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

export function createAction({ type, seatId, payload = {}, clientActionId = '', ts = Date.now() }) {
    if (!ACTION_TYPES.includes(type)) {
        throw new Error(`Unknown action type: ${type}`);
    }
    return { type, seatId, payload, clientActionId, ts };
}
