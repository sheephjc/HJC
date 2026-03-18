const TILE_EMOJI_MAP = Object.freeze({
    W: Object.freeze(['🀇', '🀈', '🀉', '🀊', '🀋', '🀌', '🀍', '🀎', '🀏']),
    T: Object.freeze(['🀙', '🀚', '🀛', '🀜', '🀝', '🀞', '🀟', '🀠', '🀡']),
    S: Object.freeze(['🀐', '🀑', '🀒', '🀓', '🀔', '🀕', '🀖', '🀗', '🀘']),
    Z: Object.freeze(['🀀', '🀁', '🀂', '🀃', '🀄', '🀅', '🀆']),
    H: Object.freeze(['🀢', '🀣', '🀤', '🀥', '🀦', '🀧', '🀨', '🀩'])
});

export function toTileEmoji(tileCode) {
    if (typeof tileCode !== 'string' || tileCode.length < 2) return String(tileCode ?? '');
    const suit = tileCode[0];
    const value = Number(tileCode.slice(1));
    const tiles = TILE_EMOJI_MAP[suit];
    if (!tiles || !Number.isInteger(value) || value < 1 || value > tiles.length) return tileCode;
    return tiles[value - 1];
}
