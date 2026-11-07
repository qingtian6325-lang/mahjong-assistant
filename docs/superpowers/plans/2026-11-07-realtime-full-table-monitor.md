# Real-Time Full-Table Mahjong Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `mahjong-assistant` into a real-time full-table Mahjong tactical assistant that continuously watches all 4 seats (discards, Chi/Peng/Gang melds, and own hand) via motion-stabilized live camera + 1-tap/voice sandbox and delivers instant claim (Chi/Peng/Gang/Hu) and attack/defense discard advice.

**Architecture:** Extend `engine.js` with `analyzeFullTable(tableState)` to compute full-table visible/remaining tile counts, opponent threat profiles (flush/honor tendencies and safe/dangerous tiles), instant claim evaluation when any opponent discards a tile, and risk-aware Top-3 discard recommendations. Upgrade `index.html`, `camera-assist.js`, and `style.css` with a 64x36 frame-stability auto-watch loop, 5-zone viewfinder overlay (Left/Top/Right/Center/Bottom), 4-seat interactive tactical sandbox, target-action quick-selector + Web Speech voice input/output.

**Tech Stack:** Vanilla ES5/ES6 JavaScript, HTML5 Canvas & WebRTC (`getUserMedia`), Web Speech API (`speechSynthesis` & `SpeechRecognition`), Playwright (`playwright-core`) + Node `assert` for automated tests.

**Spec:** `c:\Users\hp\Documents\antigravity\mahjong-assistant\docs\superpowers\specs\2026-11-07-realtime-full-table-monitor-design.md`

## Global Constraints

- Do not modify the original `elegant-babbage` repository; all changes stay inside `c:\Users\hp\Documents\antigravity\mahjong-assistant`.
- Pure static frontend architecture compatible with GitHub Pages (`https://qingtian6325-lang.github.io/mahjong-assistant/`).
- Frame stability debounce must prevent erratic recognition while a player's hand is moving in front of the camera.
- Incremental merge must preserve recorded opponent discards/melds when a single camera frame partially occludes the table.

## Review Focus

- Total visible copies of any tile across `myHand` + all 4 seats' `melds` and `discards` exceeding 4 (e.g. duplicate manual entry or noisy CV frame): `computeVisibleCounts` must clamp each tile's visible count to `0..4` and remaining count to `0..4`.
- Chi claim eligibility rule: `evaluateOpponentDiscardClaim` must only allow `canChi` when `fromSeat === 'left'` (上家), never when `fromSeat` is `'top'` (对家) or `'right'` (下家), while `canPeng`, `canGang`, and `canHu` apply to all three opponents (`left`, `top`, `right`).
- Forbidden same-tile discard after Chi/Peng: when simulating the discard immediately following a Chi or Peng of tile `T`, the AI must not recommend immediately discarding `T` itself.
- Empty or invalid hand counts (e.g. 12 tiles) during full-table updates: `analyzeFullTable` must still return valid `visibleCounts`, `remainingByTile`, and `opponentThreats` without throwing.
- Auto-watch loop when camera stream is not active: enabling auto-watch must gracefully prompt or start the camera without throwing unhandled promise rejections on headless/no-camera devices.

---

### Task 1: Full-Table Tactical Engine (`engine.js` & Unit Tests)

**Files:**
- Modify: `c:\Users\hp\Documents\antigravity\mahjong-assistant\engine.js`
- Create: `c:\Users\hp\Documents\antigravity\mahjong-assistant\test-assistant.js`

**Interfaces:**
- Consumes: existing `countsOf`, `canWinHand`, `canWinWithTile`, `analyzeTing`, `findChiOptions`, `handValue`, `tileName`, `WILD` in `engine.js`.
- Produces on `window.MahjongEngine`:
  - `computeVisibleCounts(tableState) -> { visible: number[35], remaining: number[35] }`
  - `analyzeOpponentThreats(tableState, visibleCounts) -> { seats: { left, top, right }, dangerByTile: Object<number, { level: 'safe'|'low'|'medium'|'high', label: string, penalty: number, reasons: string[] }> }`
  - `evaluateOpponentDiscardClaim(hand, meldCount, discardedTile, fromSeat, visibleCounts, dangerByTile) -> { tile: number, tileName: string, fromSeat: string, canHu: boolean, canGang: boolean, canPeng: boolean, canChi: boolean, recommendedAction: 'hu'|'gang'|'peng'|'chi'|'pass', recommendedMeld: number[]|null, discardAfter: number|null, discardAfterName: string|null, headline: string, reason: string, options: Array }`
  - `analyzeFullTable(tableState) -> { visibleCounts: number[35], remainingByTile: number[35], deadTiles: number[], opponentThreats: Object, claimAdvice: Object|null, handAnalysis: Object, voiceSummary: string }`

- [ ] **Step 1: Write the failing unit tests in `c:\Users\hp\Documents\antigravity\mahjong-assistant\test-assistant.js`**

```javascript
const assert = require('assert');
global.window = global;
require('./engine.js');
const E = window.MahjongEngine;

// 1. Visible & remaining tile clamping (0..4)
const state1 = {
  myHand: [0, 0, 1, 2, 9, 10, 11, 18, 19, 20, 27, 27, 31],
  seats: {
    bottom: { melds: [], discards: [0] },
    right:  { melds: [{ type: 'peng', tiles: [0, 0, 0] }], discards: [5] },
    top:    { melds: [], discards: [31, 31] },
    left:   { melds: [{ type: 'chi', tiles: [9, 10, 11] }], discards: [2] }
  },
  latestEvent: { seat: 'left', type: 'discard', tile: 2 }
};
const vc = E.computeVisibleCounts(state1);
assert.strictEqual(vc.visible[0], 4, 'Tile 0 clamped to max 4 visible');
assert.strictEqual(vc.remaining[0], 0, 'Tile 0 has 0 remaining (dead tile)');
assert.strictEqual(vc.remaining[31], 1, 'Red Dragon (31) has 1 remaining');

// 2. Claim advice: Chi only allowed from 'left' (上家), Peng/Hu from any opponent
const claimLeft = E.evaluateOpponentDiscardClaim(
  [0, 1, 4, 5, 9, 10, 11, 18, 19, 20, 27, 27, 27], 0, 2, 'left', vc.visible, {}
);
assert.strictEqual(claimLeft.canHu, true, '1-2万 waiting on 3万 should trigger Hu');
assert.strictEqual(claimLeft.recommendedAction, 'hu');

const claimChiLeft = E.evaluateOpponentDiscardClaim(
  [0, 1, 6, 8, 9, 10, 11, 18, 19, 20, 27, 27, 31], 0, 2, 'left', vc.visible, {}
);
assert.strictEqual(claimChiLeft.canChi, true, 'Left seat discard 3万 allows Chi with 1-2万');

const claimChiTop = E.evaluateOpponentDiscardClaim(
  [0, 1, 6, 8, 9, 10, 11, 18, 19, 20, 27, 27, 31], 0, 2, 'top', vc.visible, {}
);
assert.strictEqual(claimChiTop.canChi, false, 'Top seat discard must NOT allow Chi');

// 3. Opponent threat & danger detection (2 melds in bamboo -> bamboo live tiles flagged high risk)
const threatState = {
  myHand: [0, 1, 2, 9, 10, 11, 14, 18, 19, 20, 27, 27, 27, 31],
  seats: {
    bottom: { melds: [], discards: [] },
    right:  {
      melds: [
        { type: 'peng', tiles: [12, 12, 12] },
        { type: 'chi', tiles: [15, 16, 17] }
      ],
      discards: [0, 4, 18, 22] // discarded wan & tong, 0 bamboo discards
    },
    top:  { melds: [], discards: [14] },
    left: { melds: [], discards: [] }
  },
  latestEvent: null
};
const full = E.analyzeFullTable(threatState);
assert.ok(full.opponentThreats.seats.right.warning.includes('条'), 'Right opponent flagged for bamboo concentration');
assert.ok(full.handAnalysis.recommendations.length > 0, 'Returns discard recommendations');
assert.ok(full.handAnalysis.recommendations[0].dangerLabel, 'Recommendations include dangerLabel');
console.log('ALL ENGINE UNIT TESTS PASSED');
```

- [ ] **Step 2: Run unit test to verify it fails**

Run: `node c:\Users\hp\Documents\antigravity\mahjong-assistant\test-assistant.js`
Expected: FAIL with `TypeError: E.computeVisibleCounts is not a function`

- [ ] **Step 3: Implement `computeVisibleCounts`, `analyzeOpponentThreats`, `evaluateOpponentDiscardClaim`, and `analyzeFullTable` in `c:\Users\hp\Documents\antigravity\mahjong-assistant\engine.js`**

Implement the 4 functions and export them on `window.MahjongEngine`:
- `computeVisibleCounts(tableState)` sums tiles in `tableState.myHand` and every seat's `melds` + `discards`, clamping `visible[t]` to `0..4` and `remaining[t] = 4 - visible[t]`.
- `analyzeOpponentThreats(tableState, visibleCounts)` inspects `left`, `top`, `right`: counts melds, checks if melds + few discards concentrate in one suit (`万`/`条`/`筒`) or honors (`字牌`), marks tiles discarded by all dangerous opponents as `'safe'` (`🛡️ 现物熟张`), terminals/honors with ≥2 visible as `'low'`, and live middle tiles in a threatening opponent's focused suit as `'high'` (`🚨 点炮高危`).
- `evaluateOpponentDiscardClaim(hand, meldCount, discardedTile, fromSeat, visibleCounts, dangerByTile)` checks `canWinWithTile` (Hu), 3-in-hand (Gang), 2-in-hand (Peng), and `fromSeat === 'left'` `findChiOptions` (Chi). Simulates each claim and the optimal subsequent discard (forbidding `discardedTile` itself), compares Ting width and 13-tile evaluation score against passing, and returns the structured recommendation.
- `analyzeFullTable(tableState)` orchestrates `computeVisibleCounts`, `analyzeOpponentThreats`, `evaluateOpponentDiscardClaim` (when `latestEvent` is an opponent `'discard'`), and `analyzeAssistantHand` (enriched with `dangerByTile` penalties/labels and dead-tile warnings), plus a concise `voiceSummary` string.

- [ ] **Step 4: Run unit test to verify it passes**

Run: `node c:\Users\hp\Documents\antigravity\mahjong-assistant\test-assistant.js`
Expected: PASS (`ALL ENGINE UNIT TESTS PASSED`)

- [ ] **Step 5: Commit Task 1**

```powershell
Set-Location c:\Users\hp\Documents\antigravity\mahjong-assistant
git add engine.js test-assistant.js
git commit -m "feat(engine): add full-table visible counter, opponent threat analyzer & instant claim advisor"
```

---

### Task 2: Real-Time Auto-Watch Loop, 5-Zone Vision, 4-Seat Sandbox & E2E Verification (`index.html`, `camera-assist.js`, `style.css`)

**Files:**
- Modify: `c:\Users\hp\Documents\antigravity\mahjong-assistant\index.html`
- Modify: `c:\Users\hp\Documents\antigravity\mahjong-assistant\camera-assist.js`
- Modify: `c:\Users\hp\Documents\antigravity\mahjong-assistant\style.css`
- Modify: `c:\Users\hp\Documents\antigravity\mahjong-assistant\test-assistant.js`

**Interfaces:**
- Consumes: `MahjongEngine.analyzeFullTable`, `MahjongEngine.computeVisibleCounts`, `MahjongEngine.evaluateOpponentDiscardClaim`, `MahjongEngine.tileHTML`, `MahjongEngine.tileName`.
- Produces on `window.MahjongCameraAssist`:
  - `getTableState() -> tableState`
  - `setTableState(newState)`
  - `recordSeatAction(seat, actionType, tiles)` (`seat`: `'left'|'top'|'right'|'bottom'`, `actionType`: `'discard'|'chi'|'peng'|'gang'`)
  - `toggleAutoWatch(forceState) -> boolean`
  - `executeClaimRecommendation()`

- [ ] **Step 1: Extend `c:\Users\hp\Documents\antigravity\mahjong-assistant\test-assistant.js` with Playwright E2E tests**

Add browser E2E checks verifying:
1. 5-zone viewfinder overlay (`#assistZoneOverlay`), Auto-Watch toggle (`#btnAssistAutoWatch`), and Voice broadcast toggle (`#btnAssistVoiceOut`) render and toggle cleanly.
2. 4-seat full-table tactical sandbox (`#assistTableSandbox`) renders all 4 seats (`left`, `top`, `right`, `bottom`) with their melds, discards, and threat badges.
3. Recording `"上家打三万"` via `recordSeatAction('left', 'discard', [2])` or clicking the quick-target mode (`⬅️ 上家打牌` + clicking tile `2`) immediately displays the top-priority **⚡ 吃/碰/杠/胡 实时拦截建议** card (`#assistClaimBanner`) and updates remaining tile badges on the palette.
4. Clicking `⚡ 一键执行推荐动作` applies the claim to `bottom.melds`, removes the claimed/discarded tiles from `myHand`, and refreshes the analysis.

- [ ] **Step 2: Run test to verify the E2E assertions fail before UI implementation**

Run: `node c:\Users\hp\Documents\antigravity\mahjong-assistant\test-assistant.js`
Expected: FAIL on missing `#btnAssistAutoWatch` / `#assistTableSandbox`

- [ ] **Step 3: Implement the Real-Time Full-Table UI, Auto-Watch Engine, and 4-Seat Sandbox in `index.html`, `camera-assist.js`, and `style.css`**

- In `index.html`:
  - Add the live monitor status bar & controls (`🔴 开启实时盯盘`, `🔊 语音报招`, `🎙️ 语音指令`, scan mode selector `全桌五区俯拍 / 自家手牌特写`).
  - Add the 5-zone tactical guide overlay inside `.assist-viewfinder` (`上家(左)`, `对家(上)`, `下家(右)`, `中央牌河`, `自家手牌(下)`).
  - Add the **Four-Seat Full-Table Sandbox (`#assistTableSandbox`)** showing each player's melds, discard river, and AI threat badge, plus an Undo (`↩️ 撤销上一手`) & Reset Table (`🔄 新一局`) button.
  - Add the **Quick Target Mode Bar (`#assistTargetModeBar`)** above the tile keyboard so tapping any tile in the palette can either edit/draw own hand OR instantly record `⬅️上家打` / `⬅️上家吃碰` / `⬆️对家打` / `⬆️对家吃碰` / `➡️下家打` / `➡️下家吃碰` / `⬇️自家吃碰`, with remaining-count badges (`剩X`) on every tile in the palette.
- In `camera-assist.js`:
  - Implement the 250ms `64x36` frame-diff & stability detector (`startAutoWatchLoop` / `stopAutoWatchLoop`) that triggers recognition automatically ~600ms after hand motion settles.
  - Upgrade `recognizeTilesWithGemini` to support full-table JSON (`myHand`, `seats.{left,top,right,bottom}.{melds,discards}`, `latestAction`) and incremental merge (`mergeRecognizedTableState`).
  - Upgrade local CV to scan the 5 zones and detect newly added center/side discards in full-table mode.
  - Implement Web Speech TTS (`speakAdvice`) and `SpeechRecognition` voice command parser (parsing phrases like `"上家打三万"`, `"对家碰红中"`, `"下家吃二三四条"`, `"我摸五筒"`).
- In `style.css`:
  - Add responsive styling for the 5-zone camera overlay, auto-watch pulsing indicator, 4-seat tactical sandbox, claim interception banner, danger badges (`safe`, `low`, `medium`, `high`), and palette remaining-tile counters.

- [ ] **Step 4: Run unit + E2E tests and visual screenshot inspection**

Run: `node c:\Users\hp\Documents\antigravity\mahjong-assistant\test-assistant.js`
Expected: PASS all unit and Playwright E2E assertions with zero console/page errors.

- [ ] **Step 5: Commit & push to GitHub Pages**

```powershell
Set-Location c:\Users\hp\Documents\antigravity\mahjong-assistant
git add index.html camera-assist.js engine.js style.css test-assistant.js docs/superpowers/plans/2026-11-07-realtime-full-table-monitor.md
git commit -m "feat: real-time full-table 4-seat monitor, auto-watch frame stability & instant claim/defense AI"
git push origin main
```
