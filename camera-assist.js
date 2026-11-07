/**
 * Real-Life Camera Mahjong Assistant (📷 实景相机识牌军师)
 * Supports Live WebRTC Camera (getUserMedia), Photo Upload,
 * Dual Recognition Engine (Local Color/Feature CV + Optional Gemini Vision API),
 * One-Tap Instant Tile Correction, Top-3 Master AI Discard Recommendations,
 * and Turn-by-Turn Real-Life Game Tracking (打出 -> 摸入跟牌).
 */
(function() {
  'use strict';

  var stream = null;
  var assistHand = [0, 1, 2, 4, 5, 9, 10, 11, 18, 19, 20, 27, 27, 31]; // Default 14-tile demo hand
  var assistMeldCount = 0;
  var selectedSlotIndex = -1; // -1 means append mode; >= 0 means replace that slot in assistHand
  var isRecognizing = false;

  var NAME_TO_TILE = {
    '一万': 0, '1万': 0, '二万': 1, '2万': 1, '三万': 2, '3万': 2,
    '四万': 3, '4万': 3, '五万': 4, '5万': 4, '六万': 5, '6万': 5,
    '七万': 6, '7万': 6, '八万': 7, '8万': 7, '九万': 8, '9万': 8,
    '一条': 9, '1条': 9, '幺鸡': 9, '一索': 9, '二条': 10, '2条': 10, '二索': 10,
    '三条': 11, '3条': 11, '三索': 11, '四条': 12, '4条': 12, '四索': 12,
    '五条': 13, '5条': 13, '五索': 13, '六条': 14, '6条': 14, '六索': 14,
    '七条': 15, '7条': 15, '七索': 15, '八条': 16, '8条': 16, '八索': 16,
    '九条': 17, '9条': 17, '九索': 17,
    '一筒': 18, '1筒': 18, '一饼': 18, '二筒': 19, '2筒': 19, '二饼': 19,
    '三筒': 20, '3筒': 20, '三饼': 20, '四筒': 21, '4筒': 21, '四饼': 21,
    '五筒': 22, '5筒': 22, '五饼': 22, '六筒': 23, '6筒': 23, '六饼': 23,
    '七筒': 24, '7筒': 24, '七饼': 24, '八筒': 25, '8筒': 25, '八饼': 25,
    '九筒': 26, '9筒': 26, '九饼': 26,
    '东': 27, '东风': 27, '南': 28, '南风': 28, '西': 29, '西风': 29, '北': 30, '北风': 30,
    '中': 31, '红中': 31, '发': 32, '发财': 32, '發': 32, '白': 33, '白板': 33, '白皮': 33,
    '飞': 34, '飛': 34, '飞牌': 34, '百搭': 34
  };

  function getSavedGeminiKey() {
    try {
      return localStorage.getItem('mj_gemini_api_key') || '';
    } catch (e) {
      return '';
    }
  }

  function saveGeminiKey(k) {
    try {
      localStorage.setItem('mj_gemini_api_key', (k || '').trim());
    } catch (e) {}
  }

  /* ================= Camera Lifecycle ================= */
  async function startCamera() {
    var video = document.getElementById('assistCameraVideo');
    var statusEl = document.getElementById('assistCameraStatus');
    var placeholderEl = document.getElementById('assistCameraPlaceholder');
    if (!video) return false;

    stopCamera();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (statusEl) statusEl.textContent = '⚠️ 当前浏览器环境不支持直接视频流，请点击「🖼️ 拍照/相册上传」读取手牌';
      return false;
    }

    try {
      if (statusEl) statusEl.textContent = '📷 正在开启摄像头...';
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
      } catch (envErr) {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      video.srcObject = stream;
      await video.play();
      video.style.display = 'block';
      if (placeholderEl) placeholderEl.style.display = 'none';
      if (statusEl) statusEl.textContent = '✅ 摄像头已就绪：将手牌排成一排对准取景框，点击「📸 立即识别」';
      return true;
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = 'ℹ️ 未授予相机权限或设备无摄像头，可直接点击「🖼️ 拍照/传图」或下方牌库选牌';
      }
      return false;
    }
  }

  function stopCamera() {
    if (stream) {
      try {
        stream.getTracks().forEach(function(tr) { tr.stop(); });
      } catch (e) {}
      stream = null;
    }
    var video = document.getElementById('assistCameraVideo');
    var placeholderEl = document.getElementById('assistCameraPlaceholder');
    if (video) {
      video.srcObject = null;
      video.style.display = 'none';
    }
    if (placeholderEl) placeholderEl.style.display = 'flex';
  }

  /* ================= Local Computer Vision Tile Analyzer ================= */
  function classifySingleTilePatch(ctx, x, y, w, h) {
    var imgData = ctx.getImageData(Math.max(0, Math.floor(x)), Math.max(0, Math.floor(y)), Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)));
    var data = imgData.data;

    // Ignore outer 14% border of each tile to focus on engraved face symbols
    var padX = Math.floor(w * 0.14);
    var padY = Math.floor(h * 0.12);
    var innerW = Math.max(1, w - padX * 2);
    var innerH = Math.max(1, h - padY * 2);
    var totalPixels = innerW * innerH;

    var redTop = 0, redBot = 0;
    var greenTop = 0, greenBot = 0;
    var blueCount = 0;
    var darkTop = 0, darkBot = 0;

    for (var py = padY; py < h - padY; py++) {
      var isTop = py < (h * 0.52);
      for (var px = padX; px < w - padX; px++) {
        var idx = (py * Math.floor(w) + px) * 4;
        var r = data[idx], g = data[idx + 1], b = data[idx + 2];
        var lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 205) continue; // White / ivory tile background

        var maxC = Math.max(r, g, b);
        var minC = Math.min(r, g, b);
        var sat = maxC - minC;

        if (r > g + 28 && r > b + 28) {
          if (isTop) redTop++; else redBot++;
        } else if (g > r + 16 && g > b + 12) {
          if (isTop) greenTop++; else greenBot++;
        } else if (b > r + 18 && b > g + 6) {
          blueCount++;
        } else if (lum < 115 && sat < 35) {
          if (isTop) darkTop++; else darkBot++;
        }
      }
    }

    var redRatio = (redTop + redBot) / totalPixels;
    var greenRatio = (greenTop + greenBot) / totalPixels;
    var blueRatio = blueCount / totalPixels;
    var darkRatio = (darkTop + darkBot) / totalPixels;
    var inkRatio = redRatio + greenRatio + blueRatio + darkRatio;

    // 1. Very low ink -> 白板 (33)
    if (inkRatio < 0.025) {
      return 33;
    }

    // 2. 万子 (Characters: dark/blue top numeral + red 萬 character at bottom)
    if (redBot > redTop * 1.25 && (darkTop + blueCount * 0.5) > totalPixels * 0.015 && redRatio > 0.02) {
      var topComplexity = (darkTop + blueCount * 0.4) / (totalPixels * 0.5);
      var wanRank = Math.min(8, Math.max(0, Math.round((topComplexity - 0.03) / 0.024)));
      return wanRank; // 0..8 (一万..九万)
    }

    // 3. 纯红字 -> 红中 (31)
    if (redRatio > 0.035 && greenRatio < 0.02 && blueRatio < 0.02) {
      return 31;
    }

    // 4. 绿色主调 -> 发财 (32) 或 条子 (9..17)
    if (greenRatio > 0.022 && greenRatio >= blueRatio * 1.1) {
      if (greenRatio > 0.14 && redRatio < 0.01) {
        return 32; // 发财
      }
      var bambooInk = greenRatio + redRatio * 0.8;
      var tiaoRank = Math.min(8, Math.max(0, Math.round((bambooInk - 0.03) / 0.022)));
      return 9 + tiaoRank; // 9..17 (一条..九条)
    }

    // 5. 蓝/彩圆筒 -> 筒子 (18..26)
    if (blueRatio > 0.018 || (blueRatio + redRatio > 0.04 && greenRatio > 0.01)) {
      var pipInk = blueRatio + redRatio * 0.7 + greenRatio * 0.5;
      var tongRank = Math.min(8, Math.max(0, Math.round((pipInk - 0.025) / 0.024)));
      return 18 + tongRank; // 18..26 (一筒..九筒)
    }

    // 6. 黑色书法风牌 -> 东南西北 (27..30)
    if (darkRatio > 0.035) {
      var windIdx = Math.min(3, Math.max(0, Math.floor(((darkTop - darkBot) / totalPixels + 0.04) * 35) % 4));
      return 27 + windIdx;
    }

    // Default fallback based on dominant channel
    var fallbackRank = Math.min(8, Math.max(0, Math.round(inkRatio * 40)));
    if (redBot > greenBot) return fallbackRank;
    if (greenBot >= blueCount) return 9 + fallbackRank;
    return 18 + fallbackRank;
  }

  function recognizeTilesLocallyFromCanvas(sourceCanvas, targetCount) {
    targetCount = targetCount || 14;
    var sw = sourceCanvas.width;
    var sh = sourceCanvas.height;

    // Extract middle horizontal strip corresponding to the alignment box
    var cropX = Math.floor(sw * 0.04);
    var cropW = Math.floor(sw * 0.92);
    var cropY = Math.floor(sh * 0.25);
    var cropH = Math.floor(sh * 0.50);

    var workCanvas = document.createElement('canvas');
    workCanvas.width = 700;
    workCanvas.height = 140;
    var ctx = workCanvas.getContext('2d');
    ctx.drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, workCanvas.width, workCanvas.height);

    var slotW = workCanvas.width / targetCount;
    var result = [];
    for (var i = 0; i < targetCount; i++) {
      var tx = i * slotW;
      var tileCode = classifySingleTilePatch(ctx, tx, 8, slotW, workCanvas.height - 16);
      result.push(tileCode);
    }
    return result.sort(function(a, b) { return a - b; });
  }

  /* ================= Optional Gemini Vision API High-Accuracy Recognition ================= */
  async function recognizeTilesWithGemini(sourceCanvas, apiKey, targetCount) {
    var base64Jpeg = sourceCanvas.toDataURL('image/jpeg', 0.82).split(',')[1];
    var prompt = '你是一个专业的麻将牌图像识别助手。请从左到右读取图片中一排麻将手牌（共约' + (targetCount || 14) + '张）。' +
      '只返回严格的JSON字符串数组，例如：["一万","二万","三条","四条","五筒","东风","红中"]。' +
      '牌名只能使用：一万~九万、一条~九条、一筒~九筒、东风、南风、西风、北风、红中、发财、白板、飞牌。不要输出任何其他解释文字。';

    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(apiKey);
    var resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/jpeg', data: base64Jpeg } }
          ]
        }],
        generationConfig: {
          temperature: 0.1
        }
      })
    });

    if (!resp.ok) {
      throw new Error('Gemini API 请求失败 (' + resp.status + ')');
    }
    var json = await resp.json();
    var rawText = '';
    try {
      rawText = json.candidates[0].content.parts[0].text || '';
    } catch (e) {}

    var match = rawText.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('未能从AI返回中解析到麻将牌数组');
    var names = JSON.parse(match[0]);
    var parsed = [];
    for (var i = 0; i < names.length; i++) {
      var clean = String(names[i]).trim();
      if (NAME_TO_TILE[clean] !== undefined) {
        parsed.push(NAME_TO_TILE[clean]);
      }
    }
    if (parsed.length === 0) throw new Error('未能匹配有效麻将牌名');
    return parsed.sort(function(a, b) { return a - b; });
  }

  /* ================= Capture Frame & Run Recognition ================= */
  async function captureAndRecognize(sourceEl, isImageElement) {
    if (isRecognizing) return;
    var statusEl = document.getElementById('assistCameraStatus');
    var countSel = document.getElementById('assistTargetCountSelect');
    var targetCount = countSel ? parseInt(countSel.value, 10) : 14;

    var snapCanvas = document.getElementById('assistSnapCanvas');
    if (!snapCanvas) {
      snapCanvas = document.createElement('canvas');
    }

    var w = isImageElement ? (sourceEl.naturalWidth || sourceEl.width || 800) : (sourceEl.videoWidth || 800);
    var h = isImageElement ? (sourceEl.naturalHeight || sourceEl.height || 450) : (sourceEl.videoHeight || 450);
    if (!w || !h) {
      if (statusEl) statusEl.textContent = '⚠️ 尚未获取到相机画面，请先开启摄像头或点击「🖼️ 拍照/传图」';
      return;
    }

    snapCanvas.width = w;
    snapCanvas.height = h;
    var ctx = snapCanvas.getContext('2d');
    ctx.drawImage(sourceEl, 0, 0, w, h);

    // Show captured preview inside viewfinder
    snapCanvas.style.display = 'block';

    var keyInput = document.getElementById('assistGeminiKeyInput');
    var apiKey = keyInput ? keyInput.value.trim() : getSavedGeminiKey();
    if (apiKey) saveGeminiKey(apiKey);

    isRecognizing = true;
    try {
      if (apiKey) {
        if (statusEl) statusEl.textContent = '🤖 正在使用 Gemini 视觉大模型高精度识牌...';
        try {
          var aiTiles = await recognizeTilesWithGemini(snapCanvas, apiKey, targetCount);
          assistHand = aiTiles;
          selectedSlotIndex = -1;
          renderAssistAll();
          if (statusEl) statusEl.textContent = '✅ AI 识牌完成（共 ' + aiTiles.length + ' 张）！如有个别反光误差，点击手牌即可一键秒改';
          if (window.MahjongAudio && window.MahjongAudio.playClick) window.MahjongAudio.playClick();
          isRecognizing = false;
          return;
        } catch (aiErr) {
          console.warn('Gemini recognition fallback to local CV:', aiErr);
        }
      }

      if (statusEl) statusEl.textContent = '🔍 正在使用本地色彩/纹理特征引擎识牌...';
      var localTiles = recognizeTilesLocallyFromCanvas(snapCanvas, targetCount);
      assistHand = localTiles;
      selectedSlotIndex = -1;
      renderAssistAll();
      if (statusEl) {
        statusEl.textContent = '✅ 本地特征识牌完成（' + localTiles.length + '张）！点击上方任意一张手牌可在下方牌库一键秒改校正';
      }
      if (window.MahjongAudio && window.MahjongAudio.playClick) window.MahjongAudio.playClick();
    } finally {
      isRecognizing = false;
    }
  }

  /* ================= Render Hand, Palette & Master AI Recommendations ================= */
  function renderAssistHand() {
    var container = document.getElementById('assistHandRow');
    var countBadge = document.getElementById('assistHandCountBadge');
    var hintEl = document.getElementById('assistEditModeHint');
    if (!container || !window.MahjongEngine) return;

    assistHand.sort(function(a, b) { return a - b; });
    assistMeldCount = Math.max(0, Math.floor((14 - assistHand.length) / 3));

    if (countBadge) {
      var mod = assistHand.length % 3;
      var stateText = (mod === 2) ? '（当前该您出牌）' : ((mod === 1) ? '（当前等待摸牌/吃碰）' : '（牌数需为 13/14 或 10/11、7/8 张）');
      countBadge.textContent = '当前手牌：' + assistHand.length + ' 张 ' + stateText;
    }

    if (hintEl) {
      if (selectedSlotIndex >= 0 && selectedSlotIndex < assistHand.length) {
        hintEl.innerHTML = '🎯 正在替换第 <b>' + (selectedSlotIndex + 1) + '</b> 张【' +
          window.MahjongEngine.tileName(assistHand[selectedSlotIndex]) +
          '】——请点击下方牌库直接替换，或 <a href="javascript:void(0)" id="assistCancelSlotBtn" style="color:#ffd700;text-decoration:underline;">取消选中</a>';
      } else {
        hintEl.textContent = '💡 提示：点击上方手牌可「选中替换」，双击手牌可直接「打出/移除」；未选中时点击下方牌库即为「摸入新牌」';
      }
    }

    var analysis = window.MahjongEngine.analyzeAssistantHand(assistHand, assistMeldCount, {});
    var bestDiscardTile = (analysis.recommendations && analysis.recommendations.length > 0)
      ? analysis.recommendations[0].tile
      : -1;

    var html = '';
    for (var i = 0; i < assistHand.length; i++) {
      var t = assistHand[i];
      var isSelectedSlot = (i === selectedSlotIndex);
      var isTopRecommend = (assistHand.length % 3 === 2 && t === bestDiscardTile);
      var extraCls = 'assist-hand-tile' + (isSelectedSlot ? ' slot-editing' : '') + (isTopRecommend ? ' recommend-discard' : '');
      var badgeHtml = '';
      if (isSelectedSlot) {
        badgeHtml = '<span class="assist-tile-tag edit">改</span>';
      } else if (isTopRecommend) {
        badgeHtml = '<span class="assist-tile-tag best">荐打</span>';
      }
      html += '<div class="assist-slot-wrap" data-slot="' + i + '">' +
        window.MahjongEngine.tileHTML(t, extraCls) +
        badgeHtml +
        '<button type="button" class="assist-slot-del" data-del="' + i + '" title="移除/打出这张牌">×</button>' +
      '</div>';
    }
    container.innerHTML = html;

    // Bind events on hand slots
    var wraps = container.querySelectorAll('.assist-slot-wrap');
    wraps.forEach(function(wEl) {
      wEl.addEventListener('click', function(e) {
        if (e.target && e.target.getAttribute('data-del') !== null) return;
        var idx = parseInt(wEl.getAttribute('data-slot'), 10);
        if (selectedSlotIndex === idx) {
          selectedSlotIndex = -1;
        } else {
          selectedSlotIndex = idx;
        }
        renderAssistHand();
      });
    });

    var delBtns = container.querySelectorAll('.assist-slot-del');
    delBtns.forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute('data-del'), 10);
        if (!isNaN(idx) && idx >= 0 && idx < assistHand.length) {
          assistHand.splice(idx, 1);
          selectedSlotIndex = -1;
          renderAssistAll();
        }
      });
    });

    var cancelLink = document.getElementById('assistCancelSlotBtn');
    if (cancelLink) {
      cancelLink.addEventListener('click', function(e) {
        e.preventDefault();
        selectedSlotIndex = -1;
        renderAssistHand();
      });
    }
  }

  function renderAssistPalette() {
    var palContainer = document.getElementById('assistTilePalette');
    if (!palContainer || !window.MahjongEngine) return;
    if (palContainer.children.length > 0) return; // Only build once

    var groups = [
      { label: '万', start: 0, end: 8 },
      { label: '条', start: 9, end: 17 },
      { label: '筒', start: 18, end: 26 },
      { label: '字/百搭', start: 27, end: 34 }
    ];

    var html = '';
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      html += '<div class="assist-pal-row"><span class="assist-pal-label">' + grp.label + '</span><div class="assist-pal-tiles">';
      for (var t = grp.start; t <= grp.end; t++) {
        html += '<div class="assist-pal-item" data-ptile="' + t + '" title="点击填入 ' + window.MahjongEngine.tileName(t) + '">' +
          window.MahjongEngine.tileHTML(t, 'small-pal-tile') +
        '</div>';
      }
      html += '</div></div>';
    }
    palContainer.innerHTML = html;

    palContainer.querySelectorAll('.assist-pal-item').forEach(function(item) {
      item.addEventListener('click', function() {
        var t = parseInt(item.getAttribute('data-ptile'), 10);
        if (isNaN(t)) return;
        if (selectedSlotIndex >= 0 && selectedSlotIndex < assistHand.length) {
          // Replace the selected slot and automatically advance to next slot for ultra-fast correction!
          assistHand[selectedSlotIndex] = t;
          if (selectedSlotIndex + 1 < assistHand.length) {
            selectedSlotIndex++;
          } else {
            selectedSlotIndex = -1;
          }
        } else {
          // Append (摸入一张新牌) up to 14 tiles
          if (assistHand.length >= 14) {
            var statusEl = document.getElementById('assistCameraStatus');
            if (statusEl) statusEl.textContent = 'ℹ️ 手牌已满 14 张！请先点击某张手牌进行替换，或打出一张牌后再摸牌';
            return;
          }
          assistHand.push(t);
        }
        if (window.MahjongAudio && window.MahjongAudio.playSelect) window.MahjongAudio.playSelect();
        renderAssistAll();
      });
    });
  }

  function renderAssistAnalysis() {
    var outEl = document.getElementById('assistAnalysisOutput');
    if (!outEl || !window.MahjongEngine) return;

    if (assistHand.length === 0) {
      outEl.innerHTML = '<div class="assist-empty-tip">📭 当前手牌为空，请使用上方相机拍照识牌，或直接点击下方牌库录入您的手牌。</div>';
      return;
    }

    var res = window.MahjongEngine.analyzeAssistantHand(assistHand, assistMeldCount, {});

    if (res.mode === 'invalid') {
      outEl.innerHTML = '<div class="assist-empty-tip">⚠️ 当前手牌为 <b>' + assistHand.length + '</b> 张（相公牌数）。标准麻将手牌应为 <b>13张</b>（等待摸牌）或 <b>14张</b>（轮到出牌，若有吃碰则为 10/11、7/8、4/5 张）。请增删 1~2 张牌以获取精准军师建议！</div>';
      return;
    }

    var html = '';

    // 1. Check if already Hu!
    if (res.isHu) {
      html += '<div class="assist-hu-banner">🎉 恭喜！您当前这副 <b>' + assistHand.length + '</b> 张手牌已经满足【胡牌 / 自摸】牌型，可以直接推倒胡牌！</div>';
    }

    // 2. If 14 / 11 / 8 tiles: Show Top 3 Discard Recommendations
    if (res.mode === 'discard') {
      var recs = res.recommendations.slice(0, 3);
      html += '<div class="assist-sec-title">👑 雀神军师 · 最优出牌推荐（Top ' + recs.length + '）</div>';
      html += '<div class="assist-rec-list">';
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        var rankLabels = ['🥇 首选出牌', '🥈 次选方案', '🥉 备选方案'];
        var cardCls = (i === 0) ? 'assist-rec-card best' : 'assist-rec-card';
        var subPills = '';
        if (r.isTing && r.tingWaits.length > 0) {
          subPills = '<div class="assist-waits-row"><span class="assist-wait-tag ting">听牌明细：</span>';
          r.tingWaits.forEach(function(w) {
            subPills += '<span class="assist-wait-pill"><b>' + w.name + '</b> 剩' + w.remaining + '张</span>';
          });
          subPills += '</div>';
        } else if (r.effectiveDraws && r.effectiveDraws.length > 0) {
          subPills = '<div class="assist-waits-row"><span class="assist-wait-tag eff">好牌进张：</span>';
          r.effectiveDraws.slice(0, 6).forEach(function(d) {
            subPills += '<span class="assist-wait-pill">' + d.name + (d.entersTing ? '(入听)' : '') + '</span>';
          });
          if (r.effectiveKindCount > 6) {
            subPills += '<span class="assist-wait-pill">等共 ' + r.effectiveKindCount + ' 种</span>';
          }
          subPills += '</div>';
        }

        html += '<div class="' + cardCls + '">' +
          '<div class="assist-rec-left">' +
            window.MahjongEngine.tileHTML(r.tile, 'rec-mini-tile') +
          '</div>' +
          '<div class="assist-rec-body">' +
            '<div class="assist-rec-head">' +
              '<span class="assist-rank-badge">' + rankLabels[i] + '：打【' + r.name + '】</span>' +
              '<button type="button" class="assist-do-discard-btn" data-discard="' + r.tile + '">⚡ 实战打出此牌</button>' +
            '</div>' +
            '<div class="assist-rec-reason">' + r.reason + '</div>' +
            subPills +
          '</div>' +
        '</div>';
      }
      html += '</div>';
    } else if (res.mode === 'draw') {
      // 3. If 13 / 10 / 7 tiles: Show current Ting waits & best tiles to draw/claim next
      if (res.isTing) {
        html += '<div class="assist-ting-banner">🔥 当前手牌已进入【听牌】状态！共可胡 <b>' + res.tingWaits.length + '</b> 种、合计 <b>' + res.tingTotal + '</b> 张牌：</div>';
        html += '<div class="assist-waits-row" style="margin-bottom:8px;">';
        res.tingWaits.forEach(function(w) {
          html += '<span class="assist-wait-pill win-pill">🀄 胡 <b>' + w.name + '</b>（剩 ' + w.remaining + ' 张）</span>';
        });
        html += '</div>';
      } else {
        html += '<div class="assist-sec-title">🔍 当前为 ' + assistHand.length + ' 张手牌（等待摸牌或吃/碰）</div>';
      }

      if (res.bestDraws && res.bestDraws.length > 0) {
        html += '<div class="assist-sub-note">👇 实战跟牌：如果您在牌桌上新摸进（或准备吃/碰）某张牌，直接点击下方对应麻将牌即可立即模拟摸入并计算下一手出牌！以下为您当前的黄金进张：</div>';
        html += '<div class="assist-waits-row">';
        res.bestDraws.slice(0, 8).forEach(function(d) {
          html += '<span class="assist-wait-pill draw-click-pill" data-drawtile="' + d.tile + '" style="cursor:pointer;" title="点击模拟摸进这张牌">' +
            '➕ 摸【<b>' + d.name + '</b>】' + (d.winsNow ? '🔥胡牌' : '进张') +
          '</span>';
        });
        html += '</div>';
      }
    }

    outEl.innerHTML = html;

    // Bind [⚡ 实战打出此牌] buttons
    outEl.querySelectorAll('.assist-do-discard-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var dTile = parseInt(btn.getAttribute('data-discard'), 10);
        var idx = assistHand.indexOf(dTile);
        if (idx >= 0) {
          assistHand.splice(idx, 1);
          selectedSlotIndex = -1;
          var statusEl = document.getElementById('assistCameraStatus');
          if (statusEl) {
            statusEl.textContent = '✋ 已打出【' + window.MahjongEngine.tileName(dTile) + '】！现在轮到下家，等您摸进新牌时点击下方牌库即可继续跟牌';
          }
          if (window.MahjongAudio && window.MahjongAudio.playDiscard) window.MahjongAudio.playDiscard();
          renderAssistAll();
        }
      });
    });

    // Bind quick draw pills
    outEl.querySelectorAll('.draw-click-pill').forEach(function(pill) {
      pill.addEventListener('click', function() {
        var dt = parseInt(pill.getAttribute('data-drawtile'), 10);
        if (!isNaN(dt) && assistHand.length < 14) {
          assistHand.push(dt);
          selectedSlotIndex = -1;
          if (window.MahjongAudio && window.MahjongAudio.playDraw) window.MahjongAudio.playDraw();
          renderAssistAll();
        }
      });
    });
  }

  function renderAssistAll() {
    renderAssistPalette();
    renderAssistHand();
    renderAssistAnalysis();
  }

  /* ================= Open / Close Modal & Event Wiring ================= */
  function openCameraAssistModal(autoStartCam) {
    var modal = document.getElementById('modalCameraAssist');
    if (!modal) return;
    document.querySelectorAll('.modal-overlay').forEach(function(m) {
      if (m.id !== 'modalCameraAssist') m.classList.remove('show');
    });
    modal.classList.add('show');

    var keyInput = document.getElementById('assistGeminiKeyInput');
    if (keyInput && !keyInput.value) {
      keyInput.value = getSavedGeminiKey();
    }

    renderAssistAll();
    if (autoStartCam !== false) {
      startCamera();
    }
  }

  function closeCameraAssistModal() {
    stopCamera();
    var modal = document.getElementById('modalCameraAssist');
    if (modal) modal.classList.remove('show');
  }

  function initCameraAssist() {
    var btnToolbar = document.getElementById('btnCameraAssist');
    if (btnToolbar) {
      btnToolbar.addEventListener('click', function() {
        openCameraAssistModal(true);
      });
    }

    var btnWelcome = document.getElementById('btnStartCameraAssist');
    if (btnWelcome) {
      btnWelcome.addEventListener('click', function() {
        openCameraAssistModal(true);
      });
    }

    var btnClose = document.getElementById('btnCloseCameraAssist');
    if (btnClose) {
      btnClose.addEventListener('click', function() {
        closeCameraAssistModal();
      });
    }

    var btnToggleCam = document.getElementById('btnAssistStartCam');
    if (btnToggleCam) {
      btnToggleCam.addEventListener('click', function() {
        startCamera();
      });
    }

    var btnSnap = document.getElementById('btnAssistCapture');
    if (btnSnap) {
      btnSnap.addEventListener('click', function() {
        var video = document.getElementById('assistCameraVideo');
        if (video && stream) {
          captureAndRecognize(video, false);
        } else {
          // If stream isn't running, trigger file/camera input
          var fileInp = document.getElementById('assistFileInput');
          if (fileInp) fileInp.click();
        }
      });
    }

    var btnUpload = document.getElementById('btnAssistUpload');
    var fileInp = document.getElementById('assistFileInput');
    if (btnUpload && fileInp) {
      btnUpload.addEventListener('click', function() {
        fileInp.click();
      });
      fileInp.addEventListener('change', function(e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function(ev) {
          var img = new Image();
          img.onload = function() {
            captureAndRecognize(img, true);
          };
          img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
        fileInp.value = '';
      });
    }

    var btnClear = document.getElementById('btnAssistClearHand');
    if (btnClear) {
      btnClear.addEventListener('click', function() {
        assistHand = [];
        selectedSlotIndex = -1;
        renderAssistAll();
      });
    }

    var btnDemo = document.getElementById('btnAssistDemoHand');
    if (btnDemo) {
      btnDemo.addEventListener('click', function() {
        // Generate an interesting realistic 14-tile hand for instant demonstration
        var samples = [
          [0, 1, 2, 3, 4, 9, 10, 11, 19, 20, 27, 27, 31, 34],
          [1, 2, 3, 4, 5, 6, 12, 13, 21, 22, 23, 28, 28, 32],
          [0, 0, 3, 3, 9, 9, 14, 14, 20, 20, 27, 27, 31, 33]
        ];
        assistHand = samples[Math.floor(Math.random() * samples.length)].slice();
        selectedSlotIndex = -1;
        renderAssistAll();
      });
    }

    var keyInput = document.getElementById('assistGeminiKeyInput');
    if (keyInput) {
      keyInput.addEventListener('change', function() {
        saveGeminiKey(keyInput.value);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCameraAssist);
  } else {
    initCameraAssist();
  }

  window.MahjongCameraAssist = {
    open: openCameraAssistModal,
    close: closeCameraAssistModal,
    setHand: function(arr) {
      assistHand = (arr || []).slice();
      selectedSlotIndex = -1;
      renderAssistAll();
    },
    getHand: function() {
      return assistHand.slice();
    }
  };
})();
