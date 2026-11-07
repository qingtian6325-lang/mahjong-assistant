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

// ================= E2E Browser Tests (Playwright) =================
(async () => {
  console.log('\n=== [E2E TESTS] Real-Time Full-Table Mahjong Monitor UI ===');
  const path = require('path');
  let chromium;
  try {
    chromium = require('playwright-core').chromium;
  } catch (e) {
    chromium = require(path.resolve(__dirname, '../elegant-babbage/node_modules/playwright-core')).chromium;
  }

  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  });
  const page = await browser.newPage({ viewport: { width: 430, height: 1180 } });

  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  const indexUrl = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');
  await page.goto(indexUrl);
  await page.waitForTimeout(300);

  // 1. Check Auto-Watch button, 5-zone overlay, and 4-seat sandbox exist
  const hasAutoWatchBtn = await page.locator('#btnAssistAutoWatch').count();
  assert.strictEqual(hasAutoWatchBtn, 1, '#btnAssistAutoWatch must exist');

  const hasZoneOverlay = await page.locator('#assistZoneOverlay').count();
  assert.strictEqual(hasZoneOverlay, 1, '#assistZoneOverlay 5-zone tactical grid must exist');

  const hasSandbox = await page.locator('#assistTableSandbox').count();
  assert.strictEqual(hasSandbox, 1, '#assistTableSandbox 4-seat board must exist');

  // 2. Toggle Auto-Watch mode on & verify state indicator updates without throwing
  await page.click('#btnAssistAutoWatch');
  await page.waitForTimeout(150);
  const watchActive = await page.evaluate(() => window.MahjongCameraAssist.isAutoWatching());
  assert.strictEqual(watchActive, true, 'Auto-watch should be active after clicking #btnAssistAutoWatch');

  // 3. Test 13-tile hand + recording opponent actions ("上家打三万", "下家碰红中")
  await page.evaluate(() => {
    window.MahjongCameraAssist.setTableState({
      myHand: [0, 1, 6, 8, 9, 10, 11, 18, 19, 20, 27, 27, 31],
      seats: {
        bottom: { melds: [], discards: [] },
        right:  { melds: [{ type: 'peng', tiles: [31, 31, 31] }], discards: [8] },
        top:    { melds: [], discards: [28] },
        left:   { melds: [], discards: [] }
      },
      latestEvent: null
    });
  });
  await page.waitForTimeout(150);

  // Select target mode: "⬅️ 上家打牌" and tap "三万" (tile 2) in palette
  await page.click('[data-target-mode="left-discard"]');
  await page.click('.assist-pal-item[data-ptile="2"]');
  await page.waitForTimeout(150);

  // Verify claim banner appears recommending Chi on 三万!
  const claimBannerText = await page.locator('#assistClaimBanner').innerText();
  assert.ok(claimBannerText.includes('三万'), 'Claim banner should mention 三万');
  assert.ok(claimBannerText.includes('吃'), 'Claim banner should advise Chi for 上家打三万');

  // Verify remaining badge on 红中 (tile 31): 1 in myHand + 3 in right.melds = 4 visible -> 剩0
  const hongzhongRemText = await page.locator('.assist-pal-item[data-ptile="31"] .pal-rem-badge').innerText();
  assert.ok(hongzhongRemText.includes('0') || hongzhongRemText.includes('绝'), '红中 should show 0 remaining / 绝张');

  // 4. Click "⚡ 一键执行推荐动作" (#btnExecuteClaim) and verify meld is added to bottom seat & hand updates to 10 tiles
  await page.click('#btnExecuteClaim');
  await page.waitForTimeout(150);
  const afterClaimState = await page.evaluate(() => window.MahjongCameraAssist.getTableState());
  assert.strictEqual(afterClaimState.seats.bottom.melds.length, 1, 'Bottom seat should now have 1 meld after executing Chi');
  assert.strictEqual(afterClaimState.myHand.length, 10, 'My hand should have 10 tiles after Chi + auto-discard');

  // 5. Load 4-seat Demo Game (#btnAssistDemoHand) to verify full-table claim banner + threat badges visually
  await page.click('#btnAssistDemoHand');
  await page.waitForTimeout(150);

  // 6. Test Keyless Built-in 5-Zone Vision Engine (No API Key required!)
  // Render a synthetic 5-zone camera frame (14 hand tiles at bottom + opponent discard in left zone) and run keyless recognition
  const keylessRecResult = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 450;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0c4d2d';
    ctx.fillRect(0, 0, 800, 450);

    // Draw 14 distinct tiles in the bottom hand zone (y: 66%..94%)
    const handTiles = [0, 4, 8, 9, 13, 17, 18, 22, 26, 27, 31, 32, 33, 33];
    const cropX = Math.floor(800 * 0.04);
    const cropW = Math.floor(800 * 0.92);
    const cropY = Math.floor(450 * 0.64);
    const cropH = Math.floor(450 * 0.32);
    const slotW = cropW / 14;

    for (let i = 0; i < 14; i++) {
      const t = handTiles[i];
      let svgStr = window.MahjongEngine.faceSVG(t);
      if (!svgStr.includes('xmlns=')) {
        svgStr = svgStr.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
      }
      const img = new Image();
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
      await new Promise(res => { img.onload = res; img.onerror = res; img.src = url; });
      const tx = cropX + i * slotW + 2;
      const ty = cropY + 6;
      const tw = slotW - 4;
      const th = cropH - 12;
      ctx.fillStyle = '#fdfaf2';
      ctx.fillRect(tx, ty, tw, th);
      ctx.drawImage(img, tx, ty, tw, th);
    }

    const res = await window.MahjongCameraAssist.recognizeCanvasKeyless(c, 14, 'full');
    return res;
  });

  assert.ok(keylessRecResult && Array.isArray(keylessRecResult.myHand), 'Keyless vision engine must return myHand array');
  assert.strictEqual(keylessRecResult.myHand.length, 14, 'Keyless vision engine must recognize 14 tiles');
  // Check that key signature tiles (红中 31, 发财 32, 白板 33, 万子, 条子, 筒子) are accurately classified
  assert.ok(keylessRecResult.myHand.includes(31), 'Keyless vision must accurately recognize 红中 (31)');
  assert.ok(keylessRecResult.myHand.includes(32), 'Keyless vision must accurately recognize 发财 (32)');
  assert.ok(keylessRecResult.myHand.includes(33), 'Keyless vision must accurately recognize 白板 (33)');

  await page.screenshot({ path: path.resolve(__dirname, 'test-full-table-monitor.png'), fullPage: true });
  await browser.close();

  assert.strictEqual(pageErrors.length, 0, 'Zero page errors expected, got: ' + pageErrors.join('; '));
  console.log('ALL E2E UI TESTS PASSED');
})();

