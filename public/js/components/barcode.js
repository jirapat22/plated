import { showToast, showSheet, hideSheet } from '../app.js';

let scannerInstance = null;

function stopScanner() {
  if (scannerInstance) {
    scannerInstance.stop().catch(() => {});
    scannerInstance = null;
  }
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
        <div id="scan-status" style="text-align:center;margin-top:10px;font-size:13px;color:var(--text-muted)">
          Hold barcode horizontally inside the box
        </div>
        <div style="margin-top:10px;text-align:center">
          <button class="btn btn-secondary" id="scan-manual" style="width:100%">Enter barcode number manually</button>
        </div>
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

    // Explicitly list barcode formats — without this the library may silently
    // skip EAN-13/UPC-A or perform poorly on linear barcodes.
    const formats = typeof Html5QrcodeSupportedFormats !== 'undefined'
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

    scannerInstance = new Html5Qrcode(
      'scanner-container',
      formats.length ? { formatsToSupport: formats } : {}
    );

    // qrbox as a function so the scan zone scales to whatever the container
    // renders at on the device. 85% wide × 44% tall = wide horizontal strip
    // that fits EAN-13/UPC-A barcodes without the user needing to step back.
    const qrboxFn = (w, h) => ({
      width:  Math.round(w * 0.85),
      height: Math.round(h * 0.44),
    });

    scannerInstance.start(
      { facingMode: 'environment' },
      {
        fps: 15,
        qrbox: qrboxFn,
        aspectRatio: 1.7778,   // 16:9 — fills the container cleanly
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
          <span>Allow camera access in browser settings, then try again.</span>
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
