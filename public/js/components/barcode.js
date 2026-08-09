import { showToast, showSheet, hideSheet } from '../app.js';

let scannerInstance = null;

function stopScanner() {
  if (scannerInstance) {
    scannerInstance.stop().catch(() => {});
    scannerInstance = null;
  }
}

// Barcode formats to decode. Without this the library may silently skip
// EAN-13/UPC-A or perform poorly on linear barcodes.
function supportedFormats() {
  return typeof Html5QrcodeSupportedFormats !== 'undefined'
    ? [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.ITF,
      ]
    : [];
}

/**
 * Opens the barcode scanner in a bottom sheet.
 * Calls onScan(barcode) on a successful read.
 */
// 375kb fetched the first time you actually open the scanner, instead of on
// every cold start for a button most launches never touch.
// ponytail: a <script> tag, not a module import — the library ships as a UMD
// global. A failed load resets the promise so the next tap retries.
let libPromise = null;
function ensureScannerLib() {
  if (typeof Html5Qrcode !== 'undefined') return Promise.resolve(true);
  return libPromise ??= new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
    // See the note in trends.js: without SRI a hijacked CDN gets to run
    // arbitrary JS here with full access to the session token. Version-pinned
    // URL, so the bytes are immutable. A mismatch falls through onerror to
    // "Couldn't load the scanner", and the next tap retries.
    s.integrity = 'sha384-c9d8RFSL+u3exBOJ4Yp3HUJXS4znl9f+z66d1y54ig+ea249SpqR+w1wyvXz/lk+';
    s.crossOrigin = 'anonymous';   // real error details, not "Script error."
    s.onload  = () => resolve(true);
    s.onerror = () => { libPromise = null; resolve(false); };
    document.head.appendChild(s);
  });
}

export async function openBarcodeScanner(onScan) {
  showToast('Starting camera…', 'info');
  if (!await ensureScannerLib()) {
    showToast("Couldn't load the scanner — check your connection", 'error');
    return;
  }

  showSheet(content => {
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">Scan Barcode</span>
        <button class="sheet-close" id="scan-close">✕</button>
      </div>
      <div style="padding:0 16px 16px">
        <div class="scanner-wrap" id="scanner-container">
          <div class="scanner-rail"></div>
        </div>
        <!-- Hidden element used only for decoding a captured photo -->
        <div id="scanner-file" style="display:none"></div>
        <div id="scan-status" style="text-align:center;margin-top:10px;font-size:13px;color:var(--text-muted)">
          Hold barcode horizontally inside the box
        </div>
        <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
          <button class="btn btn-primary" id="scan-photo" style="width:100%">📷 Trouble scanning? Take a photo</button>
          <button class="btn btn-secondary" id="scan-manual" style="width:100%">Enter barcode number manually</button>
        </div>
        <input type="file" id="scan-file-input" accept="image/*" capture="environment" style="display:none" />
      </div>
    `;

    document.getElementById('scan-close').addEventListener('click', () => {
      stopScanner();
      hideSheet();
    });

    // Tapping the backdrop closes the sheet through showSheet's own handler,
    // which knows nothing about the camera. Without this the stream stays live
    // — indicator light on, battery draining — and the next scan builds a
    // second decoder over a container that no longer exists.
    document.getElementById('sheet-overlay')
      .addEventListener('click', stopScanner, { once: true });

    document.getElementById('scan-manual').addEventListener('click', () => {
      stopScanner();
      const barcode = prompt('Enter barcode number:');
      // onScan re-opens its own sheet, so don't hideSheet() here (that would
      // clear the freshly-shown content after its close animation).
      if (barcode?.trim()) onScan(barcode.trim());
    });

    // ── Photo capture fallback ───────────────────────────────────
    // On iOS the live video decoder is unreliable for 1D barcodes, but the
    // native camera produces a sharp, focused still that decodes far better.
    const fileInput = document.getElementById('scan-file-input');
    document.getElementById('scan-photo').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const statusEl = document.getElementById('scan-status');
      if (statusEl) statusEl.textContent = 'Reading photo…';

      const formats = supportedFormats();
      const fileScanner = new Html5Qrcode(
        'scanner-file',
        formats.length ? { formatsToSupport: formats } : {}
      );
      try {
        const decodedText = await fileScanner.scanFile(file, false);
        stopScanner();
        onScan(decodedText);
      } catch {
        if (statusEl) {
          statusEl.innerHTML = `
            <span style="color:var(--warning)">Couldn't read that photo.</span><br/>
            <span>Fill the frame with the barcode, hold steady, then retake — or enter it manually.</span>
          `;
        }
      } finally {
        try { await fileScanner.clear(); } catch { /* ignore */ }
        fileInput.value = ''; // allow re-picking the same file
      }
    });

    // ── Live video scan ──────────────────────────────────────────
    const formats = supportedFormats();
    scannerInstance = new Html5Qrcode(
      'scanner-container',
      {
        ...(formats.length ? { formatsToSupport: formats } : {}),
        // Use the platform's native BarcodeDetector when available (much faster
        // and more reliable on Android/Chrome). No-op where unsupported (iOS).
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      }
    );

    scannerInstance.start(
      // Request a high-res rear stream — more pixels on the barcode greatly
      // improves 1D decoding on phones.
      { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      {
        fps: 15,
        aspectRatio: 1.7778,   // 16:9 — fills the container cleanly
        // No qrbox: html5-qrcode draws ITS OWN shaded scan-region overlay
        // sized to whatever qrbox returns, and that region is the only area
        // it actually decodes. A small fixed sub-region forces the whole
        // barcode (plus quiet zones) to fit inside a tiny box at exactly the
        // right distance — which is what made every scan fail. Scanning the
        // full frame removes that constraint; `.scanner-rail` below is purely
        // a visual aiming aid and doesn't limit what gets decoded.
      },
      (decodedText) => {
        stopScanner();
        onScan(decodedText);
      },
      () => { /* per-frame miss — normal, ignore */ }
    ).catch(err => {
      const statusEl = document.getElementById('scan-status');
      if (!statusEl) return;
      if (err.name === 'NotAllowedError' || String(err).includes('Permission')) {
        statusEl.innerHTML = `
          <span style="color:var(--error)">Camera permission denied</span><br/>
          <span>Allow camera access in browser settings, or use “Take a photo” above.</span>
        `;
      } else {
        const msg = document.createElement('span');
        msg.style.color = 'var(--error)';
        msg.textContent = err.message || String(err);
        statusEl.innerHTML = '';
        statusEl.appendChild(msg);
      }
    });
  });
}
