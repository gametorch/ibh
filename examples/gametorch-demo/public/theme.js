/* GameTorch demo theme: light / dark / system (default = system).
 * Loaded in <head> BEFORE the stylesheet so the resolved theme is applied
 * before first paint (no flash of the wrong theme).
 */
(function () {
  var KEY = 'ibh-demo-theme';
  var mq = window.matchMedia('(prefers-color-scheme: dark)');

  function pref() {
    var v = null;
    try {
      v = localStorage.getItem(KEY);
    } catch {
      /* private mode */
    }
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  }

  function resolved(p) {
    return p === 'system' ? (mq.matches ? 'dark' : 'light') : p;
  }

  function apply() {
    var p = pref();
    document.documentElement.dataset.theme = resolved(p);
    // The demo app (and the ibh panel it hosts) listen for this.
    window.dispatchEvent(new CustomEvent('demo:theme-changed', { detail: { pref: p, resolved: resolved(p) } }));
  }

  mq.addEventListener('change', function () {
    if (pref() === 'system') apply();
  });

  apply();

  function wire() {
    var pickers = document.querySelectorAll('.theme-picker');
    pickers.forEach(function (picker) {
      if (picker.dataset.wired === '1') return;
      picker.dataset.wired = '1';
      var buttons = picker.querySelectorAll('button[data-theme-opt]');
      var sync = function () {
        var p = pref();
        buttons.forEach(function (b) {
          var active = b.dataset.themeOpt === p;
          b.classList.toggle('active', active);
          b.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
      };
      buttons.forEach(function (b) {
        b.addEventListener('click', function () {
          try {
            localStorage.setItem(KEY, b.dataset.themeOpt);
          } catch {
            /* private mode */
          }
          apply();
          sync();
        });
      });
      sync();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
