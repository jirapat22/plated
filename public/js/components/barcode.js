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
export function openBarcodeScanner(onScan) {
  if (typeof Html5Qrcode === 'undefined') {
    showToast('Barcode library not loaded', 'error');
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

    document.getElementById('scan-manual').addEventListener('click', () => {
      stopScanner();
      const barcode = prompt('Enter barcode number:');
      if (barcode?.trim()) {
        hideSheet();
        onScan(barcode.trim());
      }
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
        hideSheet();
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
      { facingMode: 'environment' },
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
        hideSheet();
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
