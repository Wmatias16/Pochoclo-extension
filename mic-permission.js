const statusEl = document.getElementById('status');

(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Permission granted — release the mic immediately
    stream.getTracks().forEach(t => t.stop());

    // Notify the extension that permission is granted
    await chrome.storage.local.set({ micPermissionGranted: true });

    statusEl.textContent = '✓ Permiso concedido. Podés cerrar esta pestaña.';
    statusEl.className = 'status ok';

    // Auto-close after a brief moment
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    statusEl.textContent = '✗ Permiso denegado. Habilitalo en la config del sitio.';
    statusEl.className = 'status err';
    await chrome.storage.local.set({ micPermissionGranted: false });
  }
})();
