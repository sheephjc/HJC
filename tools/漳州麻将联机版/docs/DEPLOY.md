# Online Build Deployment Guide

## 1. Preconditions
- Fill `src/firebase-config.js` with the real Firebase Web App config.
- Enable Anonymous Authentication in Firebase Auth.
- Publish `firebase-rules.json` to the target Realtime Database.

## 2. Local Verification
Run from repo root:

```powershell
npm.cmd test
```

Expected checks include config/rules/text/readiness/stability.

## 3. Entry Pages
- Lobby: `online/index.html`
- Battle: `online/game.html`
- Debug: `online/game-debug.html`

Flow:
- Battle create/join stays on lobby waiting panel first.
- Host starts match, then all users enter `game.html`.
- Debug create/join goes directly to `game-debug.html`.

## 4. Cache Version
All entry pages should share one cache version token.

Current token: `20260313r22`

When frontend assets change, bump the same token in:
- lobby html
- battle html
- debug html
- singleplayer html

## 5. Post Deploy Smoke
Minimum checklist:
- create/join room
- seat switch in waiting state
- start match by host
- discard/reaction/settlement
- next round
- leave room to lobby

## 6. Common Issues
- `permission_denied`
  - Re-publish latest rules.
  - Confirm uid is room member and write path is allowed.
- stale frontend
  - Verify cache token is bumped consistently.
  - Hard refresh browser cache.

