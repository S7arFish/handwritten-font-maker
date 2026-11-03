/* ==========================================================================
   手写数字生成器 & 字体制作器 (Complete Application Logic)
   ========================================================================== */
(function () {
  'use strict';

  const PX_PER_CM = 60; // 1 cm = 60 canvas pixels (152.4 DPI)

  // Configure PDF.js worker if available
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }

  // Fallback for <dialog closedby="any"> per Modern Web Guidance
  if (typeof HTMLDialogElement !== 'undefined' && !('closedBy' in HTMLDialogElement.prototype)) {
    const isOutside = (e, dialog) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
      let pressedOutside = false;
      dialog.addEventListener('pointerdown', (e) => {
        pressedOutside = isOutside(e, dialog);
      });
      dialog.addEventListener('pointerup', (e) => {
        if (pressedOutside && isOutside(e, dialog)) dialog.close();
      });
    }
  }

  // Sync native slider CSS custom properties per Modern Web Guidance
  function syncNativeSlider(slider) {
    if (!slider) return;
    slider.style.setProperty('--attr-min', slider.min || 0);
    slider.style.setProperty('--attr-max', slider.max || 100);
    slider.style.setProperty('--control-value', slider.value);
  }

  function initAllNativeSliders() {
    document.querySelectorAll('input[type="range"].native-slider').forEach((s) => {
      syncNativeSlider(s);
      s.addEventListener('input', () => syncNativeSlider(s));
    });
  }

  // Deterministic PRNG (Mulberry32) so slider adjustments don't flicker digits
  function mulberry32(a) {
    return function () {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randRange(rng, minMax) {
    const a = Number(minMax[0]) || 0;
    const b = Number(minMax[1]) || 0;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return lo + rng() * (hi - lo);
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // =========================================================================
  // Font Management, 6 Handwriting Styles & Dynamic CJK/Latin Glyph Synthesizer
  // =========================================================================
  const fontsRegistry = [];
  let activeFontIndex = 0;

  const BUILTIN_HANDWRITE_STYLES = [
    {
      id: 'hybrid_hanzipen',
      name: '默认实拍数字 + 翩翩手写中英 (推荐)',
      useRealDigits: true,
      primaryFont: '"HanziPen SC", "Hannotate SC", "Bradley Hand", "Noteworthy", "Kaiti SC", "STKaiti", cursive',
      secondaryFont: '"Hannotate SC", "HanziPen SC", "Noteworthy", "Kaiti SC", cursive',
      slantBias: -0.02
    },
    {
      id: 'hannotate',
      name: '清秀学生手札体 (中/英/数统一笔记风)',
      useRealDigits: false,
      primaryFont: '"Hannotate SC", "HanziPen SC", "Noteworthy", "Kaiti SC", cursive',
      secondaryFont: '"HanziPen SC", "Hannotate SC", "Bradley Hand", cursive',
      slantBias: 0.0
    },
    {
      id: 'xingkai',
      name: '潇洒行楷连笔体 (签字/评语/快写风)',
      useRealDigits: false,
      primaryFont: '"Xingkai SC", "LingWai SC", "Bradley Hand", "Snell Roundhand", "STKaiti", cursive',
      secondaryFont: '"LingWai SC", "Xingkai SC", "Bradley Hand", cursive',
      slantBias: -0.06
    },
    {
      id: 'lingwai',
      name: '锋芒钢笔凌慧体 (钢笔撇捺手写风)',
      useRealDigits: false,
      primaryFont: '"LingWai SC", "HanziPen SC", "Snell Roundhand", "Bradley Hand", cursive',
      secondaryFont: '"HanziPen SC", "LingWai SC", "Noteworthy", cursive',
      slantBias: -0.04
    },
    {
      id: 'wawati',
      name: '随性娃娃手写体 (圆润日常手写风)',
      useRealDigits: false,
      primaryFont: '"Wawati SC", "Hannotate SC", "Chalkboard SE", "Noteworthy", cursive',
      secondaryFont: '"Hannotate SC", "Wawati SC", "Chalkboard SE", cursive',
      slantBias: 0.02
    },
    {
      id: 'kaiti',
      name: '工整考卷正楷体 (标准楷书/衡水体英文)',
      useRealDigits: false,
      primaryFont: '"Kaiti SC", "STKaiti", "KaiTi", "Noteworthy", "Bradley Hand", serif',
      secondaryFont: '"STKaiti", "Kaiti SC", "HanziPen SC", serif',
      slantBias: -0.01
    }
  ];

  // Tint an existing image glyph to a target ink color (for colored pen inks on real digit PNGs)
  function createTintedGlyphVariant(g, inkColor) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, g.w);
    c.height = Math.max(1, g.h);
    const ctx = c.getContext('2d');
    ctx.drawImage(g.img, 0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = inkColor;
    ctx.fillRect(0, 0, c.width, c.height);
    return {
      w: g.w,
      h: g.h,
      img: c,
      isSynthesized: false
    };
  }

  // Synthesize 5 organic handwritten variants for ANY Chinese character, English letter, symbol, or digit
  function getGlyphVariantsForChar(font, ch, inkColor = '#161616') {
    if (!font || !ch) return [];

    // 1. Use photographed real digit glyphs when enabled
    if (font.useRealDigits && font.glyphs && font.glyphs[ch] && font.glyphs[ch].length > 0) {
      if (inkColor === '#161616') {
        return font.glyphs[ch];
      }
      if (!font.tintedCache) font.tintedCache = {};
      const tKey = `${inkColor}_${ch}`;
      if (!font.tintedCache[tKey]) {
        font.tintedCache[tKey] = font.glyphs[ch].map((g) => createTintedGlyphVariant(g, inkColor));
      }
      return font.tintedCache[tKey];
    }

    // 2. Otherwise synthesize & cache 5 organic stroke-perturbed variants on offscreen canvases
    if (!font.synthCache) font.synthCache = {};
    const cacheKey = `${inkColor}_${ch}`;
    if (font.synthCache[cacheKey]) {
      return font.synthCache[cacheKey];
    }

    const variants = [];
    const W = 76;
    const H = 64;
    const isCJK = /[\u3000-\u9fff\uff00-\uffef]/.test(ch);
    const baseFontPx = isCJK ? 41 : 43;
    const sp = font.styleProfile || null;
    const slantBias = sp ? sp.slantBias : font.slantBias || 0;
    const profileSX = sp ? sp.aspectScaleX : 1.0;
    const profileSY = sp ? sp.aspectScaleY : 1.0;
    const profilePress = sp ? sp.strokePress : 0.25;

    const microTransforms = [
      { famIdx: 0, sx: 1.0 * profileSX, sy: 1.0 * profileSY, kx: slantBias - 0.03, ky: -0.01, press: profilePress },
      { famIdx: 0, sx: 0.97 * profileSX, sy: 1.03 * profileSY, kx: slantBias + 0.02, ky: 0.015, press: Math.min(0.6, profilePress + 0.06) },
      { famIdx: 0, sx: 1.03 * profileSX, sy: 0.98 * profileSY, kx: slantBias - 0.05, ky: -0.015, press: Math.max(0.1, profilePress - 0.05) },
      { famIdx: 1, sx: 0.99 * profileSX, sy: 1.01 * profileSY, kx: slantBias + 0.01, ky: 0.01, press: profilePress + 0.02 },
      { famIdx: 0, sx: 0.98 * profileSX, sy: 1.02 * profileSY, kx: slantBias - 0.02, ky: 0.02, press: Math.min(0.6, profilePress + 0.08) }
    ];

    for (let v = 0; v < microTransforms.length; v++) {
      const mt = microTransforms[v];
      const fam = mt.famIdx === 1 && font.secondaryFont ? font.secondaryFont : font.primaryFont || '"HanziPen SC", "Kaiti SC", cursive';
      const temp = document.createElement('canvas');
      temp.width = W;
      temp.height = H;
      const tctx = temp.getContext('2d');

      tctx.save();
      tctx.translate(W / 2, H / 2 + 2);
      tctx.transform(mt.sx, mt.ky, mt.kx, mt.sy, 0, 0);
      tctx.font = `${baseFontPx}px ${fam}`;
      tctx.textAlign = 'center';
      tctx.textBaseline = 'middle';
      tctx.fillStyle = inkColor;
      tctx.fillText(ch, 0, 0);

      // Subtle second ink-pressure pass for gel-pen / fountain-pen stroke texture
      tctx.globalAlpha = mt.press;
      tctx.fillText(ch, 0.45, 0.25);
      tctx.restore();

      // Measure horizontal ink bounds so proportional characters ('i', 'm', '汉', ',') have natural width
      // while keeping the unified vertical em-frame (y = 4..60, h = 56) so baselines align 100%!
      const imgData = tctx.getImageData(0, 0, W, H).data;
      let minX = W;
      let maxX = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (imgData[(y * W + x) * 4 + 3] > 16) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
      }

      if (minX > maxX) {
        minX = Math.floor(W * 0.35);
        maxX = Math.ceil(W * 0.65);
      }

      const padX = isCJK ? 2 : 3;
      const cropX = Math.max(0, minX - padX);
      const cropW = Math.max(8, Math.min(W - cropX, maxX - minX + padX * 2 + 1));
      const cropY = 4;
      const cropH = 56;

      const outCanvas = document.createElement('canvas');
      outCanvas.width = cropW;
      outCanvas.height = cropH;
      const outCtx = outCanvas.getContext('2d');
      outCtx.drawImage(temp, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      variants.push({
        w: cropW,
        h: cropH,
        img: outCanvas,
        isSynthesized: true,
        isCJK
      });
    }

    font.synthCache[cacheKey] = variants;
    return variants;
  }

  async function loadFontFromData(fontData, isCustomExport = false) {
    const loadedGlyphs = {};
    const labels = Object.keys((fontData && fontData.glyphs) || {
      '1': [], '2': [], '3': [], '4': [], '5': [], '6': [], '7': [], '8': [], '9': [], '0': [], '.': []
    });
    const promises = [];

    for (const k of labels) {
      loadedGlyphs[k] = [];
      const arr = (fontData.glyphs && fontData.glyphs[k]) || [];
      for (const item of arr) {
        const p = new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            loadedGlyphs[k].push({
              w: item.w || img.width,
              h: item.h || img.height,
              src: item.src,
              img
            });
            resolve();
          };
          img.onerror = () => resolve();
          img.src = item.src;
        });
        promises.push(p);
      }
    }
    await Promise.all(promises);
    const totalCount = Object.values(loadedGlyphs).reduce((acc, v) => acc + v.length, 0);

    if (!isCustomExport && fontsRegistry.length === 0) {
      // Populate all 6 built-in handwriting styles (Style 0 uses real photographed digits + CJK/Latin synth)
      BUILTIN_HANDWRITE_STYLES.forEach((st, idx) => {
        fontsRegistry.push({
          id: st.id,
          name: st.name,
          useRealDigits: st.useRealDigits,
          primaryFont: st.primaryFont,
          secondaryFont: st.secondaryFont,
          slantBias: st.slantBias,
          glyphs: idx === 0 ? loadedGlyphs : {},
          totalCount: idx === 0 ? `${totalCount}实拍+全字库中英` : '全字库汉字/英语/数字',
          synthCache: {},
          tintedCache: {}
        });
      });
      activeFontIndex = 0;
    } else {
      const sp = fontData.styleProfile || null;
      const entry = {
        id: `custom_${fontsRegistry.length}`,
        name: fontData.name || `自定义手写字体 #${fontsRegistry.length + 1}`,
        useRealDigits: true,
        primaryFont: BUILTIN_HANDWRITE_STYLES[0].primaryFont,
        secondaryFont: BUILTIN_HANDWRITE_STYLES[0].secondaryFont,
        slantBias: sp ? sp.slantBias : -0.02,
        styleProfile: sp,
        glyphs: loadedGlyphs,
        totalCount: sp ? `${totalCount}实拍字形 + 个人笔迹特征迁移` : `${totalCount}实拍+全字库中英`,
        synthCache: {},
        tintedCache: {}
      };
      fontsRegistry.push(entry);
      activeFontIndex = fontsRegistry.length - 1;
    }

    refreshFontSelectUI();
    return fontsRegistry[activeFontIndex];
  }

  function refreshFontSelectUI() {
    const sel = document.getElementById('fontSelect');
    if (!sel) return;
    sel.innerHTML = '';
    fontsRegistry.forEach((f, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = `${f.name}`;
      sel.appendChild(opt);
    });
    sel.value = String(activeFontIndex);
    const active = fontsRegistry[activeFontIndex];
    const statusGlyph = document.getElementById('statusGlyphCount');
    if (statusGlyph && active) {
      statusGlyph.textContent = `当前字体: ${active.name} (${active.totalCount})`;
    }
  }

  // =========================================================================
  // Parameter Schema for Dual-Thumb Randomization Sections
  // =========================================================================
  const RANDOM_SECTIONS_SCHEMA = {
    cellRandom: {
      mountId: 'mountCellRandom',
      fields: [
        { key: 'offsetX', label: '单元格随机左右偏移', leftTag: '左移', rightTag: '右移', min: -15, max: 15, step: 0.01, def: [-4.27, 4.94] },
        { key: 'offsetY', label: '单元格随机上下偏移', leftTag: '下移', rightTag: '上移', min: -10, max: 10, step: 0.01, def: [-0.66, 2.12] },
        { key: 'scale', label: '整体随机缩放', leftTag: '缩小', rightTag: '放大', min: -0.5, max: 0.5, step: 0.01, def: [-0.17, 0.21] },
        { key: 'rotate', label: '单元格整体旋转', leftTag: '左转', rightTag: '右转', min: -15, max: 15, step: 0.01, def: [-2.0, 5.5] }
      ]
    },
    charPosRandom: {
      mountId: 'mountCharPosRandom',
      fields: [
        { key: 'offsetX', label: '水平位置', leftTag: '左移', rightTag: '右移', min: -10, max: 10, step: 0.01, def: [-1.01, 2.11] },
        { key: 'offsetY', label: '垂直位置', leftTag: '下移', rightTag: '上移', min: -10, max: 10, step: 0.01, def: [-2.2, 0.8] },
        { key: 'rotate', label: '单字旋转', leftTag: '左转', rightTag: '右转', min: -18, max: 18, step: 0.01, def: [-2.5, 2.5] },
        { key: 'spacing', label: '字间距', leftTag: '重叠', rightTag: '分开', min: -35, max: 35, step: 0.1, def: [-6.0, 4.0] }
      ]
    },
    charShapeRandom: {
      mountId: 'mountCharShapeRandom',
      fields: [
        { key: 'size', label: '字体大小', leftTag: '缩小', rightTag: '放大', min: -0.4, max: 0.4, step: 0.01, def: [-0.06, 0.08] },
        { key: 'bold', label: '字体随机加粗', leftTag: '默认', rightTag: '加粗', min: 0, max: 1.5, step: 0.01, def: [0, 0.35] },
        { key: 'gray', label: '字体灰度', leftTag: '黑色', rightTag: '灰色', min: 0, max: 60, step: 0.5, def: [0, 18] },
        { key: 'stretchX', label: '水平拉伸', leftTag: '压缩', rightTag: '拉伸', min: -0.4, max: 0.4, step: 0.01, def: [-0.06, 0.08] },
        { key: 'stretchY', label: '垂直拉伸', leftTag: '压缩', rightTag: '拉伸', min: -0.4, max: 0.4, step: 0.01, def: [-0.06, 0.08] }
      ]
    },
    dotRandom: {
      mountId: 'mountDotRandom',
      fields: [
        { key: 'offsetY', label: '小数点上下', leftTag: '下移', rightTag: '上移', min: -12, max: 12, step: 0.01, def: [-1.2, 1.5] },
        { key: 'size', label: '小数点大小', leftTag: '缩小', rightTag: '放大', min: -0.5, max: 0.8, step: 0.01, def: [-0.1, 0.25] }
      ]
    }
  };

  // =========================================================================
  // Application State
  // =========================================================================
  const state = {
    projectPath: '',
    pages: [], // [{ width, height, widthCm, heightCm, img }]
    currentPage: 1,
    zoom: 145,
    panX: 28,
    panY: 24,
    hideLegend: false,
    showColRuler: false,
    showRowRuler: false,
    normalizeFontSize: true,
    scratchEffect: false,
    dragMode: 'char', // 'char' | 'cell' | 'row' | 'pan'
    hitBoxes: { chars: [], cells: [], rows: [] },
    globalSeed: 20261103,
    clipboardSection: {},
    config: {
      startX: 4.91,
      startY: 3.82,
      colWidth: 1.82,
      rowHeight: 0.72,
      cellPad: -0.28,
      rows: 24,
      cols: 10,
      activeCols: [1, 3, 5, 7, 9],
      colOffsets: {}, // per-column custom X offset in cm
      rowOffsets: {}, // per-row custom { dx, dy } offset in px
      cellOffsets: {}, // per-cell custom { dx, dy } offset in px
      charOffsets: {}, // per-character custom { dx, dy } offset in px
      pageConfigs: {}, // per-page overrides for startX, startY, rows
      fillMode: 'random', // 'random' | 'manual'
      visionPreset: false,
      digitSlots: [
        { type: 'digit', digits: [3] },
        { type: 'digit', digits: [6] },
        { type: 'dot', digits: ['.'] },
        { type: 'digit', digits: [1, 2, 3, 4, 5, 6, 7, 8, 9] }
      ],
      manualData: [], // 2D array [row][col]
      cellRandom: {
        offsetX: [-4.27, 4.94],
        offsetY: [-0.66, 2.12],
        scale: [-0.17, 0.21],
        rotate: [-2.0, 5.5]
      },
      charPosRandom: {
        offsetX: [-1.01, 2.11],
        offsetY: [-2.2, 0.8],
        rotate: [-2.5, 2.5],
        spacing: [-6.0, 4.0]
      },
      charShapeRandom: {
        size: [-0.06, 0.08],
        bold: [0, 0.35],
        gray: [0, 18],
        stretchX: [-0.06, 0.08],
        stretchY: [-0.06, 0.08]
      },
      dotRandom: {
        offsetY: [-1.2, 1.5],
        size: [-0.1, 0.25]
      }
    }
  };

  // Undo / Redo History Stack
  const historyStack = [];
  let historyIndex = -1;
  let isRestoringHistory = false;

  function pushHistory() {
    if (isRestoringHistory) return;
    const snap = deepClone(state.config);
    if (historyIndex >= 0 && JSON.stringify(historyStack[historyIndex]) === JSON.stringify(snap)) {
      return;
    }
    historyStack.splice(historyIndex + 1);
    historyStack.push(snap);
    if (historyStack.length > 40) historyStack.shift();
    historyIndex = historyStack.length - 1;
    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    const btnUndo = document.getElementById('btnUndo');
    const btnRedo = document.getElementById('btnRedo');
    if (btnUndo) btnUndo.disabled = historyIndex <= 0;
    if (btnRedo) btnRedo.disabled = historyIndex >= historyStack.length - 1;
  }

  function undoConfig() {
    if (historyIndex > 0) {
      isRestoringHistory = true;
      historyIndex--;
      state.config = deepClone(historyStack[historyIndex]);
      syncAllControlsFromState();
      renderCurrentPage();
      updateUndoRedoButtons();
      isRestoringHistory = false;
    }
  }

  function redoConfig() {
    if (historyIndex < historyStack.length - 1) {
      isRestoringHistory = true;
      historyIndex++;
      state.config = deepClone(historyStack[historyIndex]);
      syncAllControlsFromState();
      renderCurrentPage();
      updateUndoRedoButtons();
      isRestoringHistory = false;
    }
  }

  // Helper to get active page's startX, startY, rows
  function getPageGridParams(pageNum = state.currentPage) {
    const pc = (state.config.pageConfigs && state.config.pageConfigs[String(pageNum)]) || {};
    return {
      startX: pc.startX !== undefined ? pc.startX : state.config.startX,
      startY: pc.startY !== undefined ? pc.startY : state.config.startY,
      rows: pc.rows !== undefined ? pc.rows : state.config.rows
    };
  }

  function setPageGridParam(key, val, pageNum = state.currentPage) {
    state.config[key] = val;
    if (!state.config.pageConfigs) state.config.pageConfigs = {};
    if (!state.config.pageConfigs[String(pageNum)]) {
      state.config.pageConfigs[String(pageNum)] = {};
    }
    state.config.pageConfigs[String(pageNum)][key] = val;
  }

  // =========================================================================
  // Sample Essays & Realistic Manual Table Data Generators (Chinese + English + Digits)
  // =========================================================================
  const SAMPLE_ARTICLES = {
    cn_essay: `　　人间四月，春风拂过江南的青石板路，檐角的雨滴落在微湿的苔痕上，晕开一圈圈浅浅的涟漪。我合上书页，推开木窗，远山如黛，近水含烟，天地间仿佛铺开了一卷未干的水墨长卷。
　　曾几何时，我们总在匆忙赶路，习惯了用键盘敲击冰冷的字符，却渐渐遗忘了笔尖摩挲纸背时的温度。一横一竖皆是风骨，一撇一捺尽藏心境。当墨水顺着笔锋渗入纸张纤维，那些或急促或舒缓的笔画，便成了时光最诚实的注脚。
　　无论是实验室里严谨记录的每一组数据，还是深夜灯下摘抄的一句诗词，手写的痕迹总能穿过漫长的岁月，在泛黄的纸页间焕发出鲜活的生命力。
　　少年读书如隙中窥月，中年读书如庭中望月，老年读书如台上玩月。愿我们始终保有提笔书写的从容与热爱，在方寸稿纸之间，写下属于自己的万里山河与烂漫春光。
　　行路难，行路难，多歧路，今安在？长风破浪会有时，直挂云帆济沧海。明日复明日，明日何其多，把握当下每一刻，不负韶华与初心。`,
    en_essay: `The Art of Handwritten Notes in the Digital Era
In an age dominated by instant messaging and cloud documents, the simple act of putting pen to paper holds a timeless charm. Every curve of a letter and every subtle shift in ink pressure tells a personal story that uniform digital fonts can never fully replicate.
First, handwriting deepens cognitive engagement. Studies in cognitive neuroscience consistently show that students who take handwritten notes retain conceptual structures far longer than those who type verbatim transcripts on a laptop.
Second, a handwritten page carries warmth and authenticity. Whether it is a laboratory logbook from 1989, a carefully drafted English essay, or a personal margin note in a favorite novel, ink on paper bridges the gap between thought and craft.
Let us keep a notebook on our desk, embrace the natural rhythm of pen strokes, and write with clarity, curiosity, and purpose every single day.
Practice makes perfect: ABCDEFGHIJKLMNOPQRSTUVWXYZ & abcdefghijklmnopqrstuvwxyz (0123456789).`,
    scratch_math: `【高等数学与大学物理推导演算草稿 - Page 1】
1. 高斯积分与正态分布归一化证明 (Gaussian Integral):
   令 I = ∫(-∞ → +∞) exp(-x^2) dx
   则 I^2 = ∫∫ exp(-(x^2 + y^2)) dx dy
   极坐标变换: x = r·cos(θ), y = r·sin(θ), J = r
   I^2 = ∫(0→2π) dθ ∫(0→∞) r·exp(-r^2) dr = 2π · [ -1/2 exp(-r^2) ] = π
   ∴ ∫ exp(-x^2) dx = √π ≈ 1.77245385

2. 简谐振子阻尼运动方程 (Damped Harmonic Oscillator):
   m·x'' + c·x' + k·x = 0   ==>   x'' + 2γ·x' + ω0^2·x = 0
   特征方程: λ^2 + 2γλ + ω0^2 = 0,  判别式 Δ = 4(γ^2 - ω0^2)
   欠阻尼条件 (γ < ω0):  ω_d = √(ω0^2 - γ^2),  x(t) = A·exp(-γt)·cos(ω_d·t + φ)

3. 实验误差传递核算 (Error Propagation Check):
   g = 4π^2 · L / T^2,   测得 L = 0.992 m,  T = 1.998 s
   计算得 g = 9.806 m/s^2,  相对误差 δ = |9.806 - 9.801| / 9.801 = 0.051% (符合实验要求 √)
   备注: 第 3 组视力与体温抽检样本均值 μ = 36.48 ℃, 标准差 σ = 0.18 ℃

【算法复杂度与矩阵特征值随手演算 - Page 2】
4. 设二阶实对称矩阵 A = [ 4  1 ; 1  4 ]
   det(A - λI) = (4 - λ)^2 - 1 = λ^2 - 8λ + 15 = (λ - 3)(λ - 5) = 0
   特征值: λ1 = 5,  λ2 = 3
   对应正交归一化特征向量: v1 = (1/√2, 1/√2)^T,  v2 = (1/√2, -1/√2)^T
5. 快速幂递推验证: T(n) = T(n/2) + O(1)  ==>  Time Complexity = O(log n), Space = O(1)
   测试序列: 36.5, 36.2, 36.8, 36.4, 36.6 -> 平均数 Mean = 36.50, 校验通过!`
  };

  const BILINGUAL_VOCAB_ROWS = [
    ['serendipity n.', '意外发现珍宝的运气；机缘巧合', 'A fortunate stroke of serendipity brought them together.'],
    ['resilience n.', '韧性；恢复力；抗挫能力', 'Mental resilience is essential in scientific research.'],
    ['ephemeral adj.', '朝生暮死的；短暂瞬息的', 'Fame in the digital world is often ephemeral.'],
    ['ubiquitous adj.', '无处不在的；普遍存在的', 'Smartphones have become ubiquitous in daily life.'],
    ['paradigm n.', '范式；典范；思维框架', 'AI has triggered a fundamental paradigm shift.'],
    ['meticulous adj.', '一丝不苟的；严谨细致的', 'She kept meticulous handwritten laboratory records.'],
    ['eloquent adj.', '雄辩的；有说服力的；传神的', 'His essay was both eloquent and deeply moving.'],
    ['pragmatic adj.', '务实的；注重实效的', 'We need a pragmatic approach to solve this bug.'],
    ['alleviate v.', '减轻；缓和；缓解痛苦', 'Regular exercise helps alleviate academic stress.'],
    ['corroborate v.', '证实；提供证据支持', 'Experimental data corroborated the theoretical model.'],
    ['lucid adj.', '清晰易懂的；透彻明晰的', 'The professor gave a lucid explanation of calculus.'],
    ['tenacious adj.', '坚韧不拔的；顽强持久的', 'Success belongs to those with a tenacious spirit.'],
    ['ambiguous adj.', '模棱两可的；含糊不清的', 'Avoid ambiguous wording in technical specifications.'],
    ['catalyst n.', '催化剂；促成变化的契机', 'Curiosity is the best catalyst for innovation.'],
    ['diligent adj.', '勤勉的；刻苦钻研的', 'Diligent practice improves English handwriting.'],
    ['empirical adj.', '经验主义的；以实验为依据的', 'Science relies on reproducible empirical evidence.'],
    ['feasible adj.', '可行的；行得通的', 'This pure-frontend PDF architecture is highly feasible.'],
    ['intrinsic adj.', '固有的；内在的；本质的', 'Learning has its own intrinsic reward and joy.'],
    ['nuance n.', '细微差别；微妙之处', 'Handwritten strokes capture every subtle nuance.'],
    ['scrutinize v.', '仔细检查；细致审阅', 'Always scrutinize boundary conditions in proofs.'],
    ['synthesize v.', '综合；合成；融会贯通', 'Synthesize multiple sources into a coherent view.'],
    ['versatile adj.', '多才多艺的；多功能的', 'Canvas 2D is a versatile rendering engine.'],
    ['authentic adj.', '真实的；逼真的；地道的', 'Multi-glyph sampling creates authentic handwriting.'],
    ['coherent adj.', '连贯的；条理分明的', 'Write a coherent outline before drafting the essay.'],
    ['conspicuous adj.', '显著的；引人注目的', 'The red origin crosshair is conspicuous on stage.'],
    ['culminate v.', '达到顶点；以……告终', 'Months of hard work culminated in a great release.'],
    ['discrepancy n.', '差异；不符；矛盾之处', 'Check for any discrepancy between measurement sets.'],
    ['exemplify v.', '作为……的典范；例证', 'These eight templates exemplify diverse use cases.'],
    ['fluctuate v.', '波动；上下起伏', 'Body temperature fluctuates slightly around 36.5℃.'],
    ['hypothesis n.', '假说；假设前提', 'Formulate a testable hypothesis before experiments.'],
    ['imperative adj.', '势在必行的；至关重要的', 'Data privacy is imperative for offline tools.'],
    ['Ingenious adj.', '巧妙的；独创性的', 'Connected-component BFS is an ingenious slicer.'],
    ['juxtapose v.', '并列放置；对比对照', 'Juxtapose Chinese and English handwriting styles.'],
    ['kinematics n.', '运动学；物理运动推导', 'Review kinematics equations on the scratch pad.'],
    ['luminous adj.', '发光的；清晰生动的', 'A luminous prose style leaves a lasting impression.'],
    ['mitigate v.', '减缓；降低风险', 'Local caching mitigates network latency completely.'],
    ['nostalgia n.', '怀旧之情；昔日情怀', 'Paper notebooks evoke a warm sense of nostalgia.'],
    ['optimistic adj.', '乐观的；充满希望的', 'Stay optimistic and keep refining your craft.'],
    ['perseverance n.', '毅力；坚持不懈', 'Perseverance turns difficult goals into reality.'],
    ['quintessential adj.', '最典型的；精髓的', 'Calligraphy is a quintessential traditional art.'],
    ['rigorous adj.', '严密的；缜密精确的', 'Apply rigorous mathematical derivations on page 2.'],
    ['spontaneous adj.', '自发的；自然流露的', 'Slightly jittered baselines look spontaneous.'],
    ['tangible adj.', '切实可感的；有形的', 'Printed PDF sheets provide a tangible result.'],
    ['unprecedented adj.', '前所未有的；空前的', 'Enjoy unprecedented freedom in per-char dragging.'],
    ['vivid adj.', '生动的；鲜明逼真的', 'Vivid ink textures make every page come alive.'],
    ['zealous adj.', '满腔热情的；积极投入的', 'A zealous learner takes notes with great care.']
  ];

  function generateRealisticVisionValue(rng) {
    const pool = [
      '5.0', '5.0', '5.0', '5.0', '5.0', '5.1', '5.1',
      '4.9', '4.9', '4.8', '4.8', '4.7', '4.7',
      '4.6', '4.6', '4.5', '4.4', '4.3'
    ];
    return pool[Math.floor(rng() * pool.length)];
  }

  function generateRealisticTempValue(rng) {
    const dec = Math.floor(1 + rng() * 9);
    return `36.${dec}`;
  }

  function populateManualTable(mode = 'vision') {
    state.config.manualPreset = mode;
    const rng = mulberry32(state.globalSeed + 999);
    const maxR = Math.max(state.config.rows * 2, 60);
    const maxC = Math.max(state.config.cols, 24);
    const table = [];

    const attendancePool = ['全勤', '正常', '已签到', '全勤', '正常', '准时出勤', '全勤'];
    const groupPool = ['Group-A1', 'Group-A2', 'Group-B1', 'Group-B2', 'Lab-C1', 'Lab-C2', 'Team-D1', 'Team-D2'];
    const scorePool = ['96.5', '94.0', '92.5', '91.0', '89.5', '95.0', '88.0', '93.5', '90.0', '97.0'];
    const gradePool = ['A+', 'A', 'A', 'A-', 'B+', 'A+', 'A', 'B+'];
    const commentPool = [
      '操作规范，数据准确',
      '字迹工整，分析透彻',
      '实验认真，结论严谨',
      '推导清晰，完成度高',
      '步骤完整，图表规范',
      '独立思考，表现优秀',
      '误差分析合理，合格',
      '仪器使用熟练，优良'
    ];
    const teacherPool = ['陈默然', '林晓峰', '苏婉清', '顾云深', '周子瑜', '叶知秋'];
    const statusPool = ['运行正常', '状态良好', '正常', '稳定运行', '正常 √', '良好'];
    const safetyPool = ['合格 OK', '已核验 √', 'Pass 合格', '安全正常', 'OK 正常'];

    for (let r = 0; r < maxR; r++) {
      const row = [];
      for (let c = 1; c <= maxC; c++) {
        if (mode === 'course_eval') {
          if (c === 1) row.push(attendancePool[Math.floor(rng() * attendancePool.length)]);
          else if (c === 2) row.push(groupPool[(r + Math.floor(rng() * 3)) % groupPool.length]);
          else if (c === 3) row.push(scorePool[Math.floor(rng() * scorePool.length)]);
          else if (c === 4) row.push(gradePool[Math.floor(rng() * gradePool.length)]);
          else if (c === 5) row.push(commentPool[(r + Math.floor(rng() * 2)) % commentPool.length]);
          else if (c === 6) row.push(teacherPool[r % teacherPool.length]);
          else row.push('正常');
        } else if (mode === 'lab_inspect') {
          if (c === 1) row.push(`LAB-${String.fromCharCode(65 + (r % 4))}0${(r % 9) + 1}`);
          else if (c === 2) row.push(`${22 + Math.floor(rng() * 3)}.${Math.floor(1 + rng() * 8)}℃`);
          else if (c === 3) row.push(`${45 + Math.floor(rng() * 8)}.${Math.floor(rng() * 9)}%`);
          else if (c === 4) row.push(statusPool[Math.floor(rng() * statusPool.length)]);
          else if (c === 5) row.push(safetyPool[Math.floor(rng() * safetyPool.length)]);
          else if (c === 6) row.push(teacherPool[(r + 1) % teacherPool.length]);
          else row.push('OK');
        } else if (mode === 'bilingual_notes') {
          const vItem = BILINGUAL_VOCAB_ROWS[r % BILINGUAL_VOCAB_ROWS.length];
          if (c === 1) row.push(vItem[0]);
          else if (c === 2) row.push(vItem[1]);
          else if (c === 3) row.push(vItem[2]);
          else row.push('');
        } else {
          const isShown = state.config.activeCols.includes(c);
          if (!isShown && mode === 'vision') {
            row.push(rng() < 0.72 ? '是' : '否');
          } else if (mode === 'vision') {
            row.push(generateRealisticVisionValue(rng));
          } else {
            row.push(generateRealisticTempValue(rng));
          }
        }
      }
      table.push(row);
    }
    state.config.manualData = table;
  }

  // =========================================================================
  // Dual-Thumb Slider Component Builder
  // =========================================================================
  const dualSliderUpdaters = {};

  function buildDualSliderSections() {
    for (const [sectionKey, schema] of Object.entries(RANDOM_SECTIONS_SCHEMA)) {
      const mount = document.getElementById(schema.mountId);
      if (!mount) continue;
      mount.innerHTML = '';
      dualSliderUpdaters[sectionKey] = {};

      for (const field of schema.fields) {
        const group = document.createElement('div');
        group.className = 'param-group';

        const lbl = document.createElement('span');
        lbl.className = 'param-label';
        lbl.textContent = field.label;
        group.appendChild(lbl);

        const row = document.createElement('div');
        row.className = 'dual-control-row';

        const leftTag = document.createElement('span');
        leftTag.className = 'side-tag';
        leftTag.textContent = field.leftTag;

        const inputMin = document.createElement('input');
        inputMin.type = 'number';
        inputMin.className = 'num-input';
        inputMin.step = String(field.step);
        inputMin.setAttribute('aria-label', `${field.label}最小值`);

        const dualWrap = document.createElement('div');
        dualWrap.className = 'dual-slider';
        const track = document.createElement('div');
        track.className = 'dual-track';
        const fill = document.createElement('div');
        fill.className = 'dual-range-fill';
        const thumbMin = document.createElement('div');
        thumbMin.className = 'dual-thumb';
        const thumbMax = document.createElement('div');
        thumbMax.className = 'dual-thumb';

        track.appendChild(fill);
        track.appendChild(thumbMin);
        track.appendChild(thumbMax);
        dualWrap.appendChild(track);

        const inputMax = document.createElement('input');
        inputMax.type = 'number';
        inputMax.className = 'num-input';
        inputMax.step = String(field.step);
        inputMax.setAttribute('aria-label', `${field.label}最大值`);

        const rightTag = document.createElement('span');
        rightTag.className = 'side-tag';
        rightTag.textContent = field.rightTag;

        const btnReset = document.createElement('button');
        btnReset.type = 'button';
        btnReset.className = 'icon-btn';
        btnReset.textContent = '↺';
        btnReset.title = `重置${field.label}`;

        row.append(leftTag, inputMin, dualWrap, inputMax, rightTag, btnReset);
        group.appendChild(row);
        mount.appendChild(group);

        const clampVal = (v) => {
          const n = Number(v);
          if (Number.isNaN(n)) return 0;
          return Math.max(field.min, Math.min(field.max, Number(n.toFixed(2))));
        };

        const updateVisual = () => {
          const pair = state.config[sectionKey][field.key] || [0, 0];
          const v0 = clampVal(Math.min(pair[0], pair[1]));
          const v1 = clampVal(Math.max(pair[0], pair[1]));
          inputMin.value = String(v0);
          inputMax.value = String(v1);
          const p0 = ((v0 - field.min) / (field.max - field.min)) * 100;
          const p1 = ((v1 - field.min) / (field.max - field.min)) * 100;
          fill.style.left = `${p0}%`;
          fill.style.width = `${Math.max(0, p1 - p0)}%`;
          thumbMin.style.left = `${p0}%`;
          thumbMax.style.left = `${p1}%`;
        };

        dualSliderUpdaters[sectionKey][field.key] = updateVisual;

        inputMin.addEventListener('change', () => {
          const v0 = clampVal(inputMin.value);
          const v1 = clampVal(state.config[sectionKey][field.key][1]);
          state.config[sectionKey][field.key] = [Math.min(v0, v1), Math.max(v0, v1)];
          updateVisual();
          pushHistory();
          renderCurrentPage();
        });

        inputMax.addEventListener('change', () => {
          const v0 = clampVal(state.config[sectionKey][field.key][0]);
          const v1 = clampVal(inputMax.value);
          state.config[sectionKey][field.key] = [Math.min(v0, v1), Math.max(v0, v1)];
          updateVisual();
          pushHistory();
          renderCurrentPage();
        });

        btnReset.addEventListener('click', () => {
          state.config[sectionKey][field.key] = [0, 0];
          updateVisual();
          pushHistory();
          renderCurrentPage();
        });

        // Pointer dragging on dual slider
        let activeThumb = null;
        dualWrap.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          dualWrap.setPointerCapture(e.pointerId);
          const rect = track.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const clickVal = field.min + ratio * (field.max - field.min);
          const [cur0, cur1] = state.config[sectionKey][field.key];
          if (Math.abs(clickVal - cur0) <= Math.abs(clickVal - cur1)) {
            activeThumb = 'min';
            thumbMin.classList.add('dragging');
          } else {
            activeThumb = 'max';
            thumbMax.classList.add('dragging');
          }
          onMove(e);
        });

        const onMove = (e) => {
          if (!activeThumb) return;
          const rect = track.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const rawVal = field.min + ratio * (field.max - field.min);
          const stepped = Math.round(rawVal / field.step) * field.step;
          const val = clampVal(stepped);
          let [v0, v1] = state.config[sectionKey][field.key];
          if (activeThumb === 'min') {
            v0 = Math.min(val, v1);
          } else {
            v1 = Math.max(val, v0);
          }
          state.config[sectionKey][field.key] = [v0, v1];
          updateVisual();
          renderCurrentPage();
        };

        dualWrap.addEventListener('pointermove', onMove);
        const endDrag = () => {
          if (!activeThumb) return;
          activeThumb = null;
          thumbMin.classList.remove('dragging');
          thumbMax.classList.remove('dragging');
          pushHistory();
        };
        dualWrap.addEventListener('pointerup', endDrag);
        dualWrap.addEventListener('pointercancel', endDrag);

        updateVisual();
      }
    }
  }

  // =========================================================================
  // Sync Left Sidebar Controls <-> State
  // =========================================================================
  function renderColsCheckGrid() {
    const grid = document.getElementById('colsCheckGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const totalCols = state.config.cols;
    for (let c = 1; c <= totalCols; c++) {
      const lbl = document.createElement('label');
      lbl.className = 'col-check-item';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = state.config.activeCols.includes(c);
      chk.addEventListener('change', () => {
        if (chk.checked) {
          if (!state.config.activeCols.includes(c)) {
            state.config.activeCols.push(c);
            state.config.activeCols.sort((a, b) => a - b);
          }
        } else {
          state.config.activeCols = state.config.activeCols.filter((x) => x !== c);
        }
        pushHistory();
        renderCurrentPage();
      });
      const sp = document.createElement('span');
      sp.textContent = `第${c}列`;
      lbl.append(chk, sp);
      grid.appendChild(lbl);
    }
  }

  let editingSlotIndex = -1;
  const CN_WORDS_PRESET_POOL = ['正常', '良好', '优秀', '合格', '全勤', '已检', '已签', '是', '否', '优', '良', '中'];
  const EN_LETTERS_PRESET_POOL = ['A+', 'A', 'A-', 'B+', 'B', 'Pass', 'OK', 'Yes', 'Lab', 'Good'];

  function renderDigitSlotsUI() {
    const list = document.getElementById('digitSlotsList');
    if (!list) return;
    list.innerHTML = '';
    state.config.digitSlots.forEach((slot, idx) => {
      const card = document.createElement('div');
      card.className = 'digit-slot-card';
      card.title = '点击编辑此槽位的候选数字/汉字/英语字母';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'slot-del-btn';
      delBtn.textContent = '✕';
      delBtn.title = '删除此槽位';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.config.digitSlots.length <= 1) return;
        state.config.digitSlots.splice(idx, 1);
        renderDigitSlotsUI();
        pushHistory();
        renderCurrentPage();
      });

      const nameEl = document.createElement('div');
      nameEl.className = 'slot-name';
      if (slot.type === 'dot') {
        nameEl.textContent = '小数点';
      } else if (slot.type === 'cn_words') {
        nameEl.innerHTML = '手写<br>汉字';
      } else if (slot.type === 'en_letters') {
        nameEl.innerHTML = '英语<br>字母';
      } else if (slot.type === 'custom_pool') {
        nameEl.innerHTML = '自定义<br>字符';
      } else {
        nameEl.innerHTML = '随机<br>数字';
      }

      const subEl = document.createElement('div');
      subEl.className = 'slot-sub';
      if (slot.type === 'dot') {
        subEl.textContent = '( . )';
      } else {
        const d = slot.digits || [];
        const summary = d.length === 1 ? `[${d[0]}]` : `[${d.slice(0, 2).join(',')}…]`;
        subEl.textContent = `(点击编辑 ${summary})`;
      }

      card.append(delBtn, nameEl, subEl);
      card.addEventListener('dblclick', () => openEditSlotModal(idx));
      card.addEventListener('click', () => openEditSlotModal(idx));
      list.appendChild(card);
    });
  }

  function populateSlotChecksGrid(type, selectedList) {
    const digitsWrap = document.getElementById('slotDigitsWrap');
    const customWrap = document.getElementById('slotCustomPoolWrap');
    const checksGrid = document.getElementById('slotDigitChecks');
    const customInput = document.getElementById('slotCustomPoolInput');

    if (type === 'dot') {
      digitsWrap.hidden = true;
      if (customWrap) customWrap.hidden = true;
      return;
    }
    if (type === 'custom_pool') {
      digitsWrap.hidden = true;
      if (customWrap) {
        customWrap.hidden = false;
        if (customInput && selectedList && selectedList.length) {
          customInput.value = selectedList.join(', ');
        }
      }
      return;
    }

    digitsWrap.hidden = false;
    if (customWrap) customWrap.hidden = true;
    checksGrid.innerHTML = '';

    const pool =
      type === 'cn_words'
        ? CN_WORDS_PRESET_POOL
        : type === 'en_letters'
        ? EN_LETTERS_PRESET_POOL
        : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

    const selStrs = (selectedList || []).map(String);
    for (const item of pool) {
      const lbl = document.createElement('label');
      lbl.className = 'digit-check-label';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.value = String(item);
      chk.checked = selStrs.includes(String(item));
      const sp = document.createElement('span');
      sp.textContent = String(item);
      lbl.append(chk, sp);
      checksGrid.appendChild(lbl);
    }
  }

  function openEditSlotModal(idx) {
    editingSlotIndex = idx;
    const slot = state.config.digitSlots[idx];
    if (!slot) return;
    const dialog = document.getElementById('dialogEditSlot');
    const typeSelect = document.getElementById('slotTypeSelect');

    typeSelect.value = slot.type || 'digit';
    populateSlotChecksGrid(typeSelect.value, slot.digits || []);
    dialog.showModal();
  }

  function syncAllControlsFromState() {
    const pg = getPageGridParams();
    const bindPair = (rngId, numId, val) => {
      const r = document.getElementById(rngId);
      const n = document.getElementById(numId);
      if (r) {
        r.value = String(val);
        syncNativeSlider(r);
      }
      if (n) n.value = String(val);
    };

    bindPair('rngStartX', 'numStartX', pg.startX);
    bindPair('rngStartY', 'numStartY', pg.startY);
    bindPair('rngColWidth', 'numColWidth', state.config.colWidth);
    bindPair('rngRowHeight', 'numRowHeight', state.config.rowHeight);
    bindPair('rngCellPad', 'numCellPad', state.config.cellPad);
    bindPair('rngRows', 'numRows', pg.rows);
    bindPair('rngCols', 'numCols', state.config.cols);

    renderColsCheckGrid();
    renderDigitSlotsUI();

    const mode = state.config.fillMode || 'random';
    const tabRandom = document.getElementById('tabFillRandom');
    const tabManual = document.getElementById('tabFillManual');
    const tabArticle = document.getElementById('tabFillArticle');
    if (tabRandom) tabRandom.classList.toggle('active', mode === 'random');
    if (tabManual) tabManual.classList.toggle('active', mode === 'manual');
    if (tabArticle) tabArticle.classList.toggle('active', mode === 'article');

    const pRandom = document.getElementById('panelFillRandom');
    const pManual = document.getElementById('panelFillManual');
    const pArticle = document.getElementById('panelFillArticle');
    if (pRandom) pRandom.hidden = mode !== 'random';
    if (pManual) pManual.hidden = mode !== 'manual';
    if (pArticle) pArticle.hidden = mode !== 'article';

    const layoutSel = document.getElementById('articleLayoutSelect');
    if (layoutSel && state.config.articleLayout) {
      layoutSel.value = state.config.articleLayout;
    }
    const artTxt = document.getElementById('articleTextarea');
    if (artTxt && state.config.articleText !== undefined && document.activeElement !== artTxt) {
      artTxt.value = state.config.articleText;
    }
    const inkSel = document.getElementById('inkColorSelect');
    if (inkSel) {
      inkSel.value = state.config.inkColor || '#161616';
    }

    for (const [secKey, map] of Object.entries(dualSliderUpdaters)) {
      for (const fn of Object.values(map)) fn();
    }
  }

  // =========================================================================
  // Core Handwriting Canvas Renderer (Digits + Chinese Characters + English Letters)
  // =========================================================================
  function getCellText(pageNum, rowIdx, colIdx1Based, rng) {
    if (state.config.fillMode === 'manual') {
      const globalRowIdx = (pageNum - 1) * state.config.rows + rowIdx;
      const rowArr =
        (state.config.manualData && state.config.manualData[globalRowIdx]) ||
        (state.config.manualData && state.config.manualData[rowIdx]);
      if (rowArr && rowArr[colIdx1Based - 1] !== undefined) {
        return String(rowArr[colIdx1Based - 1]).trim();
      }
      return generateRealisticVisionValue(rng);
    }
    if (state.config.visionPreset) {
      return generateRealisticVisionValue(rng);
    }
    let out = '';
    for (const slot of state.config.digitSlots) {
      if (slot.type === 'dot') {
        out += '.';
      } else {
        const pool = slot.digits && slot.digits.length ? slot.digits : [0];
        const pick = pool[Math.floor(rng() * pool.length)];
        out += String(pick);
      }
    }
    return out;
  }

  // Layout helper for 20x20 Chinese Composition Grid Paper ('grid' mode)
  function layoutArticleIntoGrid(text, rowsPerPage, colsPerRow) {
    const pagesGrid = [];
    let curPage = Array.from({ length: rowsPerPage }, () => Array(colsPerRow).fill(''));
    let r = 0;
    let c = 0;

    const pushNewPage = () => {
      pagesGrid.push(curPage);
      curPage = Array.from({ length: rowsPerPage }, () => Array(colsPerRow).fill(''));
      r = 0;
      c = 0;
    };

    const advanceCell = () => {
      c++;
      if (c >= colsPerRow) {
        c = 0;
        r++;
        if (r >= rowsPerPage) {
          pushNewPage();
        }
      }
    };

    const rawLines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const closingPunct = /^[，。！？；：、”’）》〉,.!?;:\])]/;

    for (let li = 0; li < rawLines.length; li++) {
      const line = rawLines[li];
      const chars = Array.from(line);
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === '　') {
          // Full-width space leaves 1 grid square empty
          curPage[r][c] = '';
          advanceCell();
          continue;
        }
        if (ch === ' ' || ch === '\t') {
          continue;
        }
        // Avoid starting a new line with closing punctuation (attach to previous cell)
        if (c === 0 && i > 0 && closingPunct.test(ch)) {
          if (r > 0) {
            curPage[r - 1][colsPerRow - 1] += ch;
            continue;
          } else if (pagesGrid.length > 0) {
            pagesGrid[pagesGrid.length - 1][rowsPerPage - 1][colsPerRow - 1] += ch;
            continue;
          }
        }
        curPage[r][c] = ch;
        advanceCell();
      }
      // Paragraph break: move to start of next row
      if (li < rawLines.length - 1 && c > 0) {
        c = 0;
        r++;
        if (r >= rowsPerPage) {
          pushNewPage();
        }
      }
    }
    pagesGrid.push(curPage);
    return pagesGrid;
  }

  // Layout helper for English Lined Paper & Blank Scratch Paper ('lines' mode)
  function layoutArticleIntoLines(text, maxLineWidthPx, rowHeightPx) {
    const rawParas = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const approxCharW = rowHeightPx * 0.35;
    const maxUnitsPerLine = Math.max(16, Math.floor((maxLineWidthPx - 18) / approxCharW));
    const wrappedLines = [];

    for (const para of rawParas) {
      if (!para.trim()) {
        wrappedLines.push('');
        continue;
      }
      // Tokenize into words (keeping spaces) or single CJK chars so English words never split mid-word
      const tokens = para.match(/[\u3000-\u9fff\uff00-\uffef]|[^\s\u3000-\u9fff\uff00-\uffef]+|\s+/g) || [];
      let curLine = '';
      let curUnits = 0;

      for (const tok of tokens) {
        const isCJK = /[\u3000-\u9fff\uff00-\uffef]/.test(tok);
        const tokUnits = isCJK ? tok.length * 1.65 : tok.length * 0.92;
        if (curUnits + tokUnits > maxUnitsPerLine && curLine.trim().length > 0) {
          wrappedLines.push(curLine.replace(/\s+$/, ''));
          curLine = tok.replace(/^\s+/, '');
          curUnits = isCJK ? curLine.length * 1.65 : curLine.length * 0.92;
        } else {
          curLine += tok;
          curUnits += tokUnits;
        }
      }
      if (curLine.length > 0) {
        wrappedLines.push(curLine);
      }
    }
    return wrappedLines;
  }

  function drawHandwrittenString(ctx, text, cellCenterX, cellCenterY, colWidthPx, rowHeightPx, rng, allowScratch, hitCtx) {
    const font = fontsRegistry[activeFontIndex];
    if (!font || !text) return;

    const cfg = state.config;
    ctx.save();

    // 1. Cell-level random offset (in mm/px scale), scale, and rotation
    const cellDx = randRange(rng, cfg.cellRandom.offsetX) * 2.2;
    const cellDy = randRange(rng, cfg.cellRandom.offsetY) * 2.2;
    const cellScale = Math.max(0.45, 1 + randRange(rng, cfg.cellRandom.scale));
    const cellRotDeg = randRange(rng, cfg.cellRandom.rotate);

    const originX = cellCenterX + cellDx;
    const originY = cellCenterY + cellDy;

    ctx.translate(originX, originY);
    ctx.rotate((cellRotDeg * Math.PI) / 180);
    ctx.scale(cellScale, cellScale);

    // Check if this cell triggers a realistic human scratch-out & rewrite (~1.4% probability when enabled)
    const doScratch = allowScratch && state.scratchEffect && rng() < 0.014 && text.length >= 2;
    if (doScratch) {
      ctx.save();
      ctx.translate(-colWidthPx * 0.22, 0);
      ctx.scale(0.84, 0.84);
      const wrongLast = String(Math.floor(1 + rng() * 9));
      const wrongText = text.slice(0, -1) + wrongLast;
      drawCharactersSequence(ctx, font, wrongText, rowHeightPx, rng, null);
      ctx.strokeStyle = cfg.inkColor || 'rgba(22, 22, 22, 0.88)';
      ctx.lineWidth = 1.9;
      ctx.lineCap = 'round';
      for (let s = 0; s < 3; s++) {
        ctx.beginPath();
        ctx.moveTo(-16 + s * 3, -8 + rng() * 5);
        ctx.lineTo(18 - s * 2, 9 - rng() * 4);
        ctx.stroke();
      }
      ctx.restore();
      ctx.translate(colWidthPx * 0.24, (rng() - 0.5) * 3);
      ctx.scale(0.9, 0.9);
    }

    drawCharactersSequence(
      ctx,
      font,
      text,
      rowHeightPx,
      rng,
      hitCtx ? { ...hitCtx, originX, originY, cellScale, maxWidth: (hitCtx.maxWidth || colWidthPx * 0.94) / cellScale } : null
    );
    ctx.restore();
  }

  function drawCharactersSequence(ctx, font, text, rowHeightPx, rng, hitCtx) {
    const cfg = state.config;
    const inkColor = cfg.inkColor || '#161616';
    const chars = Array.from(text);
    const isGridEssay = cfg.fillMode === 'article' && cfg.articleLayout === 'grid';
    const isLinesEssay = cfg.fillMode === 'article' && cfg.articleLayout === 'lines';
    const baseDigitHeight = isGridEssay
      ? Math.min(rowHeightPx * 0.44, cfg.colWidth * PX_PER_CM * 0.62)
      : isLinesEssay
      ? rowHeightPx * 0.47
      : rowHeightPx * 0.56;
    const naturalScale = baseDigitHeight / 26.0;

    const pickedItems = [];
    let totalAdvance = 0;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t' || ch === '　') {
        const spAdv = ch === '　' ? baseDigitHeight * 0.95 : baseDigitHeight * 0.42;
        pickedItems.push({
          charIdx: i,
          ch,
          isSpace: true,
          advance: spAdv
        });
        totalAdvance += spAdv;
        continue;
      }

      const variants = getGlyphVariantsForChar(font, ch, inkColor);
      if (!variants || variants.length === 0) continue;
      const g = variants[Math.floor(rng() * variants.length)];

      const isSynth = Boolean(g.isSynthesized);
      const isDot = !isSynth && ch === '.';
      let normScale = naturalScale;

      if (isSynth) {
        // Synthesized glyphs all share a unified 56px vertical em-frame
        const targetEmH = g.isCJK ? baseDigitHeight * 1.18 : baseDigitHeight * 1.12;
        normScale = targetEmH / 46.0;
      } else if (state.normalizeFontSize) {
        if (isDot) {
          normScale = (baseDigitHeight * 0.22) / Math.max(6, g.h);
        } else {
          const isCJKChar = /[\u3000-\u9fff\uff00-\uffef]/.test(ch);
          const isLowerX = /^[acemnorsuvwxz]$/.test(ch);
          const targetH = isCJKChar
            ? baseDigitHeight * 0.96
            : ch === '0' || isLowerX
            ? baseDigitHeight * 0.68
            : baseDigitHeight * 0.84;
          const fullNorm = targetH / Math.max(12, g.h);
          normScale = naturalScale * 0.22 + fullNorm * 0.78;
        }
      }

      const charScale = Math.max(0.4, 1 + randRange(rng, cfg.charShapeRandom.size));
      const dotExtraScale = isDot ? Math.max(0.4, 1 + randRange(rng, cfg.dotRandom.size)) : 1.0;
      const stretchX = Math.max(0.5, 1 + randRange(rng, cfg.charShapeRandom.stretchX));
      const stretchY = Math.max(0.5, 1 + randRange(rng, cfg.charShapeRandom.stretchY));

      const finalScaleX = normScale * charScale * dotExtraScale * stretchX;
      const finalScaleY = normScale * charScale * dotExtraScale * stretchY;
      const drawW = g.w * finalScaleX;
      const drawH = g.h * finalScaleY;

      const kerning = isDot ? 0 : randRange(rng, cfg.charPosRandom.spacing) * 0.45;
      const baseAdv = isSynth
        ? g.isCJK
          ? drawW * 0.94 + 1.0
          : drawW * 0.90 + 0.8
        : isDot
        ? Math.max(5.5, drawW * 0.85)
        : drawW * 0.88 + 1.2;
      const advance = Math.max(4, baseAdv + kerning);

      pickedItems.push({
        charIdx: i,
        ch,
        isDot,
        isSynth,
        g,
        drawW,
        drawH,
        advance,
        dx: randRange(rng, cfg.charPosRandom.offsetX) * 0.9,
        dy: randRange(rng, cfg.charPosRandom.offsetY) * 0.8 + (isDot ? randRange(rng, cfg.dotRandom.offsetY) * 1.1 : 0),
        rotDeg: isDot ? 0 : randRange(rng, cfg.charPosRandom.rotate),
        bold: randRange(rng, cfg.charShapeRandom.bold),
        gray: randRange(rng, cfg.charShapeRandom.gray)
      });
      totalAdvance += advance;
    }

    const alignLeft = hitCtx && hitCtx.alignLeft;

    // Auto-fit: shrink the whole string uniformly when it would overflow its cell / line width
    const maxWidthPx = hitCtx && hitCtx.maxWidth ? hitCtx.maxWidth : 0;
    if (maxWidthPx > 0 && totalAdvance > maxWidthPx) {
      const fit = Math.max(0.35, maxWidthPx / totalAdvance);
      for (const it of pickedItems) {
        it.advance *= fit;
        if (!it.isSpace) {
          it.drawW *= fit;
          it.drawH *= fit;
          it.dx *= fit;
          it.dy *= fit;
        }
      }
      totalAdvance *= fit;
    }

    let cursorX = alignLeft
      ? cfg.cellPad * PX_PER_CM * 0.5
      : -totalAdvance / 2 + cfg.cellPad * PX_PER_CM * 0.5;
    let cellMinX = Infinity, cellMinY = Infinity, cellMaxX = -Infinity, cellMaxY = -Infinity;

    for (const item of pickedItems) {
      if (item.isSpace) {
        cursorX += item.advance;
        continue;
      }

      ctx.save();
      const charKey = hitCtx ? `${hitCtx.page}-${hitCtx.r}-${hitCtx.c}-${item.charIdx}` : null;
      const userCharOff = (charKey && cfg.charOffsets && cfg.charOffsets[charKey]) || { dx: 0, dy: 0 };
      const scaleInv = hitCtx && hitCtx.cellScale ? 1 / hitCtx.cellScale : 1;

      const cx = cursorX + item.advance / 2 + item.dx + userCharOff.dx * scaleInv;
      const cy = (item.isDot ? baseDigitHeight * 0.26 + item.dy : item.dy) + userCharOff.dy * scaleInv;

      ctx.translate(cx, cy);
      if (item.rotDeg) {
        ctx.rotate((item.rotDeg * Math.PI) / 180);
      }

      const alphaFactor = Math.max(0.45, 1 - item.gray / 115);
      ctx.globalAlpha = alphaFactor;

      ctx.drawImage(item.g.img, -item.drawW / 2, -item.drawH / 2, item.drawW, item.drawH);

      if (item.bold > 0.08) {
        const offsetPx = Math.min(1.4, item.bold * 1.0);
        ctx.globalAlpha = alphaFactor * Math.min(0.7, item.bold * 0.6);
        ctx.drawImage(item.g.img, -item.drawW / 2 + offsetPx, -item.drawH / 2, item.drawW, item.drawH);
      }

      ctx.restore();

      if (hitCtx && hitCtx.collect) {
        const absCx = hitCtx.originX + cx * hitCtx.cellScale;
        const absCy = hitCtx.originY + cy * hitCtx.cellScale;
        const bw = Math.max(12, item.drawW * hitCtx.cellScale + 4);
        const bh = Math.max(14, item.drawH * hitCtx.cellScale + 4);
        const bx = absCx - bw / 2;
        const by = absCy - bh / 2;
        state.hitBoxes.chars.push({
          type: 'char',
          key: charKey,
          page: hitCtx.page,
          r: hitCtx.r,
          c: hitCtx.c,
          charIdx: item.charIdx,
          ch: item.ch,
          x: bx,
          y: by,
          w: bw,
          h: bh
        });
        if (bx < cellMinX) cellMinX = bx;
        if (by < cellMinY) cellMinY = by;
        if (bx + bw > cellMaxX) cellMaxX = bx + bw;
        if (by + bh > cellMaxY) cellMaxY = by + bh;
      }

      cursorX += item.advance;
    }

    if (hitCtx && hitCtx.collect && cellMinX < Infinity) {
      state.hitBoxes.cells.push({
        type: 'cell',
        key: `${hitCtx.page}-${hitCtx.r}-${hitCtx.c}`,
        page: hitCtx.page,
        r: hitCtx.r,
        c: hitCtx.c,
        text,
        x: cellMinX - 3,
        y: cellMinY - 3,
        w: cellMaxX - cellMinX + 6,
        h: cellMaxY - cellMinY + 6
      });
    }
  }

  function renderPageToCanvas(pageIndex1Based, targetCanvas, seedOffset = 0) {
    const pageObj = state.pages[pageIndex1Based - 1];
    if (!pageObj) return;

    targetCanvas.width = pageObj.width;
    targetCanvas.height = pageObj.height;
    const ctx = targetCanvas.getContext('2d');
    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);

    // 1. Draw underlying empty PDF page image
    if (pageObj.img) {
      ctx.drawImage(pageObj.img, 0, 0, pageObj.width, pageObj.height);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pageObj.width, pageObj.height);
    }

    // 2. Draw handwritten content (Table Cells OR Grid Essay OR Flowing Lined/Scratch Paper)
    const pg = getPageGridParams(pageIndex1Based);
    const startXPx = pg.startX * PX_PER_CM;
    const startYPx = pg.startY * PX_PER_CM;
    const colWidthPx = state.config.colWidth * PX_PER_CM;
    const rowHeightPx = state.config.rowHeight * PX_PER_CM;
    const rows = pg.rows;
    const cols = state.config.cols;

    const collectHits = seedOffset === 0 && pageIndex1Based === state.currentPage;
    if (collectHits) {
      state.hitBoxes = { chars: [], cells: [], rows: [] };
    }

    const isArticle = state.config.fillMode === 'article';
    const articleLayout = state.config.articleLayout || 'grid';
    let gridPagesData = null;
    let wrappedLinesData = null;

    if (isArticle) {
      const rawText = state.config.articleText || SAMPLE_ARTICLES.cn_essay;
      if (articleLayout === 'lines') {
        wrappedLinesData = layoutArticleIntoLines(rawText, cols * colWidthPx, rowHeightPx);
      } else {
        gridPagesData = layoutArticleIntoGrid(rawText, rows, cols);
      }
    }

    for (let r = 0; r < rows; r++) {
      const rowKey = `${pageIndex1Based}-${r}`;
      const rowOff = (state.config.rowOffsets && state.config.rowOffsets[rowKey]) || { dx: 0, dy: 0 };
      const baseCellCenterY = startYPx + (r + 0.5) * rowHeightPx + rowOff.dy;

      if (collectHits) {
        state.hitBoxes.rows.push({
          type: 'row',
          key: rowKey,
          page: pageIndex1Based,
          r,
          x: startXPx + rowOff.dx,
          y: baseCellCenterY - rowHeightPx * 0.48,
          w: cols * colWidthPx,
          h: rowHeightPx * 0.96
        });
      }

      // Flowing lined/scratch paper mode: 1 full-width line per row, left-aligned from startXPx
      if (isArticle && articleLayout === 'lines') {
        const globalLineIdx = (pageIndex1Based - 1) * rows + r;
        const lineText = wrappedLinesData && wrappedLinesData[globalLineIdx];
        if (!lineText) continue;

        const customColOffsetCm = (state.config.colOffsets && state.config.colOffsets['1']) || 0;
        const cellKey = `${pageIndex1Based}-${r}-1`;
        const cellOff = (state.config.cellOffsets && state.config.cellOffsets[cellKey]) || { dx: 0, dy: 0 };
        const lineStartX = startXPx + customColOffsetCm * PX_PER_CM + rowOff.dx + cellOff.dx;
        const lineCenterY = baseCellCenterY + cellOff.dy;

        const lineSeed =
          state.globalSeed +
          seedOffset * 100003 +
          pageIndex1Based * 10007 +
          r * 313 +
          37;
        const rng = mulberry32(lineSeed);
        drawHandwrittenString(ctx, lineText, lineStartX, lineCenterY, cols * colWidthPx, rowHeightPx, rng, false, {
          collect: collectHits,
          alignLeft: true,
          maxWidth: cols * colWidthPx * 0.97,
          page: pageIndex1Based,
          r,
          c: 1
        });
        continue;
      }

      // Standard Table Cell mode OR Chinese 20x20 Grid Essay mode
      for (let c = 1; c <= cols; c++) {
        if (!state.config.activeCols.includes(c)) continue;
        const customColOffsetCm = (state.config.colOffsets && state.config.colOffsets[String(c)]) || 0;
        const cellKey = `${pageIndex1Based}-${r}-${c}`;
        const cellOff = (state.config.cellOffsets && state.config.cellOffsets[cellKey]) || { dx: 0, dy: 0 };

        const colLeftPx = startXPx + (c - 1) * colWidthPx + customColOffsetCm * PX_PER_CM;
        const cellCenterX = colLeftPx + colWidthPx * 0.5 + rowOff.dx + cellOff.dx;
        const cellCenterY = baseCellCenterY + cellOff.dy;

        const cellSeed =
          state.globalSeed +
          seedOffset * 100003 +
          pageIndex1Based * 10007 +
          r * 313 +
          c * 37;
        const rng = mulberry32(cellSeed);

        let text = '';
        if (isArticle && gridPagesData) {
          const pageGrid = gridPagesData[pageIndex1Based - 1];
          text = (pageGrid && pageGrid[r] && pageGrid[r][c - 1]) || '';
        } else {
          text = getCellText(pageIndex1Based, r, c, rng);
        }
        if (!text) continue;

        const customMaxCm = state.config.colMaxWidths && state.config.colMaxWidths[String(c)];
        drawHandwrittenString(ctx, text, cellCenterX, cellCenterY, colWidthPx, rowHeightPx, rng, !isArticle, {
          collect: collectHits,
          maxWidth: customMaxCm ? customMaxCm * PX_PER_CM * 0.95 : colWidthPx * 0.94,
          page: pageIndex1Based,
          r,
          c
        });
      }
    }
  }

  function renderCurrentPage() {
    const canvas = document.getElementById('pdfRenderCanvas');
    if (!canvas || !state.pages.length) return;
    renderPageToCanvas(state.currentPage, canvas, 0);
    updateStageOverlayHandles();
    updateStageTransform();
  }

  // =========================================================================
  // Interactive Stage Overlay Handles (Origin, Blue Column Guides, Green Rulers)
  // =========================================================================
  function updateStageOverlayHandles() {
    const overlay = document.getElementById('stageOverlay');
    if (!overlay || !state.pages.length) return;
    overlay.classList.toggle('hidden', state.hideLegend);

    const pg = getPageGridParams(state.currentPage);
    const startXPx = pg.startX * PX_PER_CM;
    const startYPx = pg.startY * PX_PER_CM;
    const colWidthPx = state.config.colWidth * PX_PER_CM;
    const rowHeightPx = state.config.rowHeight * PX_PER_CM;

    // 1. Red Origin Handle
    const originHandle = document.getElementById('originHandle');
    originHandle.style.left = `${startXPx}px`;
    originHandle.style.top = `${startYPx}px`;

    // 2. Blue Column Guides for active columns
    const guidesContainer = document.getElementById('colGuidesContainer');
    guidesContainer.innerHTML = '';
    const tableHeightPx = pg.rows * rowHeightPx;

    for (let c = 1; c <= state.config.cols; c++) {
      if (!state.config.activeCols.includes(c)) continue;
      const customOffsetCm = (state.config.colOffsets && state.config.colOffsets[String(c)]) || 0;
      const colX = startXPx + (c - 1) * colWidthPx + customOffsetCm * PX_PER_CM;

      const line = document.createElement('div');
      line.className = 'col-guide-line';
      line.style.left = `${colX}px`;
      line.style.top = `${startYPx - 24}px`;
      line.style.height = `${tableHeightPx + 24}px`;

      const badge = document.createElement('div');
      badge.className = 'col-guide-badge';
      badge.textContent = '点击拖动';
      line.appendChild(badge);

      // Dragging individual blue column guide adjusts ONLY that column's offset (never all columns together)
      line.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        line.setPointerCapture(e.pointerId);
        const startClientX = e.clientX;
        const scale = state.zoom / 100;
        const initCustom = (state.config.colOffsets && state.config.colOffsets[String(c)]) || 0;

        const onMove = (ev) => {
          const dxCm = (ev.clientX - startClientX) / (PX_PER_CM * scale);
          if (!state.config.colOffsets) state.config.colOffsets = {};
          state.config.colOffsets[String(c)] = Number((initCustom + dxCm).toFixed(2));
          syncAllControlsFromState();
          renderCurrentPage();
        };
        const onUp = () => {
          line.removeEventListener('pointermove', onMove);
          line.removeEventListener('pointerup', onUp);
          pushHistory();
        };
        line.addEventListener('pointermove', onMove);
        line.addEventListener('pointerup', onUp);
      });

      guidesContainer.appendChild(line);
    }

    // 2b. Per-Row Drag Handles on the left side of each row
    const rowGuidesContainer = document.getElementById('rowGuidesContainer');
    if (rowGuidesContainer) {
      rowGuidesContainer.innerHTML = '';
      const tableWidthPx = state.config.cols * colWidthPx;
      for (let r = 1; r <= pg.rows; r++) {
        const rowKey = `${state.currentPage}-${r}`;
        const rowOff = (state.config.rowOffsets && state.config.rowOffsets[rowKey]) || { dx: 0, dy: 0 };
        const rowDxPx = (rowOff.dx || 0) * PX_PER_CM;
        const rowDyPx = (rowOff.dy || 0) * PX_PER_CM;
        const baseRowCenterY = startYPx + (r - 0.5) * rowHeightPx + rowDyPx;

        const rowHandle = document.createElement('div');
        rowHandle.className = 'row-guide-handle';
        rowHandle.style.left = `${Math.max(4, startXPx - 44 + rowDxPx)}px`;
        rowHandle.style.top = `${baseRowCenterY - 10}px`;

        const rBadge = document.createElement('div');
        rBadge.className = 'row-guide-badge';
        rBadge.textContent = `↕ 行${r}`;
        rowHandle.appendChild(rBadge);

        const rLine = document.createElement('div');
        rLine.className = 'row-guide-line';
        rLine.style.width = `${tableWidthPx + 44}px`;
        rowHandle.appendChild(rLine);

        rowHandle.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          rowHandle.setPointerCapture(e.pointerId);
          rowHandle.classList.add('dragging');
          const startClientX = e.clientX;
          const startClientY = e.clientY;
          const scale = state.zoom / 100;
          const curOff = (state.config.rowOffsets && state.config.rowOffsets[rowKey]) || { dx: 0, dy: 0 };
          const initDx = curOff.dx || 0;
          const initDy = curOff.dy || 0;

          const onMove = (ev) => {
            const dxCm = (ev.clientX - startClientX) / (PX_PER_CM * scale);
            const dyCm = (ev.clientY - startClientY) / (PX_PER_CM * scale);
            if (!state.config.rowOffsets) state.config.rowOffsets = {};
            state.config.rowOffsets[rowKey] = {
              dx: Number((initDx + dxCm).toFixed(3)),
              dy: Number((initDy + dyCm).toFixed(3))
            };
            renderCurrentPage();
          };
          const onUp = () => {
            rowHandle.classList.remove('dragging');
            rowHandle.removeEventListener('pointermove', onMove);
            rowHandle.removeEventListener('pointerup', onUp);
            pushHistory();
          };
          rowHandle.addEventListener('pointermove', onMove);
          rowHandle.addEventListener('pointerup', onUp);
        });

        rowGuidesContainer.appendChild(rowHandle);
      }
    }

    // 3. Green Column Width Ruler & Row Height Ruler
    const colRuler = document.getElementById('colWidthRuler');
    const colRulerLine = document.getElementById('colWidthRulerLine');
    const colRulerTag = document.getElementById('colWidthRulerTag');
    colRuler.hidden = !state.showColRuler;
    colRuler.style.left = `${startXPx}px`;
    colRuler.style.top = `${startYPx + rowHeightPx * 2}px`;
    colRulerLine.style.width = `${colWidthPx}px`;
    colRulerTag.textContent = `列宽 ${state.config.colWidth.toFixed(2)} cm`;

    const rowRuler = document.getElementById('rowHeightRuler');
    const rowRulerLine = document.getElementById('rowHeightRulerLine');
    const rowRulerTag = document.getElementById('rowHeightRulerTag');
    rowRuler.hidden = !state.showRowRuler;
    rowRuler.style.left = `${startXPx + colWidthPx * 0.5}px`;
    rowRuler.style.top = `${startYPx + rowHeightPx * 3}px`;
    rowRulerLine.style.height = `${rowHeightPx}px`;
    rowRulerTag.textContent = `行高 ${state.config.rowHeight.toFixed(2)} cm`;
  }

  function updateStageTransform() {
    const stage = document.getElementById('canvasStage');
    if (!stage) return;
    const scale = state.zoom / 100;
    stage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${scale})`;
    const zoomLbl = document.getElementById('zoomLabel');
    const zoomSlider = document.getElementById('zoomSlider');
    if (zoomLbl) zoomLbl.textContent = `${Math.round(state.zoom)}%`;
    if (zoomSlider) {
      zoomSlider.value = String(Math.round(state.zoom));
      syncNativeSlider(zoomSlider);
    }
  }

  function fitPageToViewport() {
    const viewport = document.getElementById('canvasViewport');
    const pageObj = state.pages[state.currentPage - 1];
    if (!viewport || !pageObj) return;
    const isLandscape = pageObj.width > pageObj.height;
    state.zoom = isLandscape ? 84 : 96;
    state.panX = 16;
    state.panY = 12;
    updateStageTransform();
  }

  // =========================================================================
  // Loading Examples, Custom PDFs, and Project JSON
  // =========================================================================
  async function loadExample(exampleKey) {
    const ex = window.HANDWRITE_EXAMPLES && window.HANDWRITE_EXAMPLES[exampleKey];
    if (!ex) return;

    const loadedPages = [];
    for (const p of ex.pages) {
      const img = await new Promise((resolve) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.src = p.src;
      });
      loadedPages.push({
        width: p.width,
        height: p.height,
        widthCm: p.widthCm,
        heightCm: p.heightCm,
        img
      });
    }

    state.pages = loadedPages;
    state.currentPage = 1;
    state.projectPath = ex.path;
    state.config = deepClone(ex.config);
    state.config.colOffsets = ex.config.colOffsets ? deepClone(ex.config.colOffsets) : {};
    state.config.rowOffsets = {};
    state.config.cellOffsets = {};
    state.config.charOffsets = {};
    if (!state.config.inkColor) state.config.inkColor = '#161616';

    if (ex.config.fillMode === 'manual') {
      populateManualTable(ex.config.manualPreset || (ex.config.visionPreset ? 'vision' : 'temp'));
    } else {
      populateManualTable('temp');
    }

    const quickSel = document.getElementById('quickExampleSelect');
    if (quickSel) quickSel.value = exampleKey;

    showWorkspaceView();
    refreshPageNavUI();
    syncAllControlsFromState();
    historyStack.length = 0;
    historyIndex = -1;
    pushHistory();
    requestAnimationFrame(() => {
      fitPageToViewport();
      renderCurrentPage();
    });
  }

  async function loadUserPdfFile(file) {
    if (!file || !window.pdfjsLib) return;
    const buf = await file.arrayBuffer();
    const pdfDoc = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const loadedPages = [];

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      // Standard PDF point is 1/72 inch; 1 inch = 2.54 cm -> scale to PX_PER_CM (60 px/cm)
      const scale = (PX_PER_CM * 2.54) / 72;
      const vp = page.getViewport({ scale });
      const offCanvas = document.createElement('canvas');
      offCanvas.width = Math.round(vp.width);
      offCanvas.height = Math.round(vp.height);
      const offCtx = offCanvas.getContext('2d');
      await page.render({ canvasContext: offCtx, viewport: vp }).promise;

      const dataUrl = offCanvas.toDataURL('image/png');
      const img = await new Promise((resolve) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.src = dataUrl;
      });
      loadedPages.push({
        width: offCanvas.width,
        height: offCanvas.height,
        widthCm: Number((offCanvas.width / PX_PER_CM).toFixed(2)),
        heightCm: Number((offCanvas.height / PX_PER_CM).toFixed(2)),
        img
      });
    }

    state.pages = loadedPages;
    state.currentPage = 1;
    state.projectPath = file.name;
    showWorkspaceView();
    refreshPageNavUI();
    syncAllControlsFromState();
    pushHistory();
    requestAnimationFrame(() => {
      fitPageToViewport();
      renderCurrentPage();
    });
  }

  function refreshPageNavUI() {
    const sel = document.getElementById('pageSelect');
    const totalTxt = document.getElementById('totalPagesText');
    const prevBtn = document.getElementById('btnPrevPage');
    const nextBtn = document.getElementById('btnNextPage');
    const statusTxt = document.getElementById('statusBarText');

    const total = state.pages.length || 1;
    sel.innerHTML = '';
    for (let i = 1; i <= total; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = String(i);
      sel.appendChild(opt);
    }
    sel.value = String(state.currentPage);
    totalTxt.textContent = `/ ${total} 页`;
    prevBtn.disabled = state.currentPage <= 1;
    nextBtn.disabled = state.currentPage >= total;
    if (statusTxt) {
      statusTxt.textContent = `项目已加载: ${state.projectPath}`;
    }
  }

  // =========================================================================
  // View Switching (Home / Workspace / Font Maker)
  // =========================================================================
  function showHomeView() {
    document.getElementById('homeView').hidden = false;
    document.getElementById('workspaceView').hidden = true;
    document.getElementById('fontMakerView').hidden = true;
    document.getElementById('windowTitlebar').classList.remove('dark');
    document.getElementById('windowTitleText').textContent = '手写体生成器 (汉字 · 英语 · 数字)';
    document.getElementById('tabMainApp').classList.add('active');
    document.getElementById('tabFontMaker').classList.remove('active');
  }

  function showWorkspaceView() {
    document.getElementById('homeView').hidden = true;
    document.getElementById('workspaceView').hidden = false;
    document.getElementById('fontMakerView').hidden = true;
    document.getElementById('windowTitlebar').classList.remove('dark');
    document.getElementById('windowTitleText').textContent = '手写体生成器 (汉字 · 英语 · 数字)';
    document.getElementById('tabMainApp').classList.add('active');
    document.getElementById('tabFontMaker').classList.remove('active');
  }

  function showFontMakerView() {
    document.getElementById('homeView').hidden = true;
    document.getElementById('workspaceView').hidden = true;
    document.getElementById('fontMakerView').hidden = false;
    document.getElementById('windowTitlebar').classList.add('dark');
    document.getElementById('windowTitleText').textContent = '字体制作器';
    document.getElementById('tabMainApp').classList.remove('active');
    document.getElementById('tabFontMaker').classList.add('active');
  }

  // =========================================================================
  // Manual Input Spreadsheet Modal (Screenshot 8)
  // =========================================================================
  function openManualInputModal() {
    const dialog = document.getElementById('dialogManualInput');
    const tableEl = document.getElementById('manualGridTable');
    const pg = getPageGridParams();
    const rows = pg.rows;
    const cols = state.config.cols;

    if (!state.config.manualData || state.config.manualData.length < rows) {
      populateManualTable(state.config.visionPreset ? 'vision' : 'temp');
    }

    tableEl.innerHTML = '';
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    const thCorner = document.createElement('th');
    thCorner.textContent = '';
    trHead.appendChild(thCorner);

    for (let c = 1; c <= cols; c++) {
      const th = document.createElement('th');
      const isShown = state.config.activeCols.includes(c);
      th.className = isShown ? '' : 'unshown';
      th.textContent = isShown ? `第${c}列` : `第${c}列 (未显示)`;
      trHead.appendChild(th);
    }
    thead.appendChild(trHead);
    tableEl.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let r = 0; r < rows; r++) {
      const tr = document.createElement('tr');
      const tdRow = document.createElement('td');
      tdRow.className = 'row-hdr';
      tdRow.textContent = `第${r + 1}行`;
      tr.appendChild(tdRow);

      if (!state.config.manualData[r]) state.config.manualData[r] = [];
      for (let c = 1; c <= cols; c++) {
        const isShown = state.config.activeCols.includes(c);
        const td = document.createElement('td');
        td.className = isShown ? '' : 'unshown';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'manual-cell-input';
        inp.value = state.config.manualData[r][c - 1] ?? '5.0';
        inp.dataset.r = String(r);
        inp.dataset.c = String(c - 1);
        td.appendChild(inp);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tableEl.appendChild(tbody);
    if (!dialog.open) dialog.showModal();
  }

  function saveManualModalChanges() {
    const tableEl = document.getElementById('manualGridTable');
    tableEl.querySelectorAll('.manual-cell-input').forEach((inp) => {
      const r = Number(inp.dataset.r);
      const c = Number(inp.dataset.c);
      if (!state.config.manualData[r]) state.config.manualData[r] = [];
      state.config.manualData[r][c] = inp.value.trim();
    });
    state.config.fillMode = 'manual';
    syncAllControlsFromState();
    pushHistory();
    renderCurrentPage();
    document.getElementById('dialogManualInput').close();
  }

  // =========================================================================
  // Multi-Page PDF Export with Live Progress Bar (Video 0:47-0:49)
  // =========================================================================
  function openExportModal() {
    const dialog = document.getElementById('dialogExportPdf');
    const copiesInp = document.getElementById('exportCopiesInput');
    const hint = document.getElementById('exportTotalPagesHint');
    document.getElementById('exportConfigSection').hidden = false;
    document.getElementById('exportProgressSection').hidden = true;

    const updateHint = () => {
      const copies = Math.max(1, Number(copiesInp.value) || 1);
      const total = copies * (state.pages.length || 1);
      hint.textContent = `共导出 ${total} 页 PDF`;
    };
    copiesInp.oninput = updateHint;
    updateHint();
    dialog.showModal();
  }

  async function runPdfExport() {
    const copies = Math.max(1, Math.min(50, Number(document.getElementById('exportCopiesInput').value) || 1));
    const printAfter = document.getElementById('chkExportPrintAfter').checked;
    const pageCountPerCopy = state.pages.length || 1;
    const totalExportPages = copies * pageCountPerCopy;

    document.getElementById('exportConfigSection').hidden = true;
    const progSec = document.getElementById('exportProgressSection');
    const progLbl = document.getElementById('exportProgressLabel');
    const progBar = document.getElementById('exportProgressBar');
    const progPct = document.getElementById('exportProgressPct');
    progSec.hidden = false;

    const { jsPDF } = window.jspdf;
    const firstPage = state.pages[0];
    const isLandscape = firstPage.width > firstPage.height;
    const doc = new jsPDF({
      orientation: isLandscape ? 'landscape' : 'portrait',
      unit: 'cm',
      format: [firstPage.widthCm, firstPage.heightCm]
    });

    const offCanvas = document.createElement('canvas');
    let generated = 0;

    for (let copyIdx = 0; copyIdx < copies; copyIdx++) {
      for (let pIdx = 1; pIdx <= pageCountPerCopy; pIdx++) {
        generated++;
        const pct = Math.round((generated / totalExportPages) * 100);
        progLbl.textContent = `正在生成 PDF... ${generated}/${totalExportPages} 页`;
        progBar.value = pct;
        progPct.textContent = `${pct}%`;

        // Allow UI to repaint progress bar
        await new Promise((r) => setTimeout(r, 45));

        const pObj = state.pages[pIdx - 1];
        if (generated > 1) {
          const orient = pObj.width > pObj.height ? 'landscape' : 'portrait';
          doc.addPage([pObj.widthCm, pObj.heightCm], orient);
        }

        renderPageToCanvas(pIdx, offCanvas, copyIdx);
        const imgData = offCanvas.toDataURL('image/jpeg', 0.94);
        doc.addImage(imgData, 'JPEG', 0, 0, pObj.widthCm, pObj.heightCm);
      }
    }

    const baseName = (state.projectPath || '手写数字表格').split(/[\\/]/).pop().replace(/\.pdf$/i, '');
    doc.save(`${baseName}_手写生成_${totalExportPages}页.pdf`);

    document.getElementById('dialogExportPdf').close();
    if (printAfter) {
      const pdfBlobUrl = doc.output('bloburl');
      window.open(pdfBlobUrl, '_blank');
    }
  }

  // =========================================================================
  // MODULE A: 字体制作器 (Font Maker - 支持汉字 / 英语字母 / 数字 3步实拍提取 + 笔迹特征迁移)
  // =========================================================================
  const CATEGORY_COLORS = {
    '1': '#d97706',
    '2': '#b4831e',
    '3': '#4d8b31',
    '4': '#1f9d55',
    '5': '#15803d',
    '6': '#2563eb',
    '7': '#4f46e5',
    '8': '#7c3aed',
    '9': '#9333ea',
    '0': '#dc2626',
    '.': '#db2777'
  };
  const PALETTE_COLORS = [
    '#d97706', '#b4831e', '#4d8b31', '#1f9d55', '#15803d',
    '#0d9488', '#0284c7', '#2563eb', '#4f46e5', '#7c3aed',
    '#9333ea', '#c026d3', '#db2777', '#e11d48', '#dc2626', '#ea580c'
  ];

  const FM_MODE_PRESETS = {
    digits: '1234567890.',
    english: 'ABCDEFGHabcdefgh+-=.',
    chinese: '正常合格优秀良好已查出席请假实验李明王华张伟AB+'
  };

  const fmState = {
    mode: 'digits', // 'digits' | 'english' | 'chinese'
    step: 0, // 0=welcome, 1=threshold, 2=boxes, 3=label
    sourceImg: null,
    grayArr: null,
    bgArr: null,
    alphaArr: null,
    width: 0,
    height: 0,
    tolerance: 29,
    zoom: 100,
    panX: 40,
    panY: 20,
    boxes: [], // [{ x, y, w, h, label: null | string }]
    history: [],
    historyIdx: -1,
    activeLabelCat: '1',
    selectedBoxIdx: -1,
    contextBoxIdx: -1,
    marquee: null // { x0, y0, x1, y1 }
  };

  function fmGetCategoryOrder() {
    const inp = document.getElementById('fmCharsetInput');
    const raw = (inp && inp.value) ? inp.value : FM_MODE_PRESETS[fmState.mode] || FM_MODE_PRESETS.digits;
    const seen = new Set();
    const out = [];
    for (const ch of Array.from(raw)) {
      if (ch.trim() === '') continue;
      if (!seen.has(ch)) {
        seen.add(ch);
        out.push(ch);
      }
    }
    return out.length > 0 ? out : ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '.'];
  }

  function fmGetCategoryColor(cat) {
    if (!cat) return '#0ea5e9';
    if (CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
    const code = cat.codePointAt(0) || 0;
    return PALETTE_COLORS[code % PALETTE_COLORS.length];
  }

  // Synthesize a realistic photographed paper sheet for English / Chinese sample experience
  function fmGenerateSampleHandwritingPhoto(mode) {
    if (mode === 'digits' && window.DEFAULT_HANDWRITE_DATA && window.DEFAULT_HANDWRITE_DATA.sampleSheet) {
      return window.DEFAULT_HANDWRITE_DATA.sampleSheet;
    }
    const chars = fmGetCategoryOrder().slice(0, 30);
    const isRowMode = chars.length <= 12;
    const w = 640;
    const h = 480;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');

    // Realistic warm paper background with slight camera lighting gradient & grain
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#f4f1ea');
    grad.addColorStop(0.55, '#ebe6dc');
    grad.addColorStop(1, '#ded8cc');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const rng = mulberry32(mode === 'english' ? 202601 : 202602);
    ctx.fillStyle = 'rgba(120, 110, 95, 0.035)';
    for (let i = 0; i < 900; i++) {
      ctx.fillRect(rng() * w, rng() * h, 1.5, 1.5);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (isRowMode) {
      // Each character written 6 times across its own row
      const rowH = Math.min(38, Math.floor((h - 48) / Math.max(1, chars.length)));
      chars.forEach((ch, rIdx) => {
        const cy = 28 + rIdx * rowH + rowH * 0.5;
        for (let v = 0; v < 6; v++) {
          const cx = 75 + v * 88 + (rng() - 0.5) * 6;
          const vy = cy + (rng() - 0.5) * 3;
          ctx.save();
          ctx.translate(cx, vy);
          ctx.rotate((rng() - 0.5) * 0.08);
          ctx.transform(0.95 + rng() * 0.1, 0, -0.04 + (rng() - 0.5) * 0.04, 0.95 + rng() * 0.1, 0, 0);
          ctx.font = '30px "HanziPen SC", "Xingkai SC", "Bradley Hand", "Kaiti SC", cursive';
          ctx.fillStyle = `rgba(24, 26, 30, ${0.84 + rng() * 0.14})`;
          ctx.fillText(ch, 0, 0);
          ctx.restore();
        }
      });
    } else {
      // Grid layout: each character written 2 times (2 variants per character) in clean rows of 10
      const items = [];
      chars.forEach((ch) => {
        items.push(ch, ch);
      });
      const cols = 10;
      const rows = Math.ceil(items.length / cols);
      const cellW = (w - 80) / cols;
      const cellH = Math.min(58, (h - 56) / Math.max(1, rows));

      items.forEach((ch, idx) => {
        const r = Math.floor(idx / cols);
        const col = idx % cols;
        const cx = 40 + col * cellW + cellW * 0.5 + (rng() - 0.5) * 4;
        const cy = 32 + r * cellH + cellH * 0.5 + (rng() - 0.5) * 3;
        const isCJK = /[\u3000-\u9fff\uff00-\uffef]/.test(ch);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((rng() - 0.5) * 0.07);
        ctx.transform(0.94 + rng() * 0.12, 0, -0.04 + (rng() - 0.5) * 0.05, 0.94 + rng() * 0.12, 0, 0);
        ctx.font = `${isCJK ? 31 : 32}px "HanziPen SC", "Hannotate SC", "Bradley Hand", "Kaiti SC", cursive`;
        ctx.fillStyle = `rgba(22, 24, 28, ${0.86 + rng() * 0.12})`;
        ctx.fillText(ch, 0, 0);
        ctx.restore();
      });
    }

    return c.toDataURL('image/jpeg', 0.92);
  }

  function fmSwitchPresetMode(mode) {
    fmState.mode = mode;
    document.querySelectorAll('[data-fm-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.fmMode === mode);
    });
    const inp = document.getElementById('fmCharsetInput');
    if (inp && FM_MODE_PRESETS[mode]) {
      inp.value = FM_MODE_PRESETS[mode];
    }
    const cats = fmGetCategoryOrder();
    fmState.activeLabelCat = cats[0] || '1';
    const sampleImg = document.getElementById('fmSamplePhotoImg');
    if (sampleImg) {
      sampleImg.src = fmGenerateSampleHandwritingPhoto(mode);
    }
  }

  function fmExtractCurrentDocChars() {
    const cfg = state.config;
    let poolStr = '';
    if (cfg.fillMode === 'article' && cfg.articleText) {
      poolStr = cfg.articleText;
    } else if (cfg.fillMode === 'manual' && Array.isArray(cfg.manualData)) {
      poolStr = cfg.manualData.map((r) => (Array.isArray(r) ? r.join('') : '')).join('');
    } else if (Array.isArray(cfg.slots)) {
      poolStr = cfg.slots.map((s) => (s.digits ? s.digits.join('') : '')).join('');
    }
    const seen = new Set();
    const extracted = [];
    for (const ch of Array.from(poolStr)) {
      if (ch.trim() === '') continue;
      if (!seen.has(ch)) {
        seen.add(ch);
        extracted.push(ch);
        if (extracted.length >= 45) break;
      }
    }
    if (extracted.length === 0) {
      showNoticeDialog('提取字表', '当前文档暂无可提取字符，已为您填入常用汉字与英文字符集。');
      return;
    }
    const inp = document.getElementById('fmCharsetInput');
    if (inp) inp.value = extracted.join('');
    fmState.mode = 'chinese';
    document.querySelectorAll('[data-fm-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.fmMode === 'chinese');
    });
    const sampleImg = document.getElementById('fmSamplePhotoImg');
    if (sampleImg) sampleImg.src = fmGenerateSampleHandwritingPhoto('chinese');
    showNoticeDialog('提取当前文档字表成功', `已从当前文档提取 ${extracted.length} 个不重复字符，您可下载书写字帖或直接点击绿色按钮体验！`);
  }

  function fmDownloadTemplatePdf() {
    if (!window.jspdf) return;
    const chars = fmGetCategoryOrder();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'cm', format: 'a4' });

    const off = document.createElement('canvas');
    off.width = 1240;
    off.height = 1754;
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, off.width, off.height);

    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 34px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('手写体生成器 · 专属汉字/英语/数字采集字帖', off.width / 2, 78);

    ctx.fillStyle = '#4b5563';
    ctx.font = '20px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('请在每个方格中央用黑笔书写 2 遍对应字符（勿压外框线），写完后拍照上传至「字体制作器」', off.width / 2, 118);

    const cols = 8;
    const cellS = 128;
    const startX = (off.width - cols * cellS) / 2;
    const startY = 156;

    // 2 boxes per character so user gets 2 natural variants per character
    const items = [];
    chars.forEach((ch) => items.push(ch, ch));

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    items.slice(0, 80).forEach((ch, idx) => {
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const x = startX + c * cellS;
      const y = startY + r * cellS;

      // Light green/blue outer border (easy to filter out or leave spacing)
      ctx.strokeStyle = '#d1d5db';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 8, y + 8, cellS - 16, cellS - 16);

      // Small corner reference label
      ctx.fillStyle = '#9ca3af';
      ctx.font = '16px sans-serif';
      ctx.fillText(ch, x + 22, y + 24);

      // Very faint watermark in center for tracing
      ctx.fillStyle = 'rgba(209, 213, 219, 0.38)';
      ctx.font = '64px "Kaiti SC", "STKaiti", serif';
      ctx.fillText(ch, x + cellS / 2, y + cellS / 2 + 4);
    });

    doc.addImage(off.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 21.0, 29.7);
    doc.save('手写字库采集字帖模板.pdf');
  }

  function showNoticeDialog(title, msg) {
    const dlg = document.getElementById('dialogNotice');
    document.getElementById('dialogNoticeTitle').textContent = title;
    document.getElementById('dialogNoticeMessage').textContent = msg;
    dlg.showModal();
  }

  function fmPushHistory() {
    const snap = deepClone(fmState.boxes);
    fmState.history.splice(fmState.historyIdx + 1);
    fmState.history.push(snap);
    fmState.historyIdx = fmState.history.length - 1;
    document.getElementById('btnFmUndo').disabled = fmState.historyIdx <= 0;
    document.getElementById('btnFmRedo').disabled = fmState.historyIdx >= fmState.history.length - 1;
  }

  // Fast Integral-Image Box Blur for Local Adaptive Background Estimation
  function computeBoxBlurGray(gray, w, h, radius) {
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(h - 1, y + radius);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(w - 1, x + radius);
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum =
          integral[(y1 + 1) * (w + 1) + (x1 + 1)] -
          integral[y0 * (w + 1) + (x1 + 1)] -
          integral[(y1 + 1) * (w + 1) + x0] +
          integral[y0 * (w + 1) + x0];
        out[y * w + x] = sum / count;
      }
    }
    return out;
  }

  function fmLoadImageAndStartStep1(img) {
    fmState.sourceImg = img;
    fmState.width = img.width;
    fmState.height = img.height;

    const off = document.createElement('canvas');
    off.width = img.width;
    off.height = img.height;
    const octx = off.getContext('2d');
    octx.drawImage(img, 0, 0);
    const imgData = octx.getImageData(0, 0, img.width, img.height).data;

    const n = img.width * img.height;
    const gray = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      gray[i] = 0.299 * imgData[i * 4] + 0.587 * imgData[i * 4 + 1] + 0.114 * imgData[i * 4 + 2];
    }
    fmState.grayArr = gray;
    fmState.bgArr = computeBoxBlurGray(gray, img.width, img.height, 22);
    fmState.alphaArr = new Uint8Array(n);
    fmState.boxes = [];
    fmState.history = [];
    fmState.historyIdx = -1;

    fmSetStep(1);
    fmFitCanvas();
    fmRenderCanvas();
  }

  // Merge multi-part Chinese radicals (left-right, top-bottom) or 'i'/'j' dots into unified character boxes
  function fmMergeNearbyRadicals(rawBoxes, maxCharW = 46, maxCharH = 48) {
    const boxes = rawBoxes.map((b) => ({ ...b }));
    let mergedAny = true;
    while (mergedAny) {
      mergedAny = false;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          const nx0 = Math.min(a.x, b.x);
          const ny0 = Math.min(a.y, b.y);
          const nx1 = Math.max(a.x + a.w, b.x + b.w);
          const ny1 = Math.max(a.y + a.h, b.y + b.h);
          const nw = nx1 - nx0;
          const nh = ny1 - ny0;

          // Horizontal & vertical gap between boxes (negative means overlap)
          const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
          const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));

          if (nw <= maxCharW && nh <= maxCharH && gapX <= 11 && gapY <= 12) {
            boxes[i] = { x: nx0, y: ny0, w: nw, h: nh, label: a.label || b.label || null };
            boxes.splice(j, 1);
            mergedAny = true;
            break;
          }
        }
        if (mergedAny) break;
      }
    }
    return boxes;
  }

  function fmRunAutoBoxDetection() {
    const w = fmState.width;
    const h = fmState.height;
    const mask = new Uint8Array(w * h);
    for (let y = 6; y < h - 6; y++) {
      for (let x = 6; x < w - 6; x++) {
        if (fmState.alphaArr[y * w + x] > 45) mask[y * w + x] = 1;
      }
    }

    // Dilate by 2px (digits) or 3px (Chinese/English) so multi-stroke characters stay unified
    const dilateR = fmState.mode === 'digits' ? 2 : 3;
    const dilated = new Uint8Array(w * h);
    for (let y = dilateR; y < h - dilateR; y++) {
      for (let x = dilateR; x < w - dilateR; x++) {
        if (mask[y * w + x]) {
          for (let dy = -dilateR; dy <= dilateR; dy++) {
            for (let dx = -dilateR; dx <= dilateR; dx++) {
              dilated[(y + dy) * w + (x + dx)] = 1;
            }
          }
        }
      }
    }

    const visited = new Uint8Array(w * h);
    let detected = [];
    const qx = new Int32Array(w * h);
    const qy = new Int32Array(w * h);
    const maxExtent = fmState.mode === 'digits' ? 52 : 96;

    for (let y = 6; y < h - 6; y++) {
      for (let x = 6; x < w - 6; x++) {
        const idx = y * w + x;
        if (dilated[idx] && !visited[idx]) {
          let head = 0;
          let tail = 0;
          qx[tail] = x;
          qy[tail] = y;
          tail++;
          visited[idx] = 1;

          let minX = x, maxX = x, minY = y, maxY = y;
          let inkCount = 0;

          while (head < tail) {
            const cx = qx[head];
            const cy = qy[head];
            head++;
            if (mask[cy * w + cx]) {
              inkCount++;
              if (cx < minX) minX = cx;
              if (cx > maxX) maxX = cx;
              if (cy < minY) minY = cy;
              if (cy > maxY) maxY = cy;
            }
            const neighbors = [
              [cx - 1, cy],
              [cx + 1, cy],
              [cx, cy - 1],
              [cx, cy + 1]
            ];
            for (const [nx, ny] of neighbors) {
              if (nx >= 2 && nx < w - 2 && ny >= 2 && ny < h - 2) {
                const nIdx = ny * w + nx;
                if (dilated[nIdx] && !visited[nIdx]) {
                  visited[nIdx] = 1;
                  qx[tail] = nx;
                  qy[tail] = ny;
                  tail++;
                }
              }
            }
          }

          if (inkCount >= 4 && minX > 6 && minY > 6 && maxX < w - 6 && maxY < h - 6) {
            const bx = Math.max(0, minX - 3);
            const by = Math.max(0, minY - 3);
            const bw = Math.min(w - bx, maxX - minX + 7);
            const bh = Math.min(h - by, maxY - minY + 7);
            if (bw <= maxExtent && bh <= maxExtent) {
              detected.push({ x: bx, y: by, w: bw, h: bh, label: null });
            }
          }
        }
      }
    }

    if (fmState.mode !== 'digits') {
      detected = fmMergeNearbyRadicals(detected, 46, 48);
    }

    // Sort top-to-bottom, left-to-right
    detected.sort((a, b) => a.y - b.y);
    fmState.boxes = detected;
    fmState.history = [];
    fmState.historyIdx = -1;
    fmPushHistory();
  }

  function fmGroupBoxesIntoRows(boxes) {
    const sorted = [...boxes].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
    const rows = [];
    for (const b of sorted) {
      const yc = b.y + b.h / 2;
      if (!rows.length) {
        rows.push([b]);
      } else {
        const lastRow = rows[rows.length - 1];
        const avgY = lastRow.reduce((s, item) => s + item.y + item.h / 2, 0) / lastRow.length;
        if (Math.abs(yc - avgY) > 26) {
          rows.push([b]);
        } else {
          lastRow.push(b);
        }
      }
    }
    rows.forEach((r) => r.sort((a, b) => a.x - b.x));
    return rows;
  }

  function fmAutoLabelByRows() {
    if (!fmState.boxes.length) return;
    const cats = fmGetCategoryOrder();
    // If there are more target categories than rows (e.g. grid layout of 20 Chinese/English chars), use sequential grid labeling!
    const rows = fmGroupBoxesIntoRows(fmState.boxes);
    const validRows = rows.filter((r) => r.length >= 2);
    if (cats.length > validRows.length + 2) {
      fmAutoLabelSequential();
      return;
    }

    validRows.forEach((row, rIdx) => {
      if (rIdx >= cats.length) return;
      const cat = cats[rIdx];
      row.forEach((b) => {
        if (fmState.mode === 'digits' && (cat === '5' || cat === '6') && (b.h > 38 || b.w > 42)) {
          b.label = null;
        } else {
          b.label = cat;
        }
      });
    });
    fmPushHistory();
    fmRenderBottomCategories();
    fmRenderPreviewCanvas();
    fmRenderCanvas();
  }

  // Sequential grid auto-labeling: sorts top-to-bottom rows, left-to-right columns, and maps to character sequence
  function fmAutoLabelSequential() {
    if (!fmState.boxes.length) return;
    const cats = fmGetCategoryOrder();
    const rows = fmGroupBoxesIntoRows(fmState.boxes);
    const orderedBoxes = [];
    rows.forEach((r) => orderedBoxes.push(...r));

    // Detect if each character was written twice consecutively (e.g. 2 variants per char in grid)
    const repeatsPerChar = Math.max(1, Math.round(orderedBoxes.length / Math.max(1, cats.length)));
    orderedBoxes.forEach((b, idx) => {
      const catIdx = Math.floor(idx / repeatsPerChar) % cats.length;
      b.label = cats[catIdx];
    });

    fmPushHistory();
    fmRenderBottomCategories();
    fmRenderPreviewCanvas();
    fmRenderCanvas();
  }

  function fmSetStep(step) {
    fmState.step = step;
    const welcome = document.getElementById('fmWelcomeScreen');
    const stepsWrap = document.getElementById('fmStepsContainer');
    if (step === 0) {
      welcome.hidden = false;
      stepsWrap.hidden = true;
      return;
    }
    welcome.hidden = true;
    stepsWrap.hidden = false;

    const titleEl = document.getElementById('fmStepTitle');
    const btnReup = document.getElementById('btnFmReupload');
    const btnPrev = document.getElementById('btnFmPrevStep');
    const btnUndo = document.getElementById('btnFmUndo');
    const btnRedo = document.getElementById('btnFmRedo');
    const btnMerge = document.getElementById('btnFmMergeRadicals');
    const tolBar = document.getElementById('fmToleranceBar');
    const prevWrap = document.getElementById('fmStep3PreviewWrap');
    const btnNext = document.getElementById('btnFmNextStep');
    const btnExport = document.getElementById('btnFmExportFont');
    const botBar = document.getElementById('fmBottomBar');
    const hud = document.getElementById('fmHudTip');
    const statusTxt = document.getElementById('fmStatusBarText');

    if (step === 1) {
      titleEl.textContent = '第一步：抠图';
      btnReup.hidden = false;
      btnPrev.hidden = true;
      btnUndo.hidden = true;
      btnRedo.hidden = true;
      if (btnMerge) btnMerge.hidden = true;
      tolBar.hidden = false;
      prevWrap.hidden = true;
      btnNext.hidden = false;
      btnExport.hidden = true;
      botBar.hidden = true;
      hud.innerHTML = '<div>滚轮：放大缩小检查</div><div>鼠标中键：拖动</div>';
      statusTxt.textContent = '第一步：调节容差滑块，使背景变为透明棋盘格、手写汉字/英语/数字笔画清晰';
    } else if (step === 2) {
      titleEl.textContent = '第二步：框字';
      btnReup.hidden = true;
      btnPrev.hidden = false;
      btnUndo.hidden = false;
      btnRedo.hidden = false;
      if (btnMerge) btnMerge.hidden = false;
      tolBar.hidden = true;
      prevWrap.hidden = true;
      btnNext.hidden = false;
      btnExport.hidden = true;
      botBar.hidden = true;
      hud.innerHTML =
        '<div>滚轮：缩放画布</div><div>鼠标中键：拖动</div><div>右键：删除字框</div><div>拖动字框：调整位置</div><div>在空白处拖动：补充字框</div>';
      statusTxt.textContent = 'AI 已自动框选手写字符（支持智能合并汉字左右/上下偏旁），请核对！';
      if (fmState.boxes.length === 0) {
        fmRunAutoBoxDetection();
        showNoticeDialog('自动框字完成', `AI 已自动框选出 ${fmState.boxes.length} 个手写字符框（已启用汉字偏旁与点画智能聚合），请核对！`);
      }
    } else if (step === 3) {
      titleEl.textContent = '第三步：标注';
      btnReup.hidden = true;
      btnPrev.hidden = false;
      btnUndo.hidden = false;
      btnRedo.hidden = false;
      if (btnMerge) btnMerge.hidden = true;
      tolBar.hidden = true;
      prevWrap.hidden = false;
      btnNext.hidden = true;
      btnExport.hidden = false;
      botBar.hidden = false;
      hud.innerHTML =
        '<div>点击下方字符：进入标注模式</div><div>点击字框：单字标注</div><div>拖动框选：批量标注</div><div>右上角支持：按行一键标注 / 按顺序逐格标注</div>';
      statusTxt.textContent = '可点击右上角“⚡按行一键标注”或“⚡按顺序逐格标注”，也可点击底部字符框选标注';
      const cats = fmGetCategoryOrder();
      if (!cats.includes(fmState.activeLabelCat)) {
        fmState.activeLabelCat = cats[0] || '1';
      }
      fmRenderBottomCategories();
      fmRenderPreviewCanvas();
    }
    fmRenderCanvas();
  }

  function fmRenderBottomCategories() {
    const bar = document.getElementById('fmBottomBar');
    if (!bar) return;
    bar.innerHTML = '';
    const cats = fmGetCategoryOrder();
    for (const cat of cats) {
      const count = fmState.boxes.filter((b) => b.label === cat).length;
      const item = document.createElement('div');
      item.className = 'fm-cat-item';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fm-cat-btn' + (fmState.activeLabelCat === cat ? ' active' : '');
      btn.textContent = cat;
      btn.style.background = count > 0 || fmState.activeLabelCat === cat ? fmGetCategoryColor(cat) : '#383838';
      btn.addEventListener('click', () => {
        fmState.activeLabelCat = fmState.activeLabelCat === cat ? null : cat;
        fmRenderBottomCategories();
      });

      const cnt = document.createElement('span');
      cnt.className = 'fm-cat-count';
      cnt.textContent = `已选 ${count} 个`;

      item.append(btn, cnt);
      bar.appendChild(item);
    }
  }

  function fmRenderPreviewCanvas() {
    const pCanvas = document.getElementById('fmPreviewCanvas');
    if (!pCanvas || !fmState.alphaArr) return;
    const pctx = pCanvas.getContext('2d');
    pctx.clearRect(0, 0, pCanvas.width, pCanvas.height);

    const cats = fmGetCategoryOrder();
    const previewChars = cats.slice(0, 4).join(' ');
    pctx.fillStyle = '#ffffff';
    pctx.font = 'italic 22px "HanziPen SC", "Kaiti SC", serif';
    pctx.fillText(previewChars || '2 / 2', 12, 30);
  }

  function fmRenderCanvas() {
    const canvas = document.getElementById('fmMainCanvas');
    if (!canvas || !fmState.grayArr) return;
    const w = fmState.width;
    const h = fmState.height;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    // 1. Compute thresholded transparent ink image from tolerance
    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;
    const thresh = Math.max(4, 46 - fmState.tolerance);

    for (let i = 0; i < w * h; i++) {
      const diff = fmState.bgArr[i] - fmState.grayArr[i];
      let a = 0;
      if (diff > thresh) {
        a = Math.min(255, Math.round(((diff - thresh) / 22) * 255));
      }
      fmState.alphaArr[i] = a;
      data[i * 4] = 18;
      data[i * 4 + 1] = 18;
      data[i * 4 + 2] = 18;
      data[i * 4 + 3] = a;
    }
    ctx.putImageData(imgData, 0, 0);

    // 2. If Step 2 or Step 3, draw bounding boxes and labels
    if (fmState.step >= 2) {
      ctx.font = '11px sans-serif';
      fmState.boxes.forEach((b, idx) => {
        const color =
          fmState.step === 3 && b.label
            ? fmGetCategoryColor(b.label)
            : '#0ea5e9';
        ctx.strokeStyle = color;
        ctx.lineWidth = idx === fmState.selectedBoxIdx ? 2 : 1.3;
        ctx.strokeRect(b.x, b.y, b.w, b.h);

        // Top-left tag ("未标注" or character label)
        const tagText = fmState.step === 3 && b.label ? b.label : '未标注';
        const tw = Math.max(18, ctx.measureText(tagText).width + 8);
        ctx.fillStyle = color;
        ctx.fillRect(b.x - 0.5, b.y - 16, tw, 16);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(tagText, b.x + 3, b.y - 4);

        // Draw corner resize handles when selected in Step 2
        if (fmState.step === 2 && idx === fmState.selectedBoxIdx) {
          const corners = [
            [b.x, b.y],
            [b.x + b.w, b.y],
            [b.x, b.y + b.h],
            [b.x + b.w, b.y + b.h]
          ];
          ctx.fillStyle = '#0ea5e9';
          for (const [cx, cy] of corners) {
            ctx.fillRect(cx - 3.5, cy - 3.5, 7, 7);
          }
        }
      });

      // Red dashed marquee box in Step 3 or Step 2
      if (fmState.marquee) {
        const mx = Math.min(fmState.marquee.x0, fmState.marquee.x1);
        const my = Math.min(fmState.marquee.y0, fmState.marquee.y1);
        const mw = Math.abs(fmState.marquee.x1 - fmState.marquee.x0);
        const mh = Math.abs(fmState.marquee.y1 - fmState.marquee.y0);
        ctx.save();
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(mx, my, mw, mh);
        ctx.restore();
      }
    }

    const stage = document.getElementById('fmCanvasStage');
    stage.style.transform = `translate(${fmState.panX}px, ${fmState.panY}px) scale(${fmState.zoom / 100})`;
  }

  function fmFitCanvas() {
    const vp = document.getElementById('fmCanvasViewport');
    if (!vp || !fmState.width) return;
    const vw = vp.clientWidth || 1000;
    const vh = vp.clientHeight || 680;
    const s = Math.min((vw - 80) / fmState.width, (vh - 60) / fmState.height);
    fmState.zoom = Math.round(Math.max(40, Math.min(250, s * 100)));
    fmState.panX = Math.round((vw - fmState.width * (fmState.zoom / 100)) / 2);
    fmState.panY = Math.round((vh - fmState.height * (fmState.zoom / 100)) / 2);
  }

  // Extract user's personal handwriting geometry & ink density features from photographed boxes
  function fmComputeUserStyleProfile(labeledBoxes, alphaArr, w, h) {
    if (!labeledBoxes || labeledBoxes.length === 0) {
      return { aspectScaleX: 1.0, aspectScaleY: 1.0, slantBias: -0.03, strokePress: 0.26, desc: '标准手写特征' };
    }
    let ratioSum = 0;
    let ratioCount = 0;
    let slantSum = 0;
    let slantCount = 0;
    let densitySum = 0;

    for (const b of labeledBoxes) {
      const bx = Math.max(0, Math.round(b.x));
      const by = Math.max(0, Math.round(b.y));
      const bw = Math.min(w - bx, Math.max(4, Math.round(b.w)));
      const bh = Math.min(h - by, Math.max(4, Math.round(b.h)));

      if (b.label !== '.' && b.label !== '1' && bw >= 8 && bh >= 10) {
        ratioSum += bw / bh;
        ratioCount++;
      }

      // Compute 2nd-order central moments (mu11 / mu02) to measure natural handwriting slant
      let m00 = 0, m10 = 0, m01 = 0;
      for (let yy = 0; yy < bh; yy++) {
        for (let xx = 0; xx < bw; xx++) {
          const a = alphaArr[(by + yy) * w + (bx + xx)] / 255;
          if (a > 0.15) {
            m00 += a;
            m10 += xx * a;
            m01 += yy * a;
          }
        }
      }
      if (m00 > 8) {
        const cx = m10 / m00;
        const cy = m01 / m00;
        let mu11 = 0, mu02 = 0;
        for (let yy = 0; yy < bh; yy++) {
          for (let xx = 0; xx < bw; xx++) {
            const a = alphaArr[(by + yy) * w + (bx + xx)] / 255;
            if (a > 0.15) {
              mu11 += (xx - cx) * (yy - cy) * a;
              mu02 += (yy - cy) * (yy - cy) * a;
            }
          }
        }
        if (mu02 > 1) {
          slantSum += mu11 / mu02;
          slantCount++;
        }
        densitySum += m00 / (bw * bh);
      }
    }

    const avgRatio = ratioCount > 0 ? ratioSum / ratioCount : 0.88;
    const aspectScaleX = Math.max(0.84, Math.min(1.16, avgRatio / 0.88));
    const aspectScaleY = Math.max(0.88, Math.min(1.14, 1 / Math.sqrt(aspectScaleX)));
    const rawSlant = slantCount > 0 ? slantSum / slantCount : -0.03;
    const slantBias = Math.max(-0.16, Math.min(0.16, rawSlant * 0.45));
    const avgDensity = densitySum / Math.max(1, labeledBoxes.length);
    const strokePress = Math.max(0.14, Math.min(0.48, avgDensity * 1.15));

    const shapeTag = aspectScaleX < 0.94 ? '修长型字身' : aspectScaleX > 1.06 ? '扁宽型字身' : '匀称方正字身';
    const slantTag = slantBias < -0.02 ? '微向右倾' : slantBias > 0.02 ? '微向左倾' : '重心端正';
    const weightTag = strokePress > 0.30 ? '饱满浓墨笔画' : '轻盈纤细笔画';

    return {
      aspectScaleX: Number(aspectScaleX.toFixed(3)),
      aspectScaleY: Number(aspectScaleY.toFixed(3)),
      slantBias: Number(slantBias.toFixed(3)),
      strokePress: Number(strokePress.toFixed(3)),
      desc: `${shapeTag} · ${slantTag} · ${weightTag}`
    };
  }

  async function fmExportCustomFont() {
    let labeledBoxes = fmState.boxes.filter((b) => b.label);
    if (labeledBoxes.length === 0) {
      fmAutoLabelByRows();
      labeledBoxes = fmState.boxes.filter((b) => b.label);
    }
    const cats = fmGetCategoryOrder();
    const glyphs = {};
    for (const k of cats) glyphs[k] = [];

    const w = fmState.width;
    const h = fmState.height;
    const off = document.createElement('canvas');

    for (const b of fmState.boxes) {
      if (!b.label) continue;
      if (!glyphs[b.label]) glyphs[b.label] = [];
      const bx = Math.max(0, Math.round(b.x));
      const by = Math.max(0, Math.round(b.y));
      const bw = Math.min(w - bx, Math.max(4, Math.round(b.w)));
      const bh = Math.min(h - by, Math.max(4, Math.round(b.h)));
      off.width = bw;
      off.height = bh;
      const octx = off.getContext('2d');
      const idata = octx.createImageData(bw, bh);
      for (let yy = 0; yy < bh; yy++) {
        for (let xx = 0; xx < bw; xx++) {
          const srcIdx = (by + yy) * w + (bx + xx);
          const dstIdx = (yy * bw + xx) * 4;
          idata.data[dstIdx] = 20;
          idata.data[dstIdx + 1] = 20;
          idata.data[dstIdx + 2] = 20;
          idata.data[dstIdx + 3] = fmState.alphaArr[srcIdx];
        }
      }
      octx.putImageData(idata, 0, 0);
      glyphs[b.label].push({
        w: bw,
        h: bh,
        src: off.toDataURL('image/png')
      });
    }

    const styleProfile = fmComputeUserStyleProfile(labeledBoxes, fmState.alphaArr, w, h);
    const totalSaved = Object.values(glyphs).reduce((s, arr) => s + arr.length, 0);
    const uniqueChars = Object.keys(glyphs).filter((k) => glyphs[k].length > 0).length;
    const modeLabel = fmState.mode === 'chinese' ? '汉字/中英' : fmState.mode === 'english' ? '英语字母' : '数字';
    const fontObj = {
      name: `我的实拍${modeLabel}手写体 (${uniqueChars}字真迹 + 笔迹迁移)`,
      glyphs,
      styleProfile
    };
    await loadFontFromData(fontObj, true);
    renderCurrentPage();
    showNoticeDialog(
      '导出个人手写字体成功',
      `已保存 ${uniqueChars} 类字符共 ${totalSaved} 个实拍真迹切片！并提取您的个人笔迹特征【${styleProfile.desc}】自动应用至未拍摄汉字，已切换为当前字体！`
    );
  }

  // =========================================================================
  // Event Listeners & Initialization
  // =========================================================================
  function bindEvents() {
    // Top Window Mode Switch
    document.getElementById('tabMainApp').addEventListener('click', () => {
      if (state.pages.length > 0) showWorkspaceView();
      else showHomeView();
    });
    document.getElementById('tabFontMaker').addEventListener('click', () => showFontMakerView());
    document.getElementById('btnHomeOpenFontMaker').addEventListener('click', () => showFontMakerView());
    document.getElementById('btnGoMakeFont').addEventListener('click', () => showFontMakerView());

    // Quick Example Switcher in Top Toolbar
    const quickExampleSelect = document.getElementById('quickExampleSelect');
    if (quickExampleSelect) {
      quickExampleSelect.addEventListener('change', (e) => {
        if (e.target.value) loadExample(e.target.value);
      });
    }

    const fileInputPdf = document.getElementById('fileInputPdf');
    document.getElementById('btnHomeSelectPdf').addEventListener('click', () => fileInputPdf.click());
    document.getElementById('btnReselectPdf').addEventListener('click', () => showHomeView());
    fileInputPdf.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) loadUserPdfFile(e.target.files[0]);
      e.target.value = '';
    });

    // Save / Load Project JSON
    const fileInputProject = document.getElementById('fileInputProject');
    document.getElementById('btnHomeLoadProject').addEventListener('click', () => fileInputProject.click());
    document.getElementById('btnLoadProject').addEventListener('click', () => fileInputProject.click());
    fileInputProject.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const txt = await f.text();
        const proj = JSON.parse(txt);
        if (proj.config) {
          state.config = proj.config;
          if (!state.pages.length) await loadExample('example1');
          syncAllControlsFromState();
          renderCurrentPage();
        }
      } catch (err) {
        alert('项目文件格式无效');
      }
      e.target.value = '';
    });

    document.getElementById('btnSaveProject').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ projectPath: state.projectPath, config: state.config }, null, 2)], {
        type: 'application/json'
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '手写体项目配置.json';
      a.click();
    });

    // Top Toolbar Controls
    document.getElementById('btnUndo').addEventListener('click', undoConfig);
    document.getElementById('btnRedo').addEventListener('click', redoConfig);
    document.getElementById('btnZoomOut').addEventListener('click', () => {
      state.zoom = Math.max(40, state.zoom - 15);
      updateStageTransform();
    });
    document.getElementById('btnZoomIn').addEventListener('click', () => {
      state.zoom = Math.min(300, state.zoom + 15);
      updateStageTransform();
    });
    document.getElementById('zoomSlider').addEventListener('input', (e) => {
      state.zoom = Number(e.target.value);
      updateStageTransform();
    });
    document.getElementById('chkHideLegend').addEventListener('change', (e) => {
      state.hideLegend = e.target.checked;
      updateStageOverlayHandles();
    });

    // Page Navigation
    document.getElementById('btnPrevPage').addEventListener('click', () => {
      if (state.currentPage > 1) {
        state.currentPage--;
        refreshPageNavUI();
        syncAllControlsFromState();
        renderCurrentPage();
      }
    });
    document.getElementById('btnNextPage').addEventListener('click', () => {
      if (state.currentPage < state.pages.length) {
        state.currentPage++;
        refreshPageNavUI();
        syncAllControlsFromState();
        renderCurrentPage();
      }
    });
    document.getElementById('pageSelect').addEventListener('change', (e) => {
      state.currentPage = Number(e.target.value);
      refreshPageNavUI();
      syncAllControlsFromState();
      renderCurrentPage();
    });

    document.getElementById('btnRerollSeed').addEventListener('click', () => {
      state.globalSeed = Math.floor(Math.random() * 90000000) + 100000;
      if (state.config.fillMode === 'manual') {
        populateManualTable(state.config.manualPreset || (state.config.visionPreset ? 'vision' : 'temp'));
      }
      renderCurrentPage();
    });

    document.getElementById('btnExportPdf').addEventListener('click', openExportModal);
    document.getElementById('btnSettings').addEventListener('click', openExportModal);
    document.getElementById('btnCloseExportModal').addEventListener('click', () => document.getElementById('dialogExportPdf').close());
    document.getElementById('btnCancelExport').addEventListener('click', () => document.getElementById('dialogExportPdf').close());
    document.getElementById('btnStartExport').addEventListener('click', runPdfExport);

    // Card 1 & Card 2 Sliders + Number Inputs
    const bindGridControl = (rngId, numId, key, isPageSpecific = false, isInt = false) => {
      const rng = document.getElementById(rngId);
      const num = document.getElementById(numId);
      const apply = (raw) => {
        const val = isInt ? Math.max(1, Math.round(Number(raw))) : Number(Number(raw).toFixed(2));
        if (isPageSpecific) setPageGridParam(key, val);
        else state.config[key] = val;
        if (key === 'cols') {
          renderColsCheckGrid();
        }
        syncAllControlsFromState();
        renderCurrentPage();
      };
      rng.addEventListener('input', () => apply(rng.value));
      rng.addEventListener('change', () => pushHistory());
      num.addEventListener('change', () => {
        apply(num.value);
        pushHistory();
      });
    };

    bindGridControl('rngStartX', 'numStartX', 'startX', true, false);
    bindGridControl('rngStartY', 'numStartY', 'startY', true, false);
    bindGridControl('rngColWidth', 'numColWidth', 'colWidth', false, false);
    bindGridControl('rngRowHeight', 'numRowHeight', 'rowHeight', false, false);
    bindGridControl('rngCellPad', 'numCellPad', 'cellPad', false, false);
    bindGridControl('rngRows', 'numRows', 'rows', true, true);
    bindGridControl('rngCols', 'numCols', 'cols', false, true);

    // Ruler toggles
    document.getElementById('btnToggleColRuler').addEventListener('click', () => {
      state.showColRuler = !state.showColRuler;
      updateStageOverlayHandles();
    });
    document.getElementById('btnToggleRowRuler').addEventListener('click', () => {
      state.showRowRuler = !state.showRowRuler;
      updateStageOverlayHandles();
    });

    // Reset buttons in Card 1 & 2
    const defaultsGrid = { startX: 4.91, startY: 3.82, colWidth: 1.82, rowHeight: 0.72, cellPad: -0.28, rows: 24, cols: 10 };
    document.querySelectorAll('[data-reset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.reset;
        if (k === 'startX' || k === 'startY' || k === 'rows') {
          setPageGridParam(k, defaultsGrid[k]);
        } else {
          state.config[k] = defaultsGrid[k];
        }
        syncAllControlsFromState();
        pushHistory();
        renderCurrentPage();
      });
    });

    // Fill Mode Tabs & Presets ('random' | 'manual' | 'article')
    document.getElementById('tabFillRandom').addEventListener('click', () => {
      state.config.fillMode = 'random';
      syncAllControlsFromState();
      renderCurrentPage();
    });
    document.getElementById('tabFillManual').addEventListener('click', () => {
      state.config.fillMode = 'manual';
      if (!state.config.manualData || !state.config.manualData.length) {
        populateManualTable(state.config.manualPreset || 'course_eval');
      }
      syncAllControlsFromState();
      renderCurrentPage();
    });
    const tabFillArticle = document.getElementById('tabFillArticle');
    if (tabFillArticle) {
      tabFillArticle.addEventListener('click', () => {
        state.config.fillMode = 'article';
        if (!state.config.articleText) {
          state.config.articleText = SAMPLE_ARTICLES.cn_essay;
        }
        if (!state.config.articleLayout) {
          state.config.articleLayout = state.config.cols >= 12 ? 'grid' : 'lines';
        }
        syncAllControlsFromState();
        renderCurrentPage();
      });
    }

    document.getElementById('btnPresetTemp').addEventListener('click', () => {
      state.config.visionPreset = false;
      state.config.fillMode = 'random';
      state.config.digitSlots = [
        { type: 'digit', digits: [3] },
        { type: 'digit', digits: [6] },
        { type: 'dot', digits: ['.'] },
        { type: 'digit', digits: [1, 2, 3, 4, 5, 6, 7, 8, 9] }
      ];
      syncAllControlsFromState();
      pushHistory();
      renderCurrentPage();
    });

    document.getElementById('btnPresetVision').addEventListener('click', () => {
      state.config.visionPreset = true;
      state.config.fillMode = 'random';
      state.config.digitSlots = [
        { type: 'digit', digits: [4, 5] },
        { type: 'dot', digits: ['.'] },
        { type: 'digit', digits: [0, 1, 3, 4, 5, 6, 7, 8, 9] }
      ];
      syncAllControlsFromState();
      pushHistory();
      renderCurrentPage();
    });

    const btnPresetCnStatus = document.getElementById('btnPresetCnStatus');
    if (btnPresetCnStatus) {
      btnPresetCnStatus.addEventListener('click', () => {
        state.config.visionPreset = false;
        state.config.fillMode = 'random';
        state.config.digitSlots = [
          { type: 'cn_words', digits: ['正常', '良好', '合格', '优秀', '全勤', '已检'] }
        ];
        syncAllControlsFromState();
        pushHistory();
        renderCurrentPage();
      });
    }

    const btnPresetEnGrade = document.getElementById('btnPresetEnGrade');
    if (btnPresetEnGrade) {
      btnPresetEnGrade.addEventListener('click', () => {
        state.config.visionPreset = false;
        state.config.fillMode = 'random';
        state.config.digitSlots = [
          { type: 'en_letters', digits: ['A+', 'A', 'A-', 'B+', 'B', 'Pass'] }
        ];
        syncAllControlsFromState();
        pushHistory();
        renderCurrentPage();
      });
    }

    document.getElementById('btnAddDigitSlot').addEventListener('click', () => {
      state.config.visionPreset = false;
      state.config.digitSlots.push({ type: 'digit', digits: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
      renderDigitSlotsUI();
      pushHistory();
      renderCurrentPage();
    });

    // Article / Essay / Scratch Paper Controls
    const articleLayoutSelect = document.getElementById('articleLayoutSelect');
    if (articleLayoutSelect) {
      articleLayoutSelect.addEventListener('change', (e) => {
        state.config.articleLayout = e.target.value;
        pushHistory();
        renderCurrentPage();
      });
    }
    const articleTextarea = document.getElementById('articleTextarea');
    if (articleTextarea) {
      articleTextarea.addEventListener('input', (e) => {
        state.config.articleText = e.target.value;
        renderCurrentPage();
      });
      articleTextarea.addEventListener('change', () => pushHistory());
    }
    const bindSampleArticleBtn = (btnId, sampleKey, layoutMode) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        state.config.fillMode = 'article';
        state.config.articleText = SAMPLE_ARTICLES[sampleKey];
        if (layoutMode) state.config.articleLayout = layoutMode;
        syncAllControlsFromState();
        pushHistory();
        renderCurrentPage();
      });
    };
    bindSampleArticleBtn('btnSampleCnEssay', 'cn_essay', 'grid');
    bindSampleArticleBtn('btnSampleEnEssay', 'en_essay', 'lines');
    bindSampleArticleBtn('btnSampleScratch', 'scratch_math', 'lines');

    // Edit Slot Modal
    document.getElementById('slotTypeSelect').addEventListener('change', (e) => {
      const t = e.target.value;
      const curSlot = state.config.digitSlots[editingSlotIndex];
      const defPool =
        t === 'cn_words'
          ? ['正常', '良好', '优秀', '合格']
          : t === 'en_letters'
          ? ['A+', 'A', 'A-', 'B+']
          : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      populateSlotChecksGrid(t, curSlot && curSlot.type === t ? curSlot.digits : defPool);
    });
    document.getElementById('btnSlotSelectAll').addEventListener('click', () => {
      document.querySelectorAll('#slotDigitChecks input[type="checkbox"]').forEach((c) => (c.checked = true));
    });
    document.getElementById('btnSlotSelectClear').addEventListener('click', () => {
      document.querySelectorAll('#slotDigitChecks input[type="checkbox"]').forEach((c) => (c.checked = false));
    });
    document.getElementById('btnSlotOk').addEventListener('click', () => {
      const slot = state.config.digitSlots[editingSlotIndex];
      if (slot) {
        const t = document.getElementById('slotTypeSelect').value;
        slot.type = t;
        state.config.visionPreset = false;
        if (t === 'dot') {
          slot.digits = ['.'];
        } else if (t === 'custom_pool') {
          const raw = document.getElementById('slotCustomPoolInput').value || '正常';
          const tokens = raw
            .split(/[,，\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          slot.digits = tokens.length ? tokens : ['正常'];
        } else {
          const checked = [];
          document.querySelectorAll('#slotDigitChecks input[type="checkbox"]:checked').forEach((c) => {
            checked.push(t === 'digit' ? Number(c.value) : c.value);
          });
          slot.digits = checked.length ? checked : t === 'digit' ? [0] : ['正常'];
        }
        renderDigitSlotsUI();
        pushHistory();
        renderCurrentPage();
      }
      document.getElementById('dialogEditSlot').close();
    });
    document.getElementById('btnSlotCancel').addEventListener('click', () => document.getElementById('dialogEditSlot').close());
    document.getElementById('btnCloseSlotModal').addEventListener('click', () => document.getElementById('dialogEditSlot').close());

    // Manual Input Modal buttons
    document.getElementById('btnOpenManualModal').addEventListener('click', openManualInputModal);
    document.getElementById('btnCloseManualModal').addEventListener('click', () => document.getElementById('dialogManualInput').close());
    document.getElementById('btnSaveManualModal').addEventListener('click', saveManualModalChanges);

    const bindManualPresetButtons = (modalBtnId, sideBtnId, presetName) => {
      const mBtn = document.getElementById(modalBtnId);
      if (mBtn) {
        mBtn.addEventListener('click', () => {
          state.globalSeed += 17;
          populateManualTable(presetName);
          openManualInputModal();
          renderCurrentPage();
        });
      }
      const sBtn = document.getElementById(sideBtnId);
      if (sBtn) {
        sBtn.addEventListener('click', () => {
          state.globalSeed += 19;
          populateManualTable(presetName);
          renderCurrentPage();
        });
      }
    };
    bindManualPresetButtons('btnModalFillVision', 'btnRegenManualVision', 'vision');
    bindManualPresetButtons('btnModalFillTemp', 'btnRegenManualTemp', 'temp');
    bindManualPresetButtons('btnModalFillCourse', 'btnRegenManualCourse', 'course_eval');
    bindManualPresetButtons('btnModalFillLab', 'btnRegenManualLab', 'lab_inspect');
    bindManualPresetButtons('btnModalFillBilingual', 'btnRegenManualBilingual', 'bilingual_notes');

    // Font Select, Ink Color Select & Checkboxes
    document.getElementById('fontSelect').addEventListener('change', (e) => {
      activeFontIndex = Number(e.target.value) || 0;
      refreshFontSelectUI();
      renderCurrentPage();
    });
    const inkColorSelect = document.getElementById('inkColorSelect');
    if (inkColorSelect) {
      inkColorSelect.addEventListener('change', (e) => {
        state.config.inkColor = e.target.value || '#161616';
        pushHistory();
        renderCurrentPage();
      });
    }
    document.getElementById('chkNormalizeFontSize').addEventListener('change', (e) => {
      state.normalizeFontSize = e.target.checked;
      renderCurrentPage();
    });
    document.getElementById('chkScratchEffect').addEventListener('change', (e) => {
      state.scratchEffect = e.target.checked;
      renderCurrentPage();
    });

    // Dice Randomizer Buttons on Card Headers (Video 0:35-0:36)
    document.querySelectorAll('[data-dice-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const secKey = btn.dataset.diceSection;
        const schema = RANDOM_SECTIONS_SCHEMA[secKey];
        if (!schema) return;
        for (const f of schema.fields) {
          const [d0, d1] = f.def;
          const jitter0 = (0.65 + Math.random() * 0.75) * d0;
          const jitter1 = (0.65 + Math.random() * 0.75) * d1;
          state.config[secKey][f.key] = [
            Number(Math.max(f.min, Math.min(f.max, jitter0)).toFixed(2)),
            Number(Math.max(f.min, Math.min(f.max, jitter1)).toFixed(2))
          ];
        }
        state.globalSeed += 7;
        syncAllControlsFromState();
        pushHistory();
        renderCurrentPage();
      });
    });

    // Copy / Paste Section Parameters
    document.querySelectorAll('[data-copy-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sec = btn.dataset.copySection;
        if (sec === 'grid') {
          state.clipboardSection.grid = {
            startX: state.config.startX,
            startY: state.config.startY,
            colWidth: state.config.colWidth,
            rowHeight: state.config.rowHeight,
            cellPad: state.config.cellPad
          };
        } else {
          state.clipboardSection[sec] = deepClone(state.config[sec]);
        }
      });
    });
    document.querySelectorAll('[data-paste-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sec = btn.dataset.pasteSection;
        if (!state.clipboardSection[sec]) return;
        if (sec === 'grid') {
          Object.assign(state.config, deepClone(state.clipboardSection.grid));
        } else {
          state.config[sec] = deepClone(state.clipboardSection[sec]);
        }
        syncAllControlsFromState();
        pushHistory();
        renderCurrentPage();
      });
    });

    // Interactive Red Origin Handle Dragging
    const originHandle = document.getElementById('originHandle');
    originHandle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      originHandle.setPointerCapture(e.pointerId);
      const pg = getPageGridParams();
      const startClientX = e.clientX;
      const startClientY = e.clientY;
      const initX = pg.startX;
      const initY = pg.startY;
      const scale = state.zoom / 100;

      const onMove = (ev) => {
        const dxCm = (ev.clientX - startClientX) / (PX_PER_CM * scale);
        const dyCm = (ev.clientY - startClientY) / (PX_PER_CM * scale);
        setPageGridParam('startX', Number(Math.max(0.2, initX + dxCm).toFixed(2)));
        setPageGridParam('startY', Number(Math.max(0.2, initY + dyCm).toFixed(2)));
        syncAllControlsFromState();
        renderCurrentPage();
      };
      const onUp = () => {
        originHandle.removeEventListener('pointermove', onMove);
        originHandle.removeEventListener('pointerup', onUp);
        pushHistory();
      };
      originHandle.addEventListener('pointermove', onMove);
      originHandle.addEventListener('pointerup', onUp);
    });

    // Interactive Green Column Width & Row Height Ruler Dragging
    const colRuler = document.getElementById('colWidthRuler');
    colRuler.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      colRuler.setPointerCapture(e.pointerId);
      const startClientX = e.clientX;
      const initW = state.config.colWidth;
      const scale = state.zoom / 100;
      const onMove = (ev) => {
        const dxCm = (ev.clientX - startClientX) / (PX_PER_CM * scale);
        state.config.colWidth = Number(Math.max(0.4, Math.min(6.0, initW + dxCm)).toFixed(2));
        syncAllControlsFromState();
        renderCurrentPage();
      };
      const onUp = () => {
        colRuler.removeEventListener('pointermove', onMove);
        colRuler.removeEventListener('pointerup', onUp);
        pushHistory();
      };
      colRuler.addEventListener('pointermove', onMove);
      colRuler.addEventListener('pointerup', onUp);
    });

    const rowRuler = document.getElementById('rowHeightRuler');
    rowRuler.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      rowRuler.setPointerCapture(e.pointerId);
      const startClientY = e.clientY;
      const initH = state.config.rowHeight;
      const scale = state.zoom / 100;
      const onMove = (ev) => {
        const dyCm = (ev.clientY - startClientY) / (PX_PER_CM * scale);
        state.config.rowHeight = Number(Math.max(0.3, Math.min(3.0, initH + dyCm)).toFixed(2));
        syncAllControlsFromState();
        renderCurrentPage();
      };
      const onUp = () => {
        rowRuler.removeEventListener('pointermove', onMove);
        rowRuler.removeEventListener('pointerup', onUp);
        pushHistory();
      };
      rowRuler.addEventListener('pointermove', onMove);
      rowRuler.addEventListener('pointerup', onUp);
    });

    // Drag Mode Selector Buttons ('char' | 'cell' | 'row' | 'pan') & Reset Custom Offsets
    document.querySelectorAll('.drag-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.drag-mode-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.dragMode = btn.dataset.dragMode || 'char';
        const hoverBox = document.getElementById('hoverHitBox');
        if (hoverBox) hoverBox.hidden = true;
      });
    });

    const btnResetCustomOffsets = document.getElementById('btnResetCustomOffsets');
    if (btnResetCustomOffsets) {
      btnResetCustomOffsets.addEventListener('click', () => {
        state.config.colOffsets = {};
        state.config.rowOffsets = {};
        state.config.cellOffsets = {};
        state.config.charOffsets = {};
        const hoverBox = document.getElementById('hoverHitBox');
        if (hoverBox) hoverBox.hidden = true;
        pushHistory();
        renderCurrentPage();
      });
    }

    // Viewport Hit-Test Dragging (Per-Char / Per-Cell / Per-Row) & Panning / Wheel Zooming
    const viewport = document.getElementById('canvasViewport');
    const hoverHitBox = document.getElementById('hoverHitBox');
    const hoverHitTag = document.getElementById('hoverHitTag');
    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;
    let activeDragTarget = null;

    const toStageCoords = (e) => {
      const stage = document.getElementById('canvasStage');
      if (!stage) return { x: 0, y: 0 };
      const rect = stage.getBoundingClientRect();
      const scale = state.zoom / 100;
      return {
        x: (e.clientX - rect.left) / scale,
        y: (e.clientY - rect.top) / scale
      };
    };

    const findHitTarget = (x, y) => {
      if (state.dragMode === 'pan' || !state.hitBoxes) return null;
      const hitInList = (list, pad = 4) => {
        if (!list) return null;
        for (let i = list.length - 1; i >= 0; i--) {
          const b = list[i];
          if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) {
            return b;
          }
        }
        return null;
      };
      if (state.dragMode === 'char') {
        const chHit = hitInList(state.hitBoxes.chars, 4);
        if (chHit) return { type: 'char', box: chHit, label: `拖动单字 "${chHit.ch}" (行${chHit.r}列${chHit.c})` };
        const cellHit = hitInList(state.hitBoxes.cells, 2);
        if (cellHit) return { type: 'cell', box: cellHit, label: `拖动单格 "${cellHit.text}" (行${cellHit.r}列${cellHit.c})` };
      } else if (state.dragMode === 'cell') {
        const cellHit = hitInList(state.hitBoxes.cells, 4);
        if (cellHit) return { type: 'cell', box: cellHit, label: `拖动单格 "${cellHit.text}" (行${cellHit.r}列${cellHit.c})` };
      } else if (state.dragMode === 'row') {
        const rowHit = hitInList(state.hitBoxes.rows, 2);
        if (rowHit) return { type: 'row', box: rowHit, label: `拖动整行 (第 ${rowHit.r} 行)` };
      }
      return null;
    };

    const showHoverBox = (target) => {
      if (!hoverHitBox || !hoverHitTag) return;
      if (!target || state.hideLegend) {
        hoverHitBox.hidden = true;
        return;
      }
      hoverHitBox.hidden = false;
      hoverHitBox.style.left = `${target.box.x - 2}px`;
      hoverHitBox.style.top = `${target.box.y - 2}px`;
      hoverHitBox.style.width = `${target.box.w + 4}px`;
      hoverHitBox.style.height = `${target.box.h + 4}px`;
      hoverHitTag.textContent = target.label;
    };

    viewport.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;

      // Left-click: check if pointer hits a draggable digit/cell/row first
      if (e.button === 0 && state.dragMode !== 'pan') {
        const pt = toStageCoords(e);
        const hit = findHitTarget(pt.x, pt.y);
        if (hit) {
          e.preventDefault();
          viewport.setPointerCapture(e.pointerId);
          const mapName = hit.type === 'char' ? 'charOffsets' : hit.type === 'cell' ? 'cellOffsets' : 'rowOffsets';
          if (!state.config[mapName]) state.config[mapName] = {};
          const cur = state.config[mapName][hit.box.key] || { dx: 0, dy: 0 };
          activeDragTarget = {
            type: hit.type,
            mapName,
            key: hit.box.key,
            label: hit.label,
            startClientX: e.clientX,
            startClientY: e.clientY,
            initDx: cur.dx || 0,
            initDy: cur.dy || 0,
            initBox: { ...hit.box }
          };
          viewport.style.cursor = 'grabbing';
          showHoverBox(hit);
          return;
        }
      }

      isPanning = true;
      viewport.classList.add('panning');
      viewport.setPointerCapture(e.pointerId);
      panStartX = e.clientX - state.panX;
      panStartY = e.clientY - state.panY;
    });

    viewport.addEventListener('pointermove', (e) => {
      if (activeDragTarget) {
        const scale = state.zoom / 100;
        const dxPx = (e.clientX - activeDragTarget.startClientX) / scale;
        const dyPx = (e.clientY - activeDragTarget.startClientY) / scale;
        const dxCm = dxPx / PX_PER_CM;
        const dyCm = dyPx / PX_PER_CM;
        state.config[activeDragTarget.mapName][activeDragTarget.key] = {
          dx: Number((activeDragTarget.initDx + dxCm).toFixed(3)),
          dy: Number((activeDragTarget.initDy + dyCm).toFixed(3))
        };
        renderCurrentPage();
        showHoverBox({
          type: activeDragTarget.type,
          label: activeDragTarget.label,
          box: {
            x: activeDragTarget.initBox.x + dxPx,
            y: activeDragTarget.initBox.y + dyPx,
            w: activeDragTarget.initBox.w,
            h: activeDragTarget.initBox.h
          }
        });
        return;
      }

      if (isPanning) {
        state.panX = e.clientX - panStartX;
        state.panY = e.clientY - panStartY;
        updateStageTransform();
        return;
      }

      // Hover feedback when moving mouse over digits/cells/rows
      const pt = toStageCoords(e);
      const hit = findHitTarget(pt.x, pt.y);
      if (hit) {
        viewport.style.cursor = 'move';
        showHoverBox(hit);
      } else {
        viewport.style.cursor = state.dragMode === 'pan' ? 'grab' : 'default';
        showHoverBox(null);
      }
    });

    const endPan = () => {
      if (activeDragTarget) {
        activeDragTarget = null;
        viewport.style.cursor = 'default';
        pushHistory();
        return;
      }
      isPanning = false;
      viewport.classList.remove('panning');
    };
    viewport.addEventListener('pointerup', endPan);
    viewport.addEventListener('pointercancel', endPan);
    viewport.addEventListener('pointerleave', () => {
      if (!activeDragTarget) showHoverBox(null);
    });

    viewport.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const oldScale = state.zoom / 100;
        const delta = e.deltaY < 0 ? 12 : -12;
        const newZoom = Math.max(40, Math.min(300, state.zoom + delta));
        const newScale = newZoom / 100;
        state.panX = mx - ((mx - state.panX) / oldScale) * newScale;
        state.panY = my - ((my - state.panY) / oldScale) * newScale;
        state.zoom = newZoom;
        updateStageTransform();
      },
      { passive: false }
    );

    // =====================================================================
    // Font Maker Event Listeners (Digits / English / Chinese Modes)
    // =====================================================================
    document.querySelectorAll('[data-fm-mode]').forEach((btn) => {
      btn.addEventListener('click', () => fmSwitchPresetMode(btn.dataset.fmMode));
    });

    const fmCharsetInput = document.getElementById('fmCharsetInput');
    if (fmCharsetInput) {
      fmCharsetInput.addEventListener('input', () => {
        const sampleImg = document.getElementById('fmSamplePhotoImg');
        if (sampleImg && fmState.mode !== 'digits') {
          sampleImg.src = fmGenerateSampleHandwritingPhoto(fmState.mode);
        }
      });
    }

    const btnFmExtractDocChars = document.getElementById('btnFmExtractDocChars');
    if (btnFmExtractDocChars) {
      btnFmExtractDocChars.addEventListener('click', fmExtractCurrentDocChars);
    }

    const btnFmDownloadTemplatePdf = document.getElementById('btnFmDownloadTemplatePdf');
    if (btnFmDownloadTemplatePdf) {
      btnFmDownloadTemplatePdf.addEventListener('click', fmDownloadTemplatePdf);
    }

    const fileInputPhoto = document.getElementById('fileInputPhoto');
    document.getElementById('btnFmUploadPhoto').addEventListener('click', () => fileInputPhoto.click());
    document.getElementById('btnFmReupload').addEventListener('click', () => {
      fmSetStep(0);
    });
    fileInputPhoto.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const im = new Image();
        im.onload = () => fmLoadImageAndStartStep1(im);
        im.src = reader.result;
      };
      reader.readAsDataURL(f);
      e.target.value = '';
    });

    document.getElementById('btnFmUseSamplePhoto').addEventListener('click', () => {
      const im = new Image();
      im.onload = () => fmLoadImageAndStartStep1(im);
      im.src = fmGenerateSampleHandwritingPhoto(fmState.mode);
    });

    document.getElementById('fmToleranceSlider').addEventListener('input', (e) => {
      fmState.tolerance = Number(e.target.value);
      document.getElementById('fmToleranceVal').textContent = String(fmState.tolerance);
      fmRenderCanvas();
    });

    document.getElementById('btnFmNextStep').addEventListener('click', () => {
      if (fmState.step === 1) fmSetStep(2);
      else if (fmState.step === 2) fmSetStep(3);
    });
    document.getElementById('btnFmPrevStep').addEventListener('click', () => {
      if (fmState.step === 3) fmSetStep(2);
      else if (fmState.step === 2) fmSetStep(1);
    });

    document.getElementById('btnFmUndo').addEventListener('click', () => {
      if (fmState.historyIdx > 0) {
        fmState.historyIdx--;
        fmState.boxes = deepClone(fmState.history[fmState.historyIdx]);
        document.getElementById('btnFmUndo').disabled = fmState.historyIdx <= 0;
        document.getElementById('btnFmRedo').disabled = fmState.historyIdx >= fmState.history.length - 1;
        fmRenderBottomCategories();
        fmRenderCanvas();
      }
    });
    document.getElementById('btnFmRedo').addEventListener('click', () => {
      if (fmState.historyIdx < fmState.history.length - 1) {
        fmState.historyIdx++;
        fmState.boxes = deepClone(fmState.history[fmState.historyIdx]);
        document.getElementById('btnFmUndo').disabled = fmState.historyIdx <= 0;
        document.getElementById('btnFmRedo').disabled = fmState.historyIdx >= fmState.history.length - 1;
        fmRenderBottomCategories();
        fmRenderCanvas();
      }
    });

    const btnFmMergeRadicals = document.getElementById('btnFmMergeRadicals');
    if (btnFmMergeRadicals) {
      btnFmMergeRadicals.addEventListener('click', () => {
        fmState.boxes = fmMergeNearbyRadicals(fmState.boxes, 52, 54);
        fmPushHistory();
        fmRenderCanvas();
      });
    }

    document.getElementById('btnFmAutoLabelRows').addEventListener('click', fmAutoLabelByRows);
    const btnFmAutoLabelSeq = document.getElementById('btnFmAutoLabelSeq');
    if (btnFmAutoLabelSeq) {
      btnFmAutoLabelSeq.addEventListener('click', fmAutoLabelSequential);
    }
    document.getElementById('btnFmExportFont').addEventListener('click', fmExportCustomFont);

    document.getElementById('btnCloseNotice').addEventListener('click', () => document.getElementById('dialogNotice').close());
    document.getElementById('btnNoticeOk').addEventListener('click', () => document.getElementById('dialogNotice').close());

    // Font Maker Canvas Interactions (Pan, Zoom, Box Move/Resize/Add, Right-click Delete, Step 3 Marquee Label)
    const fmVp = document.getElementById('fmCanvasViewport');
    const fmMenu = document.getElementById('fmContextMenu');

    const toFmCoords = (e) => {
      const rect = fmVp.getBoundingClientRect();
      const s = fmState.zoom / 100;
      return {
        x: (e.clientX - rect.left - fmState.panX) / s,
        y: (e.clientY - rect.top - fmState.panY) / s
      };
    };

    fmVp.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (fmState.step !== 2) return;
      const pt = toFmCoords(e);
      const hitIdx = fmState.boxes.findIndex((b) => pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h);
      if (hitIdx >= 0) {
        fmState.contextBoxIdx = hitIdx;
        fmState.selectedBoxIdx = hitIdx;
        fmRenderCanvas();
        fmMenu.style.left = `${e.clientX}px`;
        fmMenu.style.top = `${e.clientY}px`;
        fmMenu.hidden = false;
      }
    });

    document.getElementById('btnFmDeleteBox').addEventListener('click', () => {
      if (fmState.contextBoxIdx >= 0) {
        fmState.boxes.splice(fmState.contextBoxIdx, 1);
        fmState.contextBoxIdx = -1;
        fmState.selectedBoxIdx = -1;
        fmPushHistory();
        fmRenderCanvas();
      }
      fmMenu.hidden = true;
    });
    document.getElementById('btnFmCancelMenu').addEventListener('click', () => {
      fmMenu.hidden = true;
    });

    let fmDragMode = null; // 'pan' | 'moveBox' | 'newBox' | 'marquee'
    let fmDragStart = { x: 0, y: 0, clientX: 0, clientY: 0, boxOrig: null };

    fmVp.addEventListener('pointerdown', (e) => {
      fmMenu.hidden = true;
      if (e.button === 2) return;
      fmVp.setPointerCapture(e.pointerId);
      const pt = toFmCoords(e);

      if (e.button === 1 || fmState.step === 1) {
        fmDragMode = 'pan';
        fmDragStart = { clientX: e.clientX - fmState.panX, clientY: e.clientY - fmState.panY };
        return;
      }

      if (fmState.step === 2) {
        const hitIdx = fmState.boxes.findIndex((b) => pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h);
        if (hitIdx >= 0) {
          fmState.selectedBoxIdx = hitIdx;
          fmDragMode = 'moveBox';
          fmDragStart = { x: pt.x, y: pt.y, boxOrig: { ...fmState.boxes[hitIdx] } };
        } else {
          fmState.selectedBoxIdx = -1;
          fmDragMode = 'newBox';
          fmState.marquee = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
        }
        fmRenderCanvas();
      } else if (fmState.step === 3) {
        if (!fmState.activeLabelCat) {
          fmDragMode = 'pan';
          fmDragStart = { clientX: e.clientX - fmState.panX, clientY: e.clientY - fmState.panY };
          return;
        }
        const hitIdx = fmState.boxes.findIndex((b) => pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h);
        if (hitIdx >= 0) {
          fmState.boxes[hitIdx].label = fmState.activeLabelCat;
          fmPushHistory();
          fmRenderBottomCategories();
          fmRenderCanvas();
        } else {
          fmDragMode = 'marquee';
          fmState.marquee = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
          fmRenderCanvas();
        }
      }
    });

    fmVp.addEventListener('pointermove', (e) => {
      if (!fmDragMode) return;
      const pt = toFmCoords(e);
      if (fmDragMode === 'pan') {
        fmState.panX = e.clientX - fmDragStart.clientX;
        fmState.panY = e.clientY - fmDragStart.clientY;
        fmRenderCanvas();
      } else if (fmDragMode === 'moveBox' && fmState.selectedBoxIdx >= 0) {
        const b = fmState.boxes[fmState.selectedBoxIdx];
        b.x = fmDragStart.boxOrig.x + (pt.x - fmDragStart.x);
        b.y = fmDragStart.boxOrig.y + (pt.y - fmDragStart.y);
        fmRenderCanvas();
      } else if ((fmDragMode === 'newBox' || fmDragMode === 'marquee') && fmState.marquee) {
        fmState.marquee.x1 = pt.x;
        fmState.marquee.y1 = pt.y;
        fmRenderCanvas();
      }
    });

    fmVp.addEventListener('pointerup', () => {
      if (fmDragMode === 'moveBox') {
        fmPushHistory();
      } else if (fmDragMode === 'newBox' && fmState.marquee) {
        const mx = Math.min(fmState.marquee.x0, fmState.marquee.x1);
        const my = Math.min(fmState.marquee.y0, fmState.marquee.y1);
        const mw = Math.abs(fmState.marquee.x1 - fmState.marquee.x0);
        const mh = Math.abs(fmState.marquee.y1 - fmState.marquee.y0);
        if (mw > 5 && mh > 5) {
          fmState.boxes.push({ x: mx, y: my, w: mw, h: mh, label: null });
          fmPushHistory();
        }
        fmState.marquee = null;
        fmRenderCanvas();
      } else if (fmDragMode === 'marquee' && fmState.marquee && fmState.activeLabelCat) {
        const mx0 = Math.min(fmState.marquee.x0, fmState.marquee.x1);
        const my0 = Math.min(fmState.marquee.y0, fmState.marquee.y1);
        const mx1 = Math.max(fmState.marquee.x0, fmState.marquee.x1);
        const my1 = Math.max(fmState.marquee.y0, fmState.marquee.y1);
        let changed = false;
        fmState.boxes.forEach((b) => {
          const cx = b.x + b.w / 2;
          const cy = b.y + b.h / 2;
          if (cx >= mx0 && cx <= mx1 && cy >= my0 && cy <= my1) {
            b.label = fmState.activeLabelCat;
            changed = true;
          }
        });
        fmState.marquee = null;
        if (changed) fmPushHistory();
        fmRenderBottomCategories();
        fmRenderCanvas();
      }
      fmDragMode = null;
    });

    fmVp.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 12 : -12;
        fmState.zoom = Math.max(35, Math.min(350, fmState.zoom + delta));
        fmRenderCanvas();
      },
      { passive: false }
    );
  }

  // =========================================================================
  // Boot Application
  // =========================================================================
  function buildHomeExampleCards() {
    const grid = document.getElementById('examplesShowcaseGrid');
    if (!grid || !window.HANDWRITE_EXAMPLES) return;
    grid.innerHTML = '';

    const keys = Object.keys(window.HANDWRITE_EXAMPLES);
    keys.forEach((key) => {
      const ex = window.HANDWRITE_EXAMPLES[key];
      if (!ex || !ex.pages || !ex.pages[0]) return;

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'example-card';
      card.id = `btn_${key}`;
      card.title = `点击加载：${ex.title || ex.name}`;

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'example-card-thumb';

      const img = document.createElement('img');
      img.src = ex.pages[0].src;
      img.alt = ex.title || ex.name;

      const badge = document.createElement('span');
      badge.className = 'example-badge';
      badge.textContent = ex.badge || key;

      thumbWrap.append(img, badge);

      const titleEl = document.createElement('div');
      titleEl.className = 'example-card-title';
      titleEl.textContent = ex.title || ex.name;

      const descEl = document.createElement('div');
      descEl.className = 'example-card-desc';
      descEl.textContent = ex.desc || `${ex.pages.length}页 PDF 范例`;

      card.append(thumbWrap, titleEl, descEl);
      card.addEventListener('click', () => loadExample(key));
      grid.appendChild(card);
    });
  }

  async function init() {
    initAllNativeSliders();
    buildDualSliderSections();
    bindEvents();
    buildHomeExampleCards();

    if (window.DEFAULT_HANDWRITE_DATA) {
      document.getElementById('fmSamplePhotoImg').src = window.DEFAULT_HANDWRITE_DATA.sampleSheet;
      await loadFontFromData(window.DEFAULT_HANDWRITE_DATA);
    }

    showHomeView();

    // Optional URL parameter for quick preview / automated verification
    const params = new URLSearchParams(window.location.search);
    const demo = params.get('demo');
    if (demo && window.HANDWRITE_EXAMPLES && window.HANDWRITE_EXAMPLES[demo]) {
      await loadExample(demo);
      if (params.get('style')) {
        activeFontIndex = Math.min(fontsRegistry.length - 1, Math.max(0, Number(params.get('style'))));
        refreshFontSelectUI();
      }
      if (params.get('ink')) {
        state.config.inkColor = params.get('ink');
        syncAllControlsFromState();
      }
      if (params.get('page')) {
        state.currentPage = Math.max(1, Math.min(state.pages.length, Number(params.get('page'))));
        refreshPageNavUI();
      }
      if (params.get('zoom')) {
        state.zoom = Number(params.get('zoom'));
        state.panX = Number(params.get('panX') || -60);
        state.panY = Number(params.get('panY') || -20);
        updateStageTransform();
      }
      renderCurrentPage();
    } else if (demo === 'manual') {
      await loadExample('example3');
      openManualInputModal();
    } else if (demo && demo.startsWith('fontmaker')) {
      showFontMakerView();
      if (demo.includes('cn')) {
        fmSwitchPresetMode('chinese');
      } else if (demo.includes('en')) {
        fmSwitchPresetMode('english');
      }
      if (!demo.endsWith('0')) {
        const im = new Image();
        await new Promise((r) => {
          im.onload = r;
          im.src = fmGenerateSampleHandwritingPhoto(fmState.mode);
        });
        fmLoadImageAndStartStep1(im);
        if (demo.endsWith('2')) {
          fmSetStep(2);
        } else if (demo.endsWith('3')) {
          fmSetStep(2);
          document.getElementById('dialogNotice').close();
          fmSetStep(3);
          fmAutoLabelSequential();
        }
      }
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
