
// app.js — keypad overlay, viewport-sync, calibration + long-press 0 -> +
// Added: request persistent storage (iOS 17+), robust SW registration.

// ---- Storage API: request persistent storage (best effort) ----
(async () => {
  if (navigator.storage && navigator.storage.persist) {
    try {
      // Optional: check current mode
      if (navigator.storage.persisted) {
        try {
          const already = await navigator.storage.persisted();
          console.debug('Storage persisted already:', already);
        } catch (e) {}
      }
      const granted = await navigator.storage.persist();
      console.debug('Persistent storage requested:', granted);
    } catch (e) {
      console.warn('Storage persist request failed', e);
    }
  }
})();

// ---- Service Worker registration with immediate activation/update ----
(function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    const swUrl = new URL('service-worker.js', location.href).toString();
    navigator.serviceWorker.register(swUrl, { scope: './' })
      .then((reg) => {
        // Force activate updated SWs quickly
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              try { sw.postMessage({ type: 'SKIP_WAITING' }); } catch (e) {}
            }
          });
        });
      })
      .catch((err) => console.warn('SW register failed', err));

    // When the new SW activates, reload to ensure it's controlling the page
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Avoid loops by reloading once
      if (!window.__reloadedBySW) {
        window.__reloadedBySW = true;
        window.location.reload();
      }
    });
  });
})();

// ---- Existing app code (unchanged from your file below) ----
(() => {
  const displayEl = document.getElementById('display');
  const keysGrid = document.getElementById('keysGrid');
  const callBtn = document.getElementById('callBtn');
  const appEl = document.getElementById('app');
  const calUI = document.getElementById('calibrationUI');
  const calText = document.getElementById('calText');

  let digits = '';
  let longPressTimer = null;
  let longPressActive = false;
  const LONG_PRESS_MS = 300;
  const STORAGE_KEY = 'overlay-calibration-screenshot-v3';
  let calibration = { x: 0, y: 0 };

  const ORIGINAL_BG = "url('screenshot.png')";
  const FIRST_TYPED_BG = "url('numpad.png')";

  (function preloadReplacementImage() {
    try {
      const img = new Image();
      img.onload = () => console.debug('numpad.png preloaded');
      img.onerror = () => console.warn('numpad.png preload failed');
      img.src = 'numpad.png';
    } catch (e) { console.warn('preload fail', e); }
  })();

  /* ---------- Viewport sync ---------- */
  (function setupViewportSync() {
    function updateViewportHeight() {
      try {
        const vv = window.visualViewport;
        const base = vv ? Math.round(vv.height) : window.innerHeight;
        const overfill = 8;
        const used = Math.max(100, base + overfill);
        document.documentElement.style.setProperty('--app-viewport-height', used + 'px');
        const ls = document.querySelector('.lockscreen');
        if (ls) ls.style.height = used + 'px';
        document.body.style.height = used + 'px';
      } catch (err) { console.warn('viewport sync failed', err); }
    }
    window.addEventListener('load', updateViewportHeight, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewportHeight, { passive: true });
      window.visualViewport.addEventListener('scroll', updateViewportHeight, { passive: true });
    }
    window.addEventListener('resize', updateViewportHeight, { passive: true });
    window.addEventListener('orientationchange', updateViewportHeight, { passive: true });
    updateViewportHeight();
    let t = 0;
    const id = setInterval(() => { updateViewportHeight(); t++; if (t > 20) clearInterval(id); }, 120);
  })();

  /* ---------- Calibration persistence ---------- */
  function loadCalibration() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        calibration = JSON.parse(raw);
        setCalibrationVars();
      }
    } catch (e) {}
  }
  function saveCalibration() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(calibration)); } catch(e) {}
  }
  function setCalibrationVars() {
    document.documentElement.style.setProperty('--overlay-offset-x', (calibration.x || 0) + 'px');
    document.documentElement.style.setProperty('--overlay-offset-y', (calibration.y || 0) + 'px');
  }

  /* ---------- Standalone / PWA detection ---------- */
  function detectStandalone() {
    const isIOSStandalone = window.navigator.standalone === true;
    const isDisplayModeStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    if (isIOSStandalone || isDisplayModeStandalone) {
      appEl.classList.add('standalone');
      document.documentElement.classList.add('is-pwa');
    } else {
      appEl.classList.remove('standalone');
      document.documentElement.classList.remove('is-pwa');
    }
  }
  detectStandalone();
  if (window.matchMedia) {
    try {
      const mq = window.matchMedia('(display-mode: standalone)');
      if (mq && mq.addEventListener) mq.addEventListener('change', detectStandalone);
      else if (mq && mq.addListener) mq.addListener(detectStandalone);
    } catch (e) {}
  }

  /* ---------- Display helpers ---------- */
  function updateDisplay() {
    if (!displayEl) return;
    if (digits.length === 0) {
      displayEl.style.opacity = '0';
      displayEl.textContent = '';
    } else {
      displayEl.style.opacity = '1';
      displayEl.textContent = digits;
    }
  }

  function onFirstCharTyped() {
    try { appEl.style.backgroundImage = FIRST_TYPED_BG; } catch(e) {}
  }

  function appendChar(ch) {
    if (digits.length >= 200) return;
    const wasEmpty = digits.length === 0;
    digits += ch;
    updateDisplay();
    if (wasEmpty) onFirstCharTyped();
  }
  function clearDigits() {
    digits = '';
    updateDisplay();
    try { appEl.style.backgroundImage = ORIGINAL_BG; } catch(e){}
  }
  function doVibrate() { if (navigator.vibrate) try { navigator.vibrate(8); } catch(e){} }

  /* ---------- SVG sanitization with bbox-based background removal ---------- */
  function sanitizeInjectedSVG(svg) {
    if (!svg) return;
    try {
      svg.querySelectorAll('metadata, desc, defs, title').forEach(el => el.remove());
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.setAttribute('focusable', 'false');
      svg.style.display = 'inline-block';

      let svgW = 0, svgH = 0;
      if (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width && svg.viewBox.baseVal.height) {
        svgW = svg.viewBox.baseVal.width;
        svgH = svg.viewBox.baseVal.height;
      } else {
        const vb = svg.getAttribute('viewBox');
        if (vb) {
          const parts = vb.trim().split(/\s+/).map(Number);
          if (parts.length === 4) { svgW = parts[13]; svgH = parts[14]; }
        }
      }
      if (!svgW || !svgH) {
        try {
          const sbb = svg.getBBox();
          svgW = sbb.width || svgW;
          svgH = sbb.height || svgH;
        } catch (e) {}
      }
      if (!svgW) svgW = 100;
      if (!svgH) svgH = 100;

      const shapeSelector = 'path, rect, circle, ellipse, polygon, polyline';
      const shapes = Array.from(svg.querySelectorAll(shapeSelector));
      const THRESHOLD = 0.9;
      shapes.forEach(el => {
        try {
          const bb = el.getBBox();
          const wRatio = (bb.width / svgW);
          const hRatio = (bb.height / svgH);
          if (wRatio >= THRESHOLD && hRatio >= THRESHOLD) {
            el.remove();
            return;
          }
        } catch (e) {}
      });

      svg.querySelectorAll('[id*="bg"], [class*="bg"], [id*="background"], [class*="background"]').forEach(el => el.remove());

      svg.querySelectorAll('*').forEach(el => {
        if (el.tagName.toLowerCase() === 'svg') return;
        try {
          el.setAttribute('fill', 'currentColor');
          el.setAttribute('stroke', 'none');
          el.style.vectorEffect = 'non-scaling-stroke';
        } catch (e) {}
      });

    } catch (err) {
      console.warn('sanitizeInjectedSVG failed', err);
    }
  }

  /* ---------- Template injection ---------- */
  function injectSVGFromTemplate(templateId, keySelector, spanClass) {
    try {
      const tpl = document.getElementById(templateId);
      const keyEl = keysGrid.querySelector(`.key[data-value="${keySelector}"]`);
      if (!tpl || !keyEl) return;
      const span = keyEl.querySelector('.digit');
      if (!span) return;

      if (!tpl.content || tpl.content.childElementCount === 0) {
        span.classList.add(spanClass || '');
        return;
      }

      const clone = tpl.content.cloneNode(true);
      span.textContent = '';
      span.appendChild(clone);
      span.classList.add(spanClass || '');

      const svg = span.querySelector('svg');
      sanitizeInjectedSVG(svg);

    } catch (err) {
      console.warn('injectSVGFromTemplate failed', err);
    }
  }

  /* ---------- Helper: briefly highlight a key visually ---------- */
  const FLASH_MS = 360; // >= 300ms so fade visible
  function flashKey(value, ms = FLASH_MS) {
    const keyEl = keysGrid.querySelector(`.key[data-value="${value}"]`);
    if (!keyEl) return;
    keyEl.classList.add('pressed');
    setTimeout(() => keyEl.classList.remove('pressed'), ms);
  }

  /* ---------- Keys setup & press behavior ---------- */
  function setupKeys() {
    if (!keysGrid) return;

    injectSVGFromTemplate('svg-asterisk-template', '*', 'digit-asterisk');
    injectSVGFromTemplate('svg-hash-template', '#', 'digit-hash');

    keysGrid.querySelectorAll('.key').forEach(key => {
      const value = key.dataset.value;

      key.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        try { key.setPointerCapture(ev.pointerId); } catch(e){}
        key.style.transition = 'none';
        key.classList.add('pressed');
        void key.offsetHeight;
        key.style.transition = '';
        doVibrate();
        longPressActive = false;

        if (value === '0') {
          longPressTimer = setTimeout(() => {
            longPressActive = true;
            appendChar('+');
          }, LONG_PRESS_MS);
        }
      });

      key.addEventListener('pointerup', (ev) => {
        ev.preventDefault();
        try { key.releasePointerCapture(ev.pointerId); } catch(e){}
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (!longPressActive) {
          if (key.dataset.value !== 'paste') appendChar(value);
        }
        longPressActive = false;
        setTimeout(() => { key.classList.remove('pressed'); }, 10);
      });

      key.addEventListener('pointerleave', (ev) => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        key.classList.remove('pressed');
        longPressActive = false;
      });

      key.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { if (!ev.repeat) { ev.preventDefault(); key.classList.add('pressed'); } }
      });
      key.addEventListener('keyup', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          key.classList.remove('pressed');
          if (key.dataset.value === 'paste') {
            runClipboardTypeSequence();
          } else {
            appendChar(value);
          }
        }
      });
    });
  }

  /* ---------- Call button ---------- */
  if (callBtn) {
    callBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (!digits || digits.length === 0) {
        callBtn.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.96)' }, { transform: 'scale(1)' }], { duration: 220 });
        return;
      }
      const sanitized = digits.replace(/[^\d+#*]/g, '');
      window.location.href = 'tel:' + sanitized;
    });
  }

  /* ---------- Clipboard play button: insertion + behavior ---------- */
  let typingInProgress = false;
  let typingAbort = false;

  const FIRST_DELAY_MS = 10000;    // 10s before FIRST char
  const INTER_DELAY_MS  = 500;     // 0.5s between subsequent chars

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  async function waitUntil(ms) {
    const CHUNK = 100;
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (typingAbort) break;
      await delay(CHUNK);
    }
  }

  async function runClipboardTypeSequence() {
    if (typingInProgress) { typingAbort = true; return; }

    let raw = '';
    try {
      raw = await navigator.clipboard.readText();
      console.debug('Clipboard read:', raw);
    } catch (err) {
      console.warn('Clipboard read failed or denied; aborting automatic typing.', err);
      return;
    }

    raw = (raw || '').trim();
    if (!raw) {
      const pb = document.getElementById('pasteBtn');
      if (pb) try { pb.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.96)' }, { transform: 'scale(1)' }], { duration: 200 }); } catch(e){}
      return;
    }

    const toType = raw.replace(/[^\d+]/g, '');
    if (!toType) return;

    typingInProgress = true;
    typingAbort = false;

    const pasteBtn = document.getElementById('pasteBtn');
    if (pasteBtn) pasteBtn.classList.add('active');

    // initial wait
    await waitUntil(FIRST_DELAY_MS);
    if (typingAbort) { typingInProgress = false; typingAbort = false; if (pasteBtn) pasteBtn.classList.remove('active'); return; }

    const chars = Array.from(toType);
    for (let i = 0; i < chars.length; i++) {
      if (typingAbort) break;
      const ch = chars[i];
      flashKey(ch);
      appendChar(ch);

      if (i < chars.length - 1) {
        await waitUntil(INTER_DELAY_MS);
        if (typingAbort) break;
      }
    }

    typingInProgress = false;
    typingAbort = false;
    if (pasteBtn) pasteBtn.classList.remove('active');
  }

  /* ---------- Insert invisible paste button into hash slot (unchanged) ---------- */
  function insertInvisiblePasteButtonIntoHashSlot() {
    if (!keysGrid) return;
    const oldHash = keysGrid.querySelector('.key[data-value="#"]');

    const btn = document.createElement('button');
    btn.className = 'key';
    btn.setAttribute('aria-label', 'Paste from clipboard');
    btn.setAttribute('title', 'Paste & play');
    btn.dataset.value = 'paste';
    btn.id = 'pasteBtn';
    btn.innerHTML = '<span class="digit">▶</span><span class="letters"></span>';

    // invisible but interactive
    btn.style.background = 'transparent';
    btn.style.color = 'transparent';
    btn.style.border = 'none';
    btn.style.boxShadow = 'none';
    btn.style.opacity = '0';
    btn.style.pointerEvents = 'auto';
    btn.style.outline = 'none';
    btn.setAttribute('aria-hidden', 'false');

    if (oldHash && oldHash.parentNode) {
      oldHash.parentNode.replaceChild(btn, oldHash);
    } else {
      keysGrid.appendChild(btn);
    }

    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      console.debug('Paste button clicked (user gesture).');
      runClipboardTypeSequence();
    });

    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        btn.classList.add('pressed');
      }
    });
    btn.addEventListener('keyup', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        btn.classList.remove('pressed');
        runClipboardTypeSequence();
      }
    });
  }

  /* ---------- Insert delete button directly below the paste button (invisible by default) ---------- */
  let deleteBtn = null;
  function createDeleteButton() {
    if (document.getElementById('deleteBtn')) return;

    deleteBtn = document.createElement('button');
    deleteBtn.id = 'deleteBtn';
    deleteBtn.className = 'key delete-key';
    deleteBtn.dataset.value = 'delete';
    deleteBtn.setAttribute('aria-label', 'Delete digit');
    deleteBtn.setAttribute('title', 'Delete digit');
    deleteBtn.innerHTML = '<span class="digit">⌫</span><span class="letters"></span>';

    // absolutely position inside appEl so it sits below the paste slot.
    deleteBtn.style.position = 'absolute';
    deleteBtn.style.zIndex = 55;
    // invisible by default but interactive
    deleteBtn.style.background = 'transparent';
    deleteBtn.style.color = 'transparent';
    deleteBtn.style.border = 'none';
    deleteBtn.style.boxShadow = 'none';
    deleteBtn.style.opacity = '0';
    deleteBtn.style.pointerEvents = 'auto';
    deleteBtn.style.outline = 'none';
    // keep it accessible
    deleteBtn.setAttribute('aria-hidden', 'false');

    // event listeners to delete a single digit
    deleteBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      runDeleteOnce();
    });
    deleteBtn.addEventListener('pointerdown', (ev) => {
      try { deleteBtn.setPointerCapture(ev.pointerId); } catch (e) {}
      deleteBtn.classList.add('pressed');
    });
    deleteBtn.addEventListener('pointerup', (ev) => {
      try { deleteBtn.releasePointerCapture(ev.pointerId); } catch (e) {}
      setTimeout(()=> deleteBtn.classList.remove('pressed'), 10);
    });
    deleteBtn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); deleteBtn.classList.add('pressed'); }
    });
    deleteBtn.addEventListener('keyup', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); deleteBtn.classList.remove('pressed'); runDeleteOnce(); }
    });

    appEl.appendChild(deleteBtn);
    positionDeleteButtonUnderPaste();
  }

  function runDeleteOnce() {
    if (!digits || digits.length === 0) {
      if (deleteBtn) {
        try { deleteBtn.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.96)' }, { transform: 'scale(1)' }], { duration: 180 }); } catch(e){}
      }
      return;
    }
    digits = digits.slice(0, -1);
    updateDisplay();
    if (digits.length === 0) {
      try { appEl.style.backgroundImage = ORIGINAL_BG; } catch(e){}
    }
  }

  function positionDeleteButtonUnderPaste() {
    const pasteBtn = document.getElementById('pasteBtn');
    const del = document.getElementById('deleteBtn');
    if (!pasteBtn || !del) return;

    const pasteRect = pasteBtn.getBoundingClientRect();
    const appRect = appEl.getBoundingClientRect();

    const width = pasteRect.width;
    const height = pasteRect.height;
    const gap = 8;

    const left = pasteRect.left - appRect.left;
    const top  = pasteRect.bottom - appRect.top + gap;

    del.style.width = width + 'px';
    del.style.height = height + 'px';
    del.style.left = Math.round(left) + 'px';
    del.style.top  = Math.round(top)  + 'px';

    try {
      const root = getComputedStyle(document.documentElement);
      const digitSize = root.getPropertyValue('--digit-size') || '36px';
      const span = del.querySelector('.digit');
      if (span) span.style.fontSize = digitSize.trim();
    } catch (e) {}
  }

  function watchAndRepositionDeleteBtn() {
    let tid = null;
    function schedule() {
      if (tid) clearTimeout(tid);
      tid = setTimeout(positionDeleteButtonUnderPaste, 80);
    }
    window.addEventListener('resize', schedule);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', schedule);
      window.visualViewport.addEventListener('scroll', schedule);
    }
    window.addEventListener('orientationchange', schedule);
    let attempts = 0;
    const id = setInterval(() => { positionDeleteButtonUnderPaste(); attempts++; if (attempts > 20) clearInterval(id); }, 120);
  }

  /* ---------- Keyboard events + calibration toggle ---------- */
  let calibrationMode = false;
  function enterCalibration() {
    calibrationMode = true;
    calUI.classList.add('show');
    calText.textContent = `Calibration: x=${calibration.x}px y=${calibration.y}px — arrow keys to nudge. Enter save, Esc cancel.`;
    calUI.setAttribute('aria-hidden', 'false');
  }
  function exitCalibration(save) {
    calibrationMode = false;
    calUI.classList.remove('show');
    calUI.setAttribute('aria-hidden', 'true');
    if (save) saveCalibration();
    else { loadCalibration(); setCalibrationVars(); }
  }
  function adjustCalibration(dir) {
    const step = 2;
    if (dir === 'up') calibration.y -= step;
    if (dir === 'down') calibration.y += step;
    if (dir === 'left') calibration.x -= step;
    if (dir === 'right') calibration.x += step;
    setCalibrationVars();
    calText.textContent = `Calibration: x=${calibration.x}px y=${calibration.y}px — arrow keys to nudge. Enter save, Esc cancel.`;
  }

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'c' || ev.key === 'C') {
      if (!calibrationMode) enterCalibration(); else exitCalibration(true);
      return;
    }

    if (calibrationMode) {
      if (ev.key === 'ArrowUp') { ev.preventDefault(); adjustCalibration('up'); }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); adjustCalibration('down'); }
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); adjustCalibration('left'); }
      if (ev.key === 'ArrowRight') { ev.preventDefault(); adjustCalibration('right'); }
      if (ev.key === 'Enter') { ev.preventDefault(); saveCalibration(); exitCalibration(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); exitCalibration(false); }
      return;
    }

    if (ev.key >= '0' && ev.key <= '9') appendChar(ev.key);
    else if (ev.key === '+' || ev.key === '*' || ev.key === '#') appendChar(ev.key);
    else if (ev.key === 'Backspace') {
      digits = digits.slice(0, -1);
      updateDisplay();
      if (digits.length === 0) { try { appEl.style.backgroundImage = ORIGINAL_BG; } catch(e){} }
    }
  });

  // bottom nav taps (visual only)
  document.querySelectorAll('.bottom-nav .nav-item').forEach((el, idx) => {
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      el.classList.add('pressed');
      setTimeout(()=>el.classList.remove('pressed'), 160);
    });
  });

  // init
  loadCalibration();
  detectStandalone();
  setupKeys();

  // Insert paste button and delete button (delete is invisible by default)
  insertInvisiblePasteButtonIntoHashSlot();
  createDeleteButton();
  watchAndRepositionDeleteBtn();

  updateDisplay();

  document.addEventListener('click', () => { try { document.activeElement.blur(); } catch(e){} });

  // API
  window.__phoneKeypad = {
    append: (ch) => { appendChar(ch); },
    clear: clearDigits,
    getDigits: () => digits,
    isStandalone: () => appEl.classList.contains('standalone'),
    calibration: () => ({...calibration}),
    runClipboardTypeSequence: runClipboardTypeSequence,
    cancelTyping: () => { typingAbort = true; },
    showDeleteBtn: () => {
      const d = document.getElementById('deleteBtn');
      if (!d) return;
      d.style.opacity = '1';
      d.style.background = 'var(--key-fill)';
      d.style.color = 'var(--letters-color)';
      d.style.boxShadow = '0 6px 18px rgba(0,0,0,0.25)';
    },
    hideDeleteBtn: () => {
      const d = document.getElementById('deleteBtn');
      if (!d) return;
      d.style.opacity = '0';
      d.style.background = 'transparent';
      d.style.color = 'transparent';
      d.style.boxShadow = 'none';
    }
  };
})();
