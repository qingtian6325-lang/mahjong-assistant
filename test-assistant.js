const assert = require('assert');
global.window = global;
require('./engine.js');
const E = window.MahjongEngine;

console.log('=== [UNIT TESTS] Full-Table Mahjong Assistant Engine ===');

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

// 2. Claim advice: Hu detection on opponent discard
const claimHu = E.evaluateOpponentDiscardClaim(
  [0, 1, 4, 4, 9, 10, 11, 18, 19, 20, 27, 27, 27], 0, 2, 'left', vc.visible, {}
);
assert.strictEqual(claimHu.canHu, true, '1-2万 waiting on 3万 should trigger Hu');
assert.strictEqual(claimHu.recommendedAction, 'hu');

// 3. Claim advice: Chi only allowed from 'left' (上家), never 'top' or 'right'
const claimChiLeft = E.evaluateOpponentDiscardClaim(
  [0, 1, 6, 8, 9, 10, 11, 18, 19, 20, 27, 27, 31], 0, 2, 'left', vc.visible, {}
);
assert.strictEqual(claimChiLeft.canChi, true, 'Left seat discard 3万 allows Chi with 1-2万');
assert.notStrictEqual(claimChiLeft.discardAfter, 2, 'Must not recommend discarding same tile 3万 after Chi');

const claimChiTop = E.evaluateOpponentDiscardClaim(
  [0, 1, 6, 8, 9, 10, 11, 18, 19, 20, 27, 27, 31], 0, 2, 'top', vc.visible, {}
);
assert.strictEqual(claimChiTop.canChi, false, 'Top seat discard must NOT allow Chi');

// 4. Claim advice: Peng allowed from any opponent ('top', 'right', 'left')
const claimPengTop = E.evaluateOpponentDiscardClaim(
  [0, 4, 8, 9, 10, 11, 18, 19, 20, 27, 27, 31, 31], 0, 31, 'top', vc.visible, {}
);
assert.strictEqual(claimPengTop.canPeng, true, 'Top seat discard 红中 allows Peng');

// 5. Opponent threat & danger detection (2 melds in bamboo -> bamboo live tiles flagged high risk)
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

// 6. Graceful handling of invalid/empty hand lengths during full-table updates
const invalidHandState = {
  myHand: [0, 1, 2],
  seats: {
    bottom: { melds: [], discards: [] },
    right:  { melds: [], discards: [5] },
    top:    { melds: [], discards: [] },
    left:   { melds: [], discards: [] }
  },
  latestEvent: null
};
const invalidRes = E.analyzeFullTable(invalidHandState);
assert.strictEqual(invalidRes.visibleCounts[5], 1, 'Tracks visible counts even when hand length is invalid');

console.log('ALL ENGINE UNIT TESTS PASSED');
