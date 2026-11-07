/**
 * Real-Life Full-Table Camera Mahjong Assistant (📷 麻将全局实时盯盘军师)
 * - Continuous Motion-Stabilized Auto-Watch (帧稳定自动盯盘)
 * - 5-Zone Full-Table Vision (Gemini Vision JSON + Local 5-Zone CV)
 * - 4-Seat Tactical Sandbox (追踪自家、下家、对家、上家：谁打了什么、谁吃了什么、谁碰/杠了什么)
 * - Instant Opponent Discard Claim Interception (吃/碰/杠/胡 实时拦截决策 + 一键执行)
 * - Full-Table Remaining Tile Counter & Opponent Point-Pao Danger Rating
 * - Live TTS Voice Broadcast & SpeechRecognition Voice Recording
 */
(function() {
  'use strict';

  var stream = null;
  var isRecognizing = false;

  // Auto-Watch state
  var autoWatchEnabled = false;
  var autoWatchTimer = null;
  var motionCanvas = null;
  var prevFrameGray = null;
  var lastRecognizedGray = null;
  var stableTickCount = 0;
  var motionPending = false;
  var lastAutoCaptureTime = 0;

  // Voice state
  var voiceOutEnabled = true;
  var lastSpokenText = '';
  var speechRec = null;
  var voiceInActive = false;

  // Interactive selection modes
  var selectedSlotIndex = -1;
  var currentTargetMode = 'my-hand'; // 'my-hand' | 'left-discard' | 'left-meld' | 'top-discard' | 'top-meld' | 'right-discard' | 'right-meld' | 'bottom-meld'
  var currentMeldSubType = 'peng';   // 'peng' | 'chi' | 'gang'

  // Full-Table State & Undo History
  var historyStack = [];
  var tableState = {
    myHand: [0, 1, 2, 4, 5, 9, 10, 11, 18, 19, 20, 27, 27, 31],
    seats: {
      bottom: { melds: [], discards: [] },
      right:  { melds: [], discards: [] },
      top:    { melds: [], discards: [] },
      left:   { melds: [], discards: [] }
    },
    latestEvent: null
  };

  var SEAT_DISPLAY = {
    left:   { icon: '⬅️', title: '上家 (左)' },
    top:    { icon: '⬆️', title: '对家 (上)' },
    right:  { icon: '➡️', title: '下家 (右)' },
    bottom: { icon: '⬇️', title: '自家 (我)' }
  };

  var NAME_TO_TILE = {
    '一万': 0, '1万': 0, '二万': 1, '2万': 1, '两万': 1, '三万': 2, '3万': 2,
    '四万': 3, '4万': 3, '五万': 4, '5万': 4, '六万': 5, '6万': 5,
    '七万': 6, '7万': 6, '八万': 7, '8万': 7, '九万': 8, '9万': 8,
    '一条': 9, '1条': 9, '幺鸡': 9, '一索': 9, '二条': 10, '2条': 10, '两条': 10, '二索': 10,
    '三条': 11, '3条': 11, '三索': 11, '四条': 12, '4条': 12, '四索': 12,
    '五条': 13, '5条': 13, '五索': 13, '六条': 14, '6条': 14, '六索': 14,
    '七条': 15, '7条': 15, '七索': 15, '八条': 16, '8条': 16, '八索': 16,
    '九条': 17, '9条': 17, '九索': 17,
    '一筒': 18, '1筒': 18, '一饼': 18, '1饼': 18, '二筒': 19, '2筒': 19, '两筒': 19, '二饼': 19,
    '三筒': 20, '3筒': 20, '三饼': 20, '四筒': 21, '4筒': 21, '四饼': 21,
    '五筒': 22, '5筒': 22, '五饼': 22, '六筒': 23, '6筒': 23, '六饼': 23,
    '七筒': 24, '7筒': 24, '七饼': 24, '八筒': 25, '8筒': 25, '八饼': 25,
    '九筒': 26, '9筒': 26, '九饼': 26,
    '东': 27, '东风': 27, '南': 28, '南风': 28, '西': 29, '西风': 29, '北': 30, '北风': 30,
    '中': 31, '红中': 31, '发': 32, '发财': 32, '發': 32, '白': 33, '白板': 33, '白皮': 33,
    '飞': 34, '飛': 34, '飞牌': 34, '百搭': 34
  };

  function cloneState(st) {
    return JSON.parse(JSON.stringify(st));
  }

  function pushUndoSnapshot() {
    historyStack.push(cloneState(tableState));
    if (historyStack.length > 30) historyStack.shift();
  }

  function undoLastAction() {
    if (historyStack.length === 0) {
      setStatusText('ℹ️ 已经是初始状态，无更多步骤可撤销');
      return;
    }
    tableState = historyStack.pop();
    selectedSlotIndex = -1;
    renderAssistAll();
    setStatusText('↩️ 已撤销上一步牌局记录');
  }

  function setStatusText(msg) {
    var statusEl = document.getElementById('assistCameraStatus');
    if (statusEl) statusEl.textContent = msg;
  }

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

  /* ================= Voice Output (TTS) & Voice Input (SpeechRecognition) ================= */
  function speakAdvice(text) {
    if (!voiceOutEnabled || !text || text === lastSpokenText) return;
    lastSpokenText = text;
    if (typeof window === 'undefined' || !window.speechSynthesis || typeof window.SpeechSynthesisUtterance === 'undefined') {
      return;
    }
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.12;
      u.pitch = 1.0;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  function parseTileFromText(str) {
    var keys = Object.keys(NAME_TO_TILE).sort(function(a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      if (str.indexOf(keys[i]) >= 0) {
        return NAME_TO_TILE[keys[i]];
      }
    }
    return -1;
  }

  function handleVoiceCommandTranscript(raw) {
    if (!raw) return;
    var text = String(raw).trim();
    var seat = 'bottom';
    if (text.indexOf('上家') >= 0 || text.indexOf('左') >= 0) seat = 'left';
    else if (text.indexOf('对家') >= 0 || text.indexOf('对面') >= 0 || text.indexOf('上边') >= 0) seat = 'top';
    else if (text.indexOf('下家') >= 0 || text.indexOf('右') >= 0) seat = 'right';
    else if (text.indexOf('我') >= 0 || text.indexOf('自家') >= 0) seat = 'bottom';

    var tile = parseTileFromText(text);
    if (tile < 0) {
      setStatusText('🎙️ 听到「' + text + '」，未匹配到牌名（可说如“上家打三万”、“对家碰红中”）');
      return;
    }

    if (text.indexOf('摸') >= 0 && seat === 'bottom') {
      pushUndoSnapshot();
      if (tableState.myHand.length < 14) {
        tableState.myHand.push(tile);
        tableState.latestEvent = null;
        renderAssistAll();
        setStatusText('🎙️ 语音已记录：自家摸入【' + window.MahjongEngine.tileName(tile) + '】');
      }
      return;
    }

    if (text.indexOf('杠') >= 0) {
      recordSeatAction(seat, 'gang', [tile, tile, tile, tile]);
      setStatusText('🎙️ 语音已记录：' + SEAT_DISPLAY[seat].title + '杠【' + window.MahjongEngine.tileName(tile) + '】');
    } else if (text.indexOf('碰') >= 0) {
      recordSeatAction(seat, 'peng', [tile, tile, tile]);
      setStatusText('🎙️ 语音已记录：' + SEAT_DISPLAY[seat].title + '碰【' + window.MahjongEngine.tileName(tile) + '】');
    } else if (text.indexOf('吃') >= 0 && tile < 27) {
      var r = tile % 9;
      var base = (r <= 6) ? tile : (tile - (r - 6));
      recordSeatAction(seat, 'chi', [base, base + 1, base + 2]);
      setStatusText('🎙️ 语音已记录：' + SEAT_DISPLAY[seat].title + '吃【' + window.MahjongEngine.tileName(base) + '】顺子');
    } else {
      recordSeatAction(seat, 'discard', [tile]);
      setStatusText('🎙️ 语音已记录：' + SEAT_DISPLAY[seat].title + '打出【' + window.MahjongEngine.tileName(tile) + '】');
    }
  }

  function toggleVoiceInput() {
    var btn = document.getElementById('btnAssistVoiceIn');
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setStatusText('⚠️ 当前浏览器不支持语音识别，请使用下方「方位动作栏」点选记牌');
      return;
    }
    if (voiceInActive && speechRec) {
      voiceInActive = false;
      try { speechRec.stop(); } catch (e) {}
      if (btn) btn.textContent = '🎙️ 语音记牌';
      setStatusText('ℹ️ 已关闭语音记牌');
      return;
    }
    try {
      speechRec = new SR();
      speechRec.lang = 'zh-CN';
      speechRec.continuous = true;
      speechRec.interimResults = false;
      speechRec.onresult = function(ev) {
        var last = ev.results[ev.results.length - 1];
        if (last && last[0] && last[0].transcript) {
          handleVoiceCommandTranscript(last[0].transcript);
        }
      };
      speechRec.onend = function() {
        if (voiceInActive) {
          try { speechRec.start(); } catch (e) {}
        }
      };
      speechRec.start();
      voiceInActive = true;
      if (btn) btn.textContent = '🎙️ 听牌中(点此关)';
      setStatusText('🎙️ 语音盯盘已开启：直接说「上家打三万」「对家碰红中」「我摸五筒」即可实时入盘');
    } catch (err) {
      setStatusText('⚠️ 无法启动麦克风语音识别');
    }
  }

  /* ================= Camera Lifecycle & Auto-Watch Frame Stability Engine ================= */
  function updateWatchIndicator(stateStr, isWatching) {
    var pill = document.getElementById('assistWatchIndicator');
    var textEl = document.getElementById('assistWatchStateText');
    var btn = document.getElementById('btnAssistAutoWatch');
    if (pill) {
      if (isWatching) pill.classList.add('watching');
      else pill.classList.remove('watching');
    }
    if (textEl && stateStr) {
      textEl.textContent = stateStr;
    }
    if (btn) {
      btn.textContent = isWatching ? '⏹️ 停止实时盯盘' : '🔴 开启实时盯盘';
    }
  }

  async function startCamera() {
    var video = document.getElementById('assistCameraVideo');
    var placeholderEl = document.getElementById('assistCameraPlaceholder');
    if (!video) return false;

    if (stream) return true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatusText('⚠️ 当前浏览器不支持直接视频流，可使用「🖼️ 传图」或下方沙盘实时记牌');
      return false;
    }

    try {
      setStatusText('📷 正在开启摄像头...');
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
      setStatusText('✅ 摄像头已就绪：手牌放底部框、三家吃碰与牌河放中上框，画面稳定自动识牌');
      return true;
    } catch (err) {
      setStatusText('ℹ️ 未检测到可用摄像头或权限，您仍可上传照片或使用四家沙盘实时盯盘');
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

  function sampleVideoGray64x36(videoEl) {
    if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;
    if (!motionCanvas) {
      motionCanvas = document.createElement('canvas');
      motionCanvas.width = 64;
      motionCanvas.height = 36;
    }
    var ctx = motionCanvas.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, 64, 36);
    var data = ctx.getImageData(0, 0, 64, 36).data;
    var gray = new Uint8Array(64 * 36);
    for (var i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    }
    return gray;
  }

  function computeMeanDiff(a, b) {
    if (!a || !b || a.length !== b.length) return 999;
    var sum = 0;
    for (var i = 0; i < a.length; i++) {
      sum += Math.abs(a[i] - b[i]);
    }
    return sum / a.length;
  }

  function runAutoWatchTick() {
    if (!autoWatchEnabled) return;
    var video = document.getElementById('assistCameraVideo');
    if (!video || !stream || !video.videoWidth) {
      updateWatchIndicator('🔴 实时盯盘待命 · 等待相机画面或沙盘输入', true);
      return;
    }
    if (isRecognizing) return;

    var curGray = sampleVideoGray64x36(video);
    if (!curGray) return;

    if (!prevFrameGray) {
      prevFrameGray = curGray;
      lastRecognizedGray = curGray;
      captureAndRecognize(video, false, true);
      return;
    }

    var motionDiff = computeMeanDiff(curGray, prevFrameGray);
    var sceneDiff = computeMeanDiff(curGray, lastRecognizedGray);
    prevFrameGray = curGray;

    if (motionDiff > 4.2) {
      // Hand is moving in frame
      motionPending = true;
      stableTickCount = 0;
      updateWatchIndicator('🟡 检测到摸打动作 · 等待手移开稳定...', true);
      return;
    }

    // Frame is currently still
    stableTickCount++;
    var now = Date.now();
    var shouldTrigger = false;

    if (motionPending && stableTickCount >= 2 && sceneDiff > 5.5) {
      shouldTrigger = true;
    } else if (stableTickCount >= 10 && sceneDiff > 8.5 && (now - lastAutoCaptureTime > 3000)) {
      shouldTrigger = true;
    }

    if (shouldTrigger) {
      motionPending = false;
      stableTickCount = 0;
      lastRecognizedGray = curGray;
      lastAutoCaptureTime = now;
      updateWatchIndicator('⚡ 画面已稳定 · 正在自动识别全桌牌局...', true);
      captureAndRecognize(video, false, true);
    } else {
      updateWatchIndicator('🔴 实时盯盘中 · 画面稳定监控四家动态', true);
    }
  }

  function toggleAutoWatch(forceState) {
    var next = (typeof forceState === 'boolean') ? forceState : !autoWatchEnabled;
    autoWatchEnabled = next;
    if (autoWatchTimer) {
      clearInterval(autoWatchTimer);
      autoWatchTimer = null;
    }
    if (autoWatchEnabled) {
      prevFrameGray = null;
      lastRecognizedGray = null;
      stableTickCount = 0;
      motionPending = false;
      updateWatchIndicator('🔴 实时盯盘已开启 · 自动监测四家出牌与手牌', true);
      setStatusText('🔴 实时盯盘已开启：每当摸牌/出牌手移开画面稳定后，将自动识别全局变化并播报建议');
      startCamera();
      autoWatchTimer = setInterval(runAutoWatchTick, 250);
    } else {
      updateWatchIndicator('⏸️ 待机中（点击右侧开启实时盯盘）', false);
      setStatusText('⏸️ 已暂停自动盯盘，您仍可随时点击拍照或使用沙盘记牌');
    }
    return autoWatchEnabled;
  }

  /* ================= Keyless 36-D Spatial Template Bank + 5-Zone Vision Engine ================= */
  var templateBank = null;
  var templateBankPromise = null;

  function extractTileFeature36(ctx, x, y, w, h) {
    var ix = Math.max(0, Math.floor(x));
    var iy = Math.max(0, Math.floor(y));
    var iw = Math.max(1, Math.floor(w));
    var ih = Math.max(1, Math.floor(h));
    var imgData = ctx.getImageData(ix, iy, iw, ih);
    var data = imgData.data;

    var padX = Math.floor(iw * 0.13);
    var padY = Math.floor(ih * 0.11);
    var innerW = Math.max(3, iw - padX * 2);
    var innerH = Math.max(3, ih - padY * 2);
    var totalPixels = innerW * innerH;

    // Auto white-balance threshold based on 75th percentile luminance inside the tile face
    var lumSum = 0;
    var pCount = 0;
    for (var sy = padY; sy < ih - padY; sy += 2) {
      for (var sx = padX; sx < iw - padX; sx += 2) {
        var sIdx = (sy * iw + sx) * 4;
        lumSum += (0.299 * data[sIdx] + 0.587 * data[sIdx + 1] + 0.114 * data[sIdx + 2]);
        pCount++;
      }
    }
    var avgLum = pCount > 0 ? (lumSum / pCount) : 210;
    var bgLumThreshold = Math.min(218, Math.max(155, avgLum * 0.88));

    var gridVec = new Float32Array(36); // 9 cells (3x3) * 4 channels [red, green, blue, dark]
    var cellCounts = new Float32Array(9);

    var redTop = 0, redBot = 0;
    var greenTop = 0, greenBot = 0;
    var blueCount = 0;
    var darkTop = 0, darkBot = 0;

    for (var py = padY; py < ih - padY; py++) {
      var relY = (py - padY) / innerH;
      var gy = Math.min(2, Math.floor(relY * 3));
      var isTop = relY < 0.52;
      for (var px = padX; px < iw - padX; px++) {
        var relX = (px - padX) / innerW;
        var gx = Math.min(2, Math.floor(relX * 3));
        var cellIdx = gy * 3 + gx;
        cellCounts[cellIdx]++;

        var idx = (py * iw + px) * 4;
        var r = data[idx], g = data[idx + 1], b = data[idx + 2];
        var lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > bgLumThreshold) continue;

        var maxC = Math.max(r, g, b);
        var minC = Math.min(r, g, b);
        var sat = maxC - minC;
        var baseOffset = cellIdx * 4;

        if (r > g + 24 && r > b + 24) {
          gridVec[baseOffset + 0]++;
          if (isTop) redTop++; else redBot++;
        } else if (g > r + 14 && g > b + 10) {
          gridVec[baseOffset + 1]++;
          if (isTop) greenTop++; else greenBot++;
        } else if (b > r + 16 && b > g + 5) {
          gridVec[baseOffset + 2]++;
          blueCount++;
        } else if (lum < bgLumThreshold * 0.65 && sat < 42) {
          gridVec[baseOffset + 3]++;
          if (isTop) darkTop++; else darkBot++;
        }
      }
    }

    for (var c = 0; c < 9; c++) {
      var denom = Math.max(1, cellCounts[c]);
      gridVec[c * 4 + 0] /= denom;
      gridVec[c * 4 + 1] /= denom;
      gridVec[c * 4 + 2] /= denom;
      gridVec[c * 4 + 3] /= denom;
    }

    var redRatio = (redTop + redBot) / totalPixels;
    var greenRatio = (greenTop + greenBot) / totalPixels;
    var blueRatio = blueCount / totalPixels;
    var darkRatio = (darkTop + darkBot) / totalPixels;
    var inkRatio = redRatio + greenRatio + blueRatio + darkRatio;

    return {
      vec: gridVec,
      redTop: redTop,
      redBot: redBot,
      greenTop: greenTop,
      greenBot: greenBot,
      blueCount: blueCount,
      darkTop: darkTop,
      darkBot: darkBot,
      totalPixels: totalPixels,
      redRatio: redRatio,
      greenRatio: greenRatio,
      blueRatio: blueRatio,
      darkRatio: darkRatio,
      inkRatio: inkRatio
    };
  }

  function ensureTemplateBank() {
    if (templateBank) return Promise.resolve(templateBank);
    if (templateBankPromise) return templateBankPromise;
    if (!window.MahjongEngine || !window.MahjongEngine.faceSVG) return Promise.resolve(null);

    templateBankPromise = (async function() {
      var bank = [];
      var c = document.createElement('canvas');
      c.width = 48;
      c.height = 64;
      var ctx = c.getContext('2d');

      for (var t = 0; t <= 34; t++) {
        var svgStr = window.MahjongEngine.faceSVG(t);
        if (svgStr.indexOf('xmlns=') < 0) {
          svgStr = svgStr.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
        }
        var url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
        var img = new Image();
        await new Promise(function(resolve) {
          img.onload = resolve;
          img.onerror = resolve;
          img.src = url;
        });
        ctx.fillStyle = '#fdfaf2';
        ctx.fillRect(0, 0, 48, 64);
        ctx.drawImage(img, 0, 0, 48, 64);
        bank[t] = extractTileFeature36(ctx, 0, 0, 48, 64);
      }
      templateBank = bank;
      return bank;
    })();
    return templateBankPromise;
  }

  function classifySingleTilePatch(ctx, x, y, w, h) {
    var feat = extractTileFeature36(ctx, x, y, w, h);

    // Center cell (gy=1, gx=1 -> cellIdx = 4) ink density
    var centerInk = feat.vec[4 * 4 + 0] + feat.vec[4 * 4 + 1] + feat.vec[4 * 4 + 2] + feat.vec[4 * 4 + 3];

    // 1. Blank / White Dragon (白板 33): either completely blank ivory OR navy rectangular frame with empty center
    if ((feat.inkRatio < 0.025 || (centerInk < 0.012 && feat.inkRatio < 0.16)) && feat.redRatio < 0.008 && feat.greenRatio < 0.008) {
      return 33;
    }

    // 2. Pure Red Dragon (红中 31)
    if (feat.redRatio > 0.028 && feat.greenRatio < 0.015 && feat.blueRatio < 0.015 && feat.darkRatio < 0.015) {
      return 31;
    }

    // 3. 36-D Spatial Template Matching across all 0..33 tile prototypes
    if (templateBank) {
      var bestT = 0;
      var bestDist = 1e9;
      for (var t = 0; t <= 33; t++) {
        var tRef = templateBank[t];
        if (!tRef) continue;
        var d = 0;
        for (var vi = 0; vi < 36; vi++) {
          d += Math.abs(feat.vec[vi] - tRef.vec[vi]);
        }
        d += Math.abs(feat.redRatio - tRef.redRatio) * 6.0;
        d += Math.abs(feat.greenRatio - tRef.greenRatio) * 6.0;
        d += Math.abs(feat.blueRatio - tRef.blueRatio) * 5.0;
        d += Math.abs(feat.darkRatio - tRef.darkRatio) * 5.0;
        if (d < bestDist) {
          bestDist = d;
          bestT = t;
        }
      }
      return bestT;
    }

    // Fallback heuristic if template bank hasn't finished initializing
    if (feat.redBot > feat.redTop * 1.25 && (feat.darkTop + feat.blueCount * 0.5) > feat.totalPixels * 0.015 && feat.redRatio > 0.02) {
      var topComplexity = (feat.darkTop + feat.blueCount * 0.4) / (feat.totalPixels * 0.5);
      return Math.min(8, Math.max(0, Math.round((topComplexity - 0.03) / 0.024)));
    }
    if (feat.greenRatio > 0.022 && feat.greenRatio >= feat.blueRatio * 1.1) {
      var bambooInk = feat.greenRatio + feat.redRatio * 0.8;
      return 9 + Math.min(8, Math.max(0, Math.round((bambooInk - 0.03) / 0.022)));
    }
    if (feat.blueRatio > 0.018 || (feat.blueRatio + feat.redRatio > 0.04 && feat.greenRatio > 0.01)) {
      var pipInk = feat.blueRatio + feat.redRatio * 0.7 + feat.greenRatio * 0.5;
      return 18 + Math.min(8, Math.max(0, Math.round((pipInk - 0.025) / 0.024)));
    }
    if (feat.darkRatio > 0.035) {
      var windIdx = Math.min(3, Math.max(0, Math.floor(((feat.darkTop - feat.darkBot) / feat.totalPixels + 0.04) * 35) % 4));
      return 27 + windIdx;
    }
    var fallbackRank = Math.min(8, Math.max(0, Math.round(feat.inkRatio * 40)));
    return fallbackRank;
  }

  async function recognizeCanvasKeyless(sourceCanvas, targetCount, scanMode) {
    await ensureTemplateBank();
    return recognizeTilesLocallyFromCanvas(sourceCanvas, targetCount, scanMode);
  }

  function recognizeTilesLocallyFromCanvas(sourceCanvas, targetCount, scanMode) {
    targetCount = targetCount || 14;
    var sw = sourceCanvas.width;
    var sh = sourceCanvas.height;

    var cropX = Math.floor(sw * 0.04);
    var cropW = Math.floor(sw * 0.92);
    var cropY = (scanMode === 'full') ? Math.floor(sh * 0.64) : Math.floor(sh * 0.25);
    var cropH = (scanMode === 'full') ? Math.floor(sh * 0.32) : Math.floor(sh * 0.50);

    var workCanvas = document.createElement('canvas');
    workCanvas.width = 700;
    workCanvas.height = 140;
    var ctx = workCanvas.getContext('2d');
    ctx.drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, workCanvas.width, workCanvas.height);

    var slotW = workCanvas.width / targetCount;
    var handResult = [];
    for (var i = 0; i < targetCount; i++) {
      var tx = i * slotW;
      var tileCode = classifySingleTilePatch(ctx, tx, 4, slotW, workCanvas.height - 8);
      handResult.push(tileCode);
    }
    handResult.sort(function(a, b) { return a - b; });
    return { myHand: handResult };
  }

  /* ================= Gemini Vision Full-Table 5-Zone High-Accuracy Recognition ================= */
  function mapNameListToTiles(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var clean = String(arr[i] || '').trim();
      if (NAME_TO_TILE[clean] !== undefined) out.push(NAME_TO_TILE[clean]);
    }
    return out;
  }

  async function recognizeFullTableWithGemini(sourceCanvas, apiKey, targetCount, scanMode) {
    var base64Jpeg = sourceCanvas.toDataURL('image/jpeg', 0.82).split(',')[1];
    var prompt = '你是一个专业的麻将牌桌全局视觉识别助手。请分析画面中的麻将牌，返回严格的JSON对象（不要输出任何额外解释）：\n' +
      '{\n' +
      '  "myHand": ["一万","二万",...],\n' +
      '  "seats": {\n' +
      '    "left": {"melds": [{"type":"chi","tiles":["二条","三条","四条"]}], "discards": ["九万"]},\n' +
      '    "top": {"melds": [], "discards": ["东风"]},\n' +
      '    "right": {"melds": [{"type":"peng","tiles":["红中","红中","红中"]}], "discards": []},\n' +
      '    "bottom": {"melds": [], "discards": []}\n' +
      '  },\n' +
      '  "latestDiscard": {"seat": "left", "tile": "三万"}\n' +
      '}\n' +
      '说明：画面下方立着的一排是我自己的手牌(myHand，约' + (targetCount || 14) + '张)；画面左、上、右分别是上家(left)、对家(top)、下家(right)的吃碰杠副露和打出的舍牌。如果画面只拍到了手牌，则seats各家留空数组。牌名只能使用：一万~九万、一条~九条、一筒~九筒、东风、南风、西风、北风、红中、发财、白板、飞牌。';

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
        generationConfig: { temperature: 0.1 }
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

    var objMatch = rawText.match(/\{[\s\S]*\}/);
    if (objMatch) {
      var parsedObj = JSON.parse(objMatch[0]);
      return parsedObj;
    }
    var arrMatch = rawText.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      return { myHand: JSON.parse(arrMatch[0]) };
    }
    throw new Error('未能从AI返回中解析到全局麻将JSON');
  }

  function mergeRecognizedTableState(rawObj) {
    if (!rawObj) return;
    pushUndoSnapshot();

    var newHand = mapNameListToTiles(rawObj.myHand);
    if (newHand.length > 0) {
      tableState.myHand = newHand.sort(function(a, b) { return a - b; });
    }

    if (rawObj.seats && typeof rawObj.seats === 'object') {
      var seatKeys = ['left', 'top', 'right', 'bottom'];
      for (var s = 0; s < seatKeys.length; s++) {
        var sk = seatKeys[s];
        var srcSeat = rawObj.seats[sk];
        if (!srcSeat) continue;

        if (Array.isArray(srcSeat.discards) && srcSeat.discards.length > 0) {
          var mappedDiscards = mapNameListToTiles(srcSeat.discards);
          if (mappedDiscards.length >= tableState.seats[sk].discards.length) {
            // Check if a new discard appeared at the tail
            if (mappedDiscards.length > tableState.seats[sk].discards.length && sk !== 'bottom') {
              var newestTile = mappedDiscards[mappedDiscards.length - 1];
              tableState.latestEvent = { seat: sk, type: 'discard', tile: newestTile };
            }
            tableState.seats[sk].discards = mappedDiscards;
          }
        }

        if (Array.isArray(srcSeat.melds) && srcSeat.melds.length > 0) {
          var cleanMelds = [];
          for (var m = 0; m < srcSeat.melds.length; m++) {
            var mObj = srcSeat.melds[m];
            var mTiles = mapNameListToTiles(mObj && mObj.tiles ? mObj.tiles : mObj);
            if (mTiles.length >= 3) {
              cleanMelds.push({
                type: (mObj && mObj.type) ? mObj.type : (mTiles[0] === mTiles[1] ? 'peng' : 'chi'),
                tiles: mTiles
              });
            }
          }
          if (cleanMelds.length >= tableState.seats[sk].melds.length) {
            tableState.seats[sk].melds = cleanMelds;
          }
        }
      }
    }

    if (rawObj.latestDiscard && rawObj.latestDiscard.seat && rawObj.latestDiscard.tile) {
      var ldTile = NAME_TO_TILE[String(rawObj.latestDiscard.tile).trim()];
      var ldSeat = rawObj.latestDiscard.seat;
      if (ldTile !== undefined && (ldSeat === 'left' || ldSeat === 'top' || ldSeat === 'right')) {
        tableState.latestEvent = { seat: ldSeat, type: 'discard', tile: ldTile };
      }
    }
  }

  /* ================= Capture Frame & Run Recognition ================= */
  async function captureAndRecognize(sourceEl, isImageElement, isSilentAuto) {
    if (isRecognizing) return;
    var countSel = document.getElementById('assistTargetCountSelect');
    var scanSel = document.getElementById('assistScanModeSelect');
    var targetCount = countSel ? parseInt(countSel.value, 10) : 14;
    var scanMode = scanSel ? scanSel.value : 'full';

    var snapCanvas = document.getElementById('assistSnapCanvas');
    if (!snapCanvas) snapCanvas = document.createElement('canvas');

    var w = isImageElement ? (sourceEl.naturalWidth || sourceEl.width || 800) : (sourceEl.videoWidth || 800);
    var h = isImageElement ? (sourceEl.naturalHeight || sourceEl.height || 450) : (sourceEl.videoHeight || 450);
    if (!w || !h) {
      if (!isSilentAuto) {
        setStatusText('⚠️ 尚未获取到相机画面，请先开启摄像头或点击「🖼️ 传图」');
      }
      return;
    }

    snapCanvas.width = w;
    snapCanvas.height = h;
    var ctx = snapCanvas.getContext('2d');
    ctx.drawImage(sourceEl, 0, 0, w, h);
    if (!autoWatchEnabled || isImageElement) {
      snapCanvas.style.display = 'block';
    }

    var keyInput = document.getElementById('assistGeminiKeyInput');
    var apiKey = keyInput ? keyInput.value.trim() : getSavedGeminiKey();
    if (apiKey) saveGeminiKey(apiKey);

    isRecognizing = true;
    try {
      if (apiKey) {
        setStatusText('🤖 正在使用 Gemini 视觉大模型解析全桌四家牌面...');
        try {
          var aiResult = await recognizeFullTableWithGemini(snapCanvas, apiKey, targetCount, scanMode);
          mergeRecognizedTableState(aiResult);
          selectedSlotIndex = -1;
          renderAssistAll();
          setStatusText('✅ 全局视觉解析完成（自家手牌 ' + tableState.myHand.length + ' 张 + 四家吃碰舍牌已同步）');
          isRecognizing = false;
          return;
        } catch (aiErr) {
          console.warn('Gemini full-table fallback to local CV:', aiErr);
        }
      }

      await ensureTemplateBank();
      var localRes = recognizeTilesLocallyFromCanvas(snapCanvas, targetCount, scanMode);
      if (localRes && Array.isArray(localRes.myHand) && localRes.myHand.length > 0) {
        pushUndoSnapshot();
        tableState.myHand = localRes.myHand;
      }
      selectedSlotIndex = -1;
      renderAssistAll();
      setStatusText('✅ 免Key内置AI引擎识牌完成（手牌 ' + tableState.myHand.length + ' 张）！别人出牌或吃碰可在下方一键点选或语音播报');
    } finally {
      isRecognizing = false;
    }
  }

  /* ================= Record Seat Action & Execute Claim Recommendation ================= */
  function recordSeatAction(seat, actionType, tiles) {
    if (!tableState.seats[seat]) return;
    pushUndoSnapshot();

    if (actionType === 'discard') {
      var dTile = Array.isArray(tiles) ? tiles[0] : tiles;
      if (dTile === undefined || dTile < 0 || dTile > 34) return;
      tableState.seats[seat].discards.push(dTile);
      if (seat === 'left' || seat === 'top' || seat === 'right') {
        tableState.latestEvent = { seat: seat, type: 'discard', tile: dTile };
      } else {
        tableState.latestEvent = null;
      }
    } else if (actionType === 'chi' || actionType === 'peng' || actionType === 'gang') {
      var mTiles = Array.isArray(tiles) ? tiles.slice() : [tiles, tiles, tiles];
      tableState.seats[seat].melds.push({
        type: actionType,
        tiles: mTiles
      });
      // If a player claims, clear previous opponent discard interception prompt
      tableState.latestEvent = { seat: seat, type: actionType, tile: mTiles[0], tiles: mTiles };
    }

    renderAssistAll();
  }

  function executeClaimRecommendation() {
    if (!window.MahjongEngine) return;
    var fullRes = window.MahjongEngine.analyzeFullTable(tableState);
    var claim = fullRes.claimAdvice;
    if (!claim || claim.recommendedAction === 'pass') {
      tableState.latestEvent = null;
      renderAssistAll();
      return;
    }

    pushUndoSnapshot();
    var act = claim.recommendedAction;
    var targetTile = claim.tile;
    var fromSeat = claim.fromSeat;

    // Remove the claimed tile from the opponent's discard river if present at the end
    if (fromSeat && tableState.seats[fromSeat] && tableState.seats[fromSeat].discards.length > 0) {
      var oppDiscards = tableState.seats[fromSeat].discards;
      var lastIdx = oppDiscards.lastIndexOf(targetTile);
      if (lastIdx >= 0) oppDiscards.splice(lastIdx, 1);
    }

    if (act === 'hu') {
      tableState.myHand.push(targetTile);
      tableState.myHand.sort(function(a, b) { return a - b; });
      tableState.latestEvent = null;
      renderAssistAll();
      setStatusText('🎉 恭喜点炮胡牌！已将【' + claim.tileName + '】收入手牌');
      return;
    }

    if (act === 'peng') {
      for (var p = 0; p < 2; p++) {
        var pi = tableState.myHand.indexOf(targetTile);
        if (pi >= 0) tableState.myHand.splice(pi, 1);
      }
      tableState.seats.bottom.melds.push({ type: 'peng', tiles: [targetTile, targetTile, targetTile] });
    } else if (act === 'gang') {
      for (var g = 0; g < 3; g++) {
        var gi = tableState.myHand.indexOf(targetTile);
        if (gi >= 0) tableState.myHand.splice(gi, 1);
      }
      tableState.seats.bottom.melds.push({ type: 'gang', tiles: [targetTile, targetTile, targetTile, targetTile] });
    } else if (act === 'chi' && Array.isArray(claim.recommendedMeld)) {
      var partners = claim.recommendedMeld.slice();
      var ti = partners.indexOf(targetTile);
      if (ti >= 0) partners.splice(ti, 1);
      for (var c = 0; c < partners.length; c++) {
        var ci = tableState.myHand.indexOf(partners[c]);
        if (ci >= 0) tableState.myHand.splice(ci, 1);
      }
      tableState.seats.bottom.melds.push({ type: 'chi', tiles: claim.recommendedMeld.slice() });
    }

    // Also auto-discard the recommended tile after Chi/Peng so myHand transitions cleanly
    if (claim.discardAfter !== null && claim.discardAfter !== undefined) {
      var di = tableState.myHand.indexOf(claim.discardAfter);
      if (di >= 0) {
        tableState.myHand.splice(di, 1);
        tableState.seats.bottom.discards.push(claim.discardAfter);
      }
    }

    tableState.latestEvent = null;
    selectedSlotIndex = -1;
    renderAssistAll();
    setStatusText('⚡ 已执行【' + act.toUpperCase() + '】并打出【' + (claim.discardAfterName || '') + '】，牌局已同步更新！');
  }

  /* ================= UI Rendering: Claim Banner, 4-Seat Sandbox, Hand, Analysis & Palette ================= */
  function renderClaimBanner(fullRes) {
    var wrap = document.getElementById('assistClaimBannerWrap');
    var banner = document.getElementById('assistClaimBanner');
    if (!wrap || !banner) return;

    var claim = fullRes.claimAdvice;
    if (!claim) {
      wrap.style.display = 'none';
      banner.innerHTML = '';
      return;
    }

    wrap.style.display = 'block';
    var isActionable = claim.recommendedAction !== 'pass';
    banner.className = 'assist-claim-banner' + (isActionable ? '' : ' pass-mode');

    var optHtml = '';
    if (claim.options && claim.options.length > 0) {
      optHtml = '<div class="assist-waits-row" style="margin-top:4px;"><span class="assist-wait-tag eff">可选鸣牌动作：</span>';
      for (var i = 0; i < claim.options.length; i++) {
        optHtml += '<span class="assist-wait-pill">' + claim.options[i].label + '</span>';
      }
      optHtml += '</div>';
    }

    var btnHtml = '<div class="claim-btn-row">';
    if (isActionable) {
      btnHtml += '<button type="button" class="btn-exec-claim" id="btnExecuteClaim">⚡ 一键执行推荐动作</button>';
    }
    btnHtml += '<button type="button" class="btn-dismiss-claim" id="btnDismissClaim">✋ 忽略 / 已过牌</button></div>';

    banner.innerHTML =
      '<div class="claim-head-row">' +
        '<div class="claim-headline">' + claim.headline + '</div>' +
        btnHtml +
      '</div>' +
      '<div class="claim-reason">' + claim.reason + '</div>' +
      optHtml;

    var execBtn = document.getElementById('btnExecuteClaim');
    if (execBtn) {
      execBtn.addEventListener('click', function() {
        executeClaimRecommendation();
      });
    }
    var dismissBtn = document.getElementById('btnDismissClaim');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function() {
        tableState.latestEvent = null;
        renderAssistAll();
      });
    }
  }

  function renderTableSandbox(fullRes) {
    var grid = document.getElementById('assistSandboxGrid');
    var totalStat = document.getElementById('assistTotalVisibleStat');
    if (!grid || !window.MahjongEngine) return;

    var totalVisible = 0;
    for (var t = 0; t <= 34; t++) {
      totalVisible += (fullRes.visibleCounts[t] || 0);
    }
    if (totalStat) {
      totalStat.textContent = '全桌已亮出：' + totalVisible + ' 张（绝张 ' + fullRes.deadTiles.length + ' 种）';
    }

    var order = ['top', 'left', 'right', 'bottom'];
    var html = '';

    for (var i = 0; i < order.length; i++) {
      var sk = order[i];
      var seatData = tableState.seats[sk] || { melds: [], discards: [] };
      var meta = SEAT_DISPLAY[sk];
      var isLatestSeat = tableState.latestEvent && tableState.latestEvent.seat === sk;
      var threatProf = (fullRes.opponentThreats && fullRes.opponentThreats.seats && fullRes.opponentThreats.seats[sk])
        ? fullRes.opponentThreats.seats[sk]
        : null;

      var threatBadge = '';
      if (threatProf) {
        threatBadge = '<span class="seat-threat-badge ' + threatProf.threatLevel + '">' + threatProf.warning + '</span>';
      } else {
        threatBadge = '<span class="seat-threat-badge">手牌 ' + tableState.myHand.length + ' 张 · 副露 ' + seatData.melds.length + ' 副</span>';
      }

      // Render melds
      var meldsHtml = '<span class="seat-row-label">副露(吃/碰/杠):</span>';
      if (!seatData.melds || seatData.melds.length === 0) {
        meldsHtml += '<span style="font-size:11px;color:#64748b;">无</span>';
      } else {
        for (var m = 0; m < seatData.melds.length; m++) {
          var mItem = seatData.melds[m];
          var mTiles = Array.isArray(mItem) ? mItem : (mItem.tiles || []);
          var mLabel = (mItem.type === 'gang' ? '杠:' : (mItem.type === 'peng' ? '碰:' : '吃:')) +
            mTiles.map(window.MahjongEngine.tileName).join('');
          meldsHtml += '<span class="mini-meld-pill" data-del-meld-seat="' + sk + '" data-del-meld-idx="' + m + '" title="点击移除此副露">' +
            mLabel + ' ×</span>';
        }
      }

      // Render discards
      var discardsHtml = '<span class="seat-row-label">已打出的牌河:</span>';
      if (!seatData.discards || seatData.discards.length === 0) {
        discardsHtml += '<span style="font-size:11px;color:#64748b;">暂无出牌</span>';
      } else {
        for (var d = 0; d < seatData.discards.length; d++) {
          var dTile = seatData.discards[d];
          var isLatestTile = isLatestSeat && tableState.latestEvent.type === 'discard' && d === seatData.discards.length - 1;
          discardsHtml += '<span class="mini-discard-pill' + (isLatestTile ? ' latest' : '') + '" ' +
            'data-discard-seat="' + sk + '" data-discard-idx="' + d + '" title="点击删除此张舍牌">' +
            window.MahjongEngine.tileName(dTile) + (isLatestTile ? '🔥' : '') + '</span>';
        }
      }

      html += '<div class="seat-box' + (isLatestSeat ? ' active-event' : '') + '" data-seat-box="' + sk + '">' +
        '<div class="seat-box-head">' +
          '<span class="seat-box-name">' + meta.icon + ' ' + meta.title + '</span>' +
          threatBadge +
        '</div>' +
        '<div class="seat-melds-wrap">' + meldsHtml + '</div>' +
        '<div class="seat-discards-wrap">' + discardsHtml + '</div>' +
      '</div>';
    }

    grid.innerHTML = html;

    // Bind removal of mis-recorded melds
    grid.querySelectorAll('[data-del-meld-seat]').forEach(function(el) {
      el.addEventListener('click', function() {
        var sk = el.getAttribute('data-del-meld-seat');
        var idx = parseInt(el.getAttribute('data-del-meld-idx'), 10);
        if (tableState.seats[sk] && tableState.seats[sk].melds[idx] !== undefined) {
          pushUndoSnapshot();
          tableState.seats[sk].melds.splice(idx, 1);
          renderAssistAll();
        }
      });
    });

    // Bind removal of mis-recorded discards
    grid.querySelectorAll('[data-discard-seat]').forEach(function(el) {
      el.addEventListener('click', function() {
        var sk = el.getAttribute('data-discard-seat');
        var idx = parseInt(el.getAttribute('data-discard-idx'), 10);
        if (tableState.seats[sk] && tableState.seats[sk].discards[idx] !== undefined) {
          pushUndoSnapshot();
          tableState.seats[sk].discards.splice(idx, 1);
          tableState.latestEvent = null;
          renderAssistAll();
        }
      });
    });
  }

  function renderAssistHand(fullRes) {
    var container = document.getElementById('assistHandRow');
    var countBadge = document.getElementById('assistHandCountBadge');
    var hintEl = document.getElementById('assistEditModeHint');
    if (!container || !window.MahjongEngine) return;

    var assistHand = tableState.myHand;
    assistHand.sort(function(a, b) { return a - b; });
    var myMelds = tableState.seats.bottom.melds || [];

    if (countBadge) {
      var mod = assistHand.length % 3;
      var stateText = (mod === 2) ? '（当前该您出牌）' : ((mod === 1) ? '（当前等待摸牌或吃/碰拦截）' : '（相公牌数，请增删）');
      countBadge.textContent = '自家手牌：' + assistHand.length + ' 张 · 已吃碰 ' + myMelds.length + ' 副 ' + stateText;
    }

    if (hintEl) {
      if (selectedSlotIndex >= 0 && selectedSlotIndex < assistHand.length) {
        hintEl.innerHTML = '🎯 正在替换第 <b>' + (selectedSlotIndex + 1) + '</b> 张【' +
          window.MahjongEngine.tileName(assistHand[selectedSlotIndex]) +
          '】——请点击下方麻将牌替换，或 <a href="javascript:void(0)" id="assistCancelSlotBtn" style="color:#ffd700;text-decoration:underline;">取消选中</a>';
      } else {
        hintEl.textContent = '💡 点击手牌可替换校正，点击右上角 × 即为「实战打出此牌」并记入自家牌河';
      }
    }

    var analysis = fullRes.handAnalysis;
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
        '<button type="button" class="assist-slot-del" data-del="' + i + '" title="打出/移除这张牌">×</button>' +
      '</div>';
    }
    container.innerHTML = html;

    container.querySelectorAll('.assist-slot-wrap').forEach(function(wEl) {
      wEl.addEventListener('click', function(e) {
        if (e.target && e.target.getAttribute('data-del') !== null) return;
        var idx = parseInt(wEl.getAttribute('data-slot'), 10);
        selectedSlotIndex = (selectedSlotIndex === idx) ? -1 : idx;
        currentTargetMode = 'my-hand';
        syncTargetModeButtons();
        renderAssistAll();
      });
    });

    container.querySelectorAll('.assist-slot-del').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute('data-del'), 10);
        if (!isNaN(idx) && idx >= 0 && idx < tableState.myHand.length) {
          pushUndoSnapshot();
          var removedTile = tableState.myHand.splice(idx, 1)[0];
          tableState.seats.bottom.discards.push(removedTile);
          tableState.latestEvent = null;
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
        renderAssistAll();
      });
    }
  }

  function renderAssistAnalysis(fullRes) {
    var outEl = document.getElementById('assistAnalysisOutput');
    if (!outEl || !window.MahjongEngine) return;

    var assistHand = tableState.myHand;
    if (assistHand.length === 0) {
      outEl.innerHTML = '<div class="assist-empty-tip">📭 当前手牌为空，请使用上方相机实时盯盘，或直接点击下方牌库录入。</div>';
      return;
    }

    var res = fullRes.handAnalysis;
    if (res.mode === 'invalid') {
      outEl.innerHTML = '<div class="assist-empty-tip">⚠️ 当前自家手牌为 <b>' + assistHand.length + '</b> 张（相公牌数）。标准手牌应为 <b>13/14张</b>（若有吃碰则为 10/11、7/8、4/5 张）。请增删 1~2 张牌以获取精准军师建议！</div>';
      return;
    }

    var html = '';
    if (res.isHu) {
      html += '<div class="assist-hu-banner">🎉 恭喜！您当前这副 <b>' + assistHand.length + '</b> 张手牌已经满足【胡牌 / 自摸】牌型，可以直接推倒胡牌！</div>';
    }

    if (res.mode === 'discard') {
      var recs = res.recommendations.slice(0, 3);
      html += '<div class="assist-sec-title">👑 雀神军师 · 全局攻防最优出牌推荐（已扣减全桌吃碰与舍牌）</div>';
      html += '<div class="assist-rec-list">';
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        var rankLabels = ['🥇 首选出牌', '🥈 次选方案', '🥉 备选方案'];
        var cardCls = (i === 0) ? 'assist-rec-card best' : 'assist-rec-card';
        var subPills = '';
        if (r.isTing && r.tingWaits.length > 0) {
          subPills = '<div class="assist-waits-row"><span class="assist-wait-tag ting">听牌明细(扣全桌)：</span>';
          r.tingWaits.forEach(function(w) {
            subPills += '<span class="assist-wait-pill"><b>' + w.name + '</b> 剩' + w.remaining + '张</span>';
          });
          subPills += '</div>';
        } else if (r.effectiveDraws && r.effectiveDraws.length > 0) {
          subPills = '<div class="assist-waits-row"><span class="assist-wait-tag eff">有效进张(扣全桌)：</span>';
          r.effectiveDraws.slice(0, 6).forEach(function(d) {
            subPills += '<span class="assist-wait-pill">' + d.name + '(剩' + d.remaining + ')' + (d.entersTing ? '🔥入听' : '') + '</span>';
          });
          if (r.effectiveKindCount > 6) {
            subPills += '<span class="assist-wait-pill">等共 ' + r.effectiveKindCount + ' 种(' + r.effectiveTotal + '张)</span>';
          }
          subPills += '</div>';
        }

        var dangerBadge = '<span class="danger-pill ' + (r.dangerLevel || 'medium') + '">' + (r.dangerLabel || '🟡 普通生张') + '</span>';

        html += '<div class="' + cardCls + '">' +
          '<div class="assist-rec-left">' +
            window.MahjongEngine.tileHTML(r.tile, 'rec-mini-tile') +
          '</div>' +
          '<div class="assist-rec-body">' +
            '<div class="assist-rec-head">' +
              '<span class="assist-rank-badge">' + rankLabels[i] + '：打【' + r.name + '】</span>' +
              dangerBadge +
              '<button type="button" class="assist-do-discard-btn" data-discard="' + r.tile + '">⚡ 实战打出此牌</button>' +
            '</div>' +
            '<div class="assist-rec-reason">' + r.reason + '</div>' +
            subPills +
          '</div>' +
        '</div>';
      }
      html += '</div>';
    } else if (res.mode === 'draw') {
      if (res.isTing) {
        html += '<div class="assist-ting-banner">🔥 当前手牌已进入【听牌】状态！扣除四家已见牌后，共可胡 <b>' + res.tingWaits.length + '</b> 种、合计还剩 <b>' + res.tingTotal + '</b> 张牌：</div>';
        html += '<div class="assist-waits-row" style="margin-bottom:8px;">';
        res.tingWaits.forEach(function(w) {
          html += '<span class="assist-wait-pill win-pill">🀄 胡 <b>' + w.name + '</b>（全桌剩 ' + w.remaining + ' 张）</span>';
        });
        html += '</div>';
      } else {
        html += '<div class="assist-sec-title">🔍 当前为 ' + assistHand.length + ' 张手牌（等待摸牌，或盯三家出牌吃/碰/胡）</div>';
      }

      if (res.bestDraws && res.bestDraws.length > 0) {
        html += '<div class="assist-sub-note">👇 黄金进张预览（点击可模拟自家摸入；若别人出牌可在下方切换「上家/对家/下家打牌」秒算吃碰）：</div>';
        html += '<div class="assist-waits-row">';
        res.bestDraws.slice(0, 8).forEach(function(d) {
          html += '<span class="assist-wait-pill draw-click-pill" data-drawtile="' + d.tile + '" style="cursor:pointer;" title="点击模拟摸进这张牌">' +
            '➕ 摸【<b>' + d.name + '</b>】(剩' + d.remaining + ')' + (d.winsNow ? '🔥胡牌' : '') +
          '</span>';
        });
        html += '</div>';
      }
    }

    outEl.innerHTML = html;

    outEl.querySelectorAll('.assist-do-discard-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var dTile = parseInt(btn.getAttribute('data-discard'), 10);
        var idx = tableState.myHand.indexOf(dTile);
        if (idx >= 0) {
          pushUndoSnapshot();
          tableState.myHand.splice(idx, 1);
          tableState.seats.bottom.discards.push(dTile);
          tableState.latestEvent = null;
          selectedSlotIndex = -1;
          setStatusText('✋ 已打出【' + window.MahjongEngine.tileName(dTile) + '】并记入自家牌河！现在盯上/对/下家出牌与吃碰');
          renderAssistAll();
        }
      });
    });

    outEl.querySelectorAll('.draw-click-pill').forEach(function(pill) {
      pill.addEventListener('click', function() {
        var dt = parseInt(pill.getAttribute('data-drawtile'), 10);
        if (!isNaN(dt) && tableState.myHand.length < 14) {
          pushUndoSnapshot();
          tableState.myHand.push(dt);
          tableState.latestEvent = null;
          selectedSlotIndex = -1;
          renderAssistAll();
        }
      });
    });
  }

  function renderAssistPalette(fullRes) {
    var palContainer = document.getElementById('assistTilePalette');
    if (!palContainer || !window.MahjongEngine) return;

    var remByTile = fullRes ? fullRes.remainingByTile : new Array(35).fill(4);

    if (palContainer.children.length === 0) {
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
          html += '<div class="assist-pal-item" data-ptile="' + t + '" title="点击记录 ' + window.MahjongEngine.tileName(t) + '">' +
            window.MahjongEngine.tileHTML(t, 'small-pal-tile') +
            '<span class="pal-rem-badge" data-rem-for="' + t + '">剩4</span>' +
          '</div>';
        }
        html += '</div></div>';
      }
      palContainer.innerHTML = html;

      palContainer.querySelectorAll('.assist-pal-item').forEach(function(item) {
        item.addEventListener('click', function() {
          var t = parseInt(item.getAttribute('data-ptile'), 10);
          if (isNaN(t)) return;
          handlePaletteTileClick(t);
        });
      });
    }

    // Update remaining counts on all palette tiles
    for (var tileId = 0; tileId <= 34; tileId++) {
      var badge = palContainer.querySelector('[data-rem-for="' + tileId + '"]');
      if (badge) {
        var rem = remByTile[tileId] !== undefined ? remByTile[tileId] : 4;
        badge.textContent = (rem === 0) ? '绝0' : ('剩' + rem);
        badge.className = 'pal-rem-badge' + (rem === 0 ? ' rem-0' : (rem === 1 ? ' rem-1' : ''));
      }
    }
  }

  function handlePaletteTileClick(t) {
    var tName = window.MahjongEngine ? window.MahjongEngine.tileName(t) : '';

    if (currentTargetMode === 'my-hand') {
      pushUndoSnapshot();
      if (selectedSlotIndex >= 0 && selectedSlotIndex < tableState.myHand.length) {
        tableState.myHand[selectedSlotIndex] = t;
        if (selectedSlotIndex + 1 < tableState.myHand.length) {
          selectedSlotIndex++;
        } else {
          selectedSlotIndex = -1;
        }
      } else {
        if (tableState.myHand.length >= 14) {
          historyStack.pop();
          setStatusText('ℹ️ 自家手牌已满 14 张！请先点击某张手牌替换，或切换下方「上家/对家/下家」记录别人出牌');
          return;
        }
        tableState.myHand.push(t);
        tableState.latestEvent = null;
      }
      renderAssistAll();
      return;
    }

    var parts = currentTargetMode.split('-');
    var seat = parts[0]; // 'left' | 'top' | 'right' | 'bottom'
    var kind = parts[1]; // 'discard' | 'meld'

    if (kind === 'discard') {
      recordSeatAction(seat, 'discard', [t]);
      setStatusText('⚡ 已记录：' + SEAT_DISPLAY[seat].title + '打出【' + tName + '】——已实时计算拦截与全局剩余张数');
    } else if (kind === 'meld') {
      if (currentMeldSubType === 'gang') {
        recordSeatAction(seat, 'gang', [t, t, t, t]);
        setStatusText('⚡ 已记录：' + SEAT_DISPLAY[seat].title + '杠【' + tName + '】');
      } else if (currentMeldSubType === 'chi') {
        if (t >= 27) {
          setStatusText('⚠️ 字牌不能吃顺子，已按碰牌记录【' + tName + '】');
          recordSeatAction(seat, 'peng', [t, t, t]);
        } else {
          var r = t % 9;
          var start = (r <= 6) ? t : (t - (r - 6));
          var seq = [start, start + 1, start + 2];
          recordSeatAction(seat, 'chi', seq);
          setStatusText('⚡ 已记录：' + SEAT_DISPLAY[seat].title + '吃【' + seq.map(window.MahjongEngine.tileName).join('') + '】');
        }
      } else {
        recordSeatAction(seat, 'peng', [t, t, t]);
        setStatusText('⚡ 已记录：' + SEAT_DISPLAY[seat].title + '碰【' + tName + '】');
      }
    }
  }

  function syncTargetModeButtons() {
    var bar = document.getElementById('assistTargetModeBar');
    var subBar = document.getElementById('assistMeldSubmodeBar');
    if (bar) {
      bar.querySelectorAll('.target-mode-btn').forEach(function(b) {
        if (b.getAttribute('data-target-mode') === currentTargetMode) b.classList.add('active');
        else b.classList.remove('active');
      });
    }
    if (subBar) {
      subBar.style.display = (currentTargetMode.indexOf('-meld') >= 0) ? 'flex' : 'none';
    }
  }

  function renderAssistAll() {
    if (!window.MahjongEngine) return;
    var fullRes = window.MahjongEngine.analyzeFullTable(tableState);
    renderClaimBanner(fullRes);
    renderTableSandbox(fullRes);
    renderAssistHand(fullRes);
    renderAssistAnalysis(fullRes);
    renderAssistPalette(fullRes);
    if (fullRes.voiceSummary) {
      speakAdvice(fullRes.voiceSummary);
    }
  }

  /* ================= Event Wiring & Public API ================= */
  function initCameraAssist() {
    var keyInput = document.getElementById('assistGeminiKeyInput');
    if (keyInput && !keyInput.value) {
      keyInput.value = getSavedGeminiKey();
    }
    if (keyInput) {
      keyInput.addEventListener('change', function() {
        saveGeminiKey(keyInput.value);
      });
    }

    var btnAutoWatch = document.getElementById('btnAssistAutoWatch');
    if (btnAutoWatch) {
      btnAutoWatch.addEventListener('click', function() {
        toggleAutoWatch();
      });
    }

    var btnStartCam = document.getElementById('btnAssistStartCam');
    if (btnStartCam) {
      btnStartCam.addEventListener('click', function() {
        startCamera();
      });
    }

    var btnVoiceOut = document.getElementById('btnAssistVoiceOut');
    if (btnVoiceOut) {
      btnVoiceOut.addEventListener('click', function() {
        voiceOutEnabled = !voiceOutEnabled;
        btnVoiceOut.textContent = voiceOutEnabled ? '🔊 语音报招: 开' : '🔇 语音报招: 关';
      });
    }

    var btnVoiceIn = document.getElementById('btnAssistVoiceIn');
    if (btnVoiceIn) {
      btnVoiceIn.addEventListener('click', function() {
        toggleVoiceInput();
      });
    }

    var btnSnap = document.getElementById('btnAssistCapture');
    if (btnSnap) {
      btnSnap.addEventListener('click', function() {
        var video = document.getElementById('assistCameraVideo');
        if (video && stream) {
          captureAndRecognize(video, false, false);
        } else {
          var fileInp = document.getElementById('assistFileInput');
          if (fileInp) fileInp.click();
        }
      });
    }

    var btnUpload = document.getElementById('assistUploadBtn') || document.getElementById('btnAssistUpload');
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
            captureAndRecognize(img, true, false);
          };
          img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
        fileInp.value = '';
      });
    }

    var btnUndo = document.getElementById('btnAssistUndo');
    if (btnUndo) {
      btnUndo.addEventListener('click', function() {
        undoLastAction();
      });
    }

    var btnClear = document.getElementById('btnAssistClearHand');
    if (btnClear) {
      btnClear.addEventListener('click', function() {
        pushUndoSnapshot();
        tableState = {
          myHand: [],
          seats: {
            bottom: { melds: [], discards: [] },
            right:  { melds: [], discards: [] },
            top:    { melds: [], discards: [] },
            left:   { melds: [], discards: [] }
          },
          latestEvent: null
        };
        selectedSlotIndex = -1;
        renderAssistAll();
        setStatusText('🔄 已开启新一局（四家牌河、副露与手牌已清空）');
      });
    }

    var btnDemo = document.getElementById('btnAssistDemoHand');
    if (btnDemo) {
      btnDemo.addEventListener('click', function() {
        pushUndoSnapshot();
        tableState = {
          myHand: [0, 1, 4, 5, 9, 10, 11, 18, 19, 20, 27, 27, 31],
          seats: {
            bottom: { melds: [], discards: [8, 29] },
            right:  { melds: [{ type: 'peng', tiles: [12, 12, 12] }, { type: 'chi', tiles: [15, 16, 17] }], discards: [0, 26] },
            top:    { melds: [{ type: 'peng', tiles: [31, 31, 31] }], discards: [18, 28] },
            left:   { melds: [], discards: [30, 2] }
          },
          latestEvent: { seat: 'left', type: 'discard', tile: 2 }
        };
        selectedSlotIndex = -1;
        renderAssistAll();
        setStatusText('🎲 已载入四家实战演示局：上家刚打出【三万】，下家2副露做条子，对家已碰红中！');
      });
    }

    var modeBar = document.getElementById('assistTargetModeBar');
    if (modeBar) {
      modeBar.querySelectorAll('.target-mode-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          currentTargetMode = btn.getAttribute('data-target-mode') || 'my-hand';
          if (currentTargetMode !== 'my-hand') selectedSlotIndex = -1;
          syncTargetModeButtons();
          renderAssistAll();
        });
      });
    }

    var subBar = document.getElementById('assistMeldSubmodeBar');
    if (subBar) {
      subBar.querySelectorAll('.meld-sub-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          currentMeldSubType = btn.getAttribute('data-meld-type') || 'peng';
          subBar.querySelectorAll('.meld-sub-btn').forEach(function(b) {
            if (b.getAttribute('data-meld-type') === currentMeldSubType) b.classList.add('active');
            else b.classList.remove('active');
          });
        });
      });
    }

    ensureTemplateBank();
    renderAssistAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCameraAssist);
  } else {
    initCameraAssist();
  }

  window.MahjongCameraAssist = {
    open: function() { renderAssistAll(); startCamera(); },
    close: stopCamera,
    setHand: function(arr) {
      tableState.myHand = (arr || []).slice();
      selectedSlotIndex = -1;
      renderAssistAll();
    },
    getHand: function() {
      return tableState.myHand.slice();
    },
    getTableState: function() {
      return cloneState(tableState);
    },
    setTableState: function(newState) {
      if (!newState) return;
      tableState = {
        myHand: Array.isArray(newState.myHand) ? newState.myHand.slice() : [],
        seats: {
          bottom: (newState.seats && newState.seats.bottom) ? cloneState(newState.seats.bottom) : { melds: [], discards: [] },
          right:  (newState.seats && newState.seats.right)  ? cloneState(newState.seats.right)  : { melds: [], discards: [] },
          top:    (newState.seats && newState.seats.top)    ? cloneState(newState.seats.top)    : { melds: [], discards: [] },
          left:   (newState.seats && newState.seats.left)   ? cloneState(newState.seats.left)   : { melds: [], discards: [] }
        },
        latestEvent: newState.latestEvent ? cloneState(newState.latestEvent) : null
      };
      selectedSlotIndex = -1;
      renderAssistAll();
    },
    recordSeatAction: recordSeatAction,
    executeClaimRecommendation: executeClaimRecommendation,
    recognizeCanvasKeyless: recognizeCanvasKeyless,
    toggleAutoWatch: toggleAutoWatch,
    isAutoWatching: function() { return autoWatchEnabled; }
  };
})();
