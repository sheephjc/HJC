# Realtime Database 数据契约（首版）

```
rooms/{roomCode}/meta
rooms/{roomCode}/seats/{seatId}
rooms/{roomCode}/game/state
rooms/{roomCode}/game/version
rooms/{roomCode}/actions/{actionId}
rooms/{roomCode}/presence/{uid}
rooms/{roomCode}/memberUids/{uid}
```

## 字段说明
- `meta.hostUid`: 当前房主 uid（房主写权威状态）
- `meta.status`: `waiting | playing`
- `seats/{seatId}`: `uid/reservedUid/nickname/isBot/online/control`
- `game.version`: 权威状态版本号（单调递增）
- `actions/{actionId}`: 玩家动作意图（pending/processed）
- `presence/{uid}`: 在线心跳与座位绑定

## game.state（当前实现）
- `phase`: `playing | ended`
- `roundNo`: 当前局序号
- `dealerSeat / dealerStreak`: 庄位与连庄信息
- `turnSeat`: 当前轮到的座位
- `goldTile`: 金牌（字符串编码）
- `wall`: 余牌墙（字符串数组）
- `hands/rivers/flowers/shows`: 四家牌面数据
- `scores`: 四家累计分数
- `seatControls`: 每个座位 `human | bot`
- `pendingClaim`: 弃牌后响应窗口（options/decisions/expiresAt）
- `outcome`: 局终结果（赢家、胡牌类型、输赢分、庄更新前后）
- `lastAction/lastDiscard/actionLog`: 最近动作追踪

## AI 接管约定
- 人类在线：`control = human`
- 人类离线：`control = bot`
- 同 uid 回归：恢复 `control = human`
