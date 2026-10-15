// window.downloadFeedback.run(fn): rulează o descărcare și arată utilizatorului că lucrează.
(() => {
  'use strict';
  let running = 0;
  let banner = null;

  function showBanner() {
    if (banner) return;
    banner = document.createElement('div');
    banner.setAttribute('role', 'status');
    banner.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:60;background:#0f172a;color:#fff;' +
      'padding:10px 16px;border-radius:12px;font:500 13px Inter,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);';
    banner.textContent = 'Se pregătește descărcarea… păstrează pagina deschisă.';
    document.body.append(banner);
  }

  function setBusy(busy) {
    document.querySelectorAll('[data-download-button]').forEach(button => {
      button.disabled = busy;
      if (busy) button.setAttribute('aria-busy', 'true');
      else button.removeAttribute('aria-busy');
    });
  }

  window.downloadFeedback = {
    async run(task) {
      running++;
      setBusy(true);
      showBanner();
      try {
        return await task();
      } finally {
        running--;
        if (running === 0) {
          setBusy(false);
          banner?.remove();
          banner = null;
        }
      }
    },
  };
})();
