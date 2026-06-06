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
  // html5-qrcode is loaded via CDN as a global
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
          <div class="scanner-corner tl"></div>
          <div class="scanner-corner tr"></div>
          <div class="scanner-corner bl"></div>
          <div class="scanner-corner br"></div>
        </div>
        <div id="scan-status" style="text-align:center;margin-top:12px;font-size:13px;color:var(--text-muted)">
          Point camera at a barcode (EAN-13, UPC-A)
        </div>
        <div style="margin-top:12px;text-align:center">
          <button class="btn btn-secondary" id="scan-manual" style="width:100%">Enter barcode manually</button>
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

    // Start scanner — use facingMode:'environment' directly; avoids the
    // getCameras() enumeration step that blocks on many browsers before
    // permission is granted and fails with exact deviceId constraints.
    scannerInstance = new Html5Qrcode('scanner-container');

    scannerInstance.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 160 } },
      (decodedText) => {
        stopScanner();
        hideSheet();
        onScan(decodedText);
      },
      () => { /* per-frame scan miss — ignore */ }
    ).catch(err => {
      const statusEl = document.getElementById('scan-status');
      if (!statusEl) return;
      if (err.name === 'NotAllowedError' || String(err).includes('Permission')) {
        statusEl.innerHTML = `
          <span style="color:var(--error)">Camera permission denied</span><br/>
          <span>Please allow camera access in your browser settings, then try again.</span>
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
