'use strict';
/**
 * Soft clamp horizontal overflow inside same-origin bridge iframe.
 */
(function (global) {
  function clampOverflow(doc, maxPasses) {
    if (!doc || !doc.documentElement) return { passes: 0, fixed: 0 };
    var fixed = 0;
    var passes = 0;
    var limit = maxPasses || 3;
    while (passes < limit) {
      passes++;
      var root = doc.documentElement;
      if (root.scrollWidth <= root.clientWidth + 4) break;
      var all = doc.body ? doc.body.querySelectorAll('*') : [];
      var vw = root.clientWidth || 360;
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        try {
          var r = el.getBoundingClientRect();
          if (r.width > vw + 8 || r.right > vw + 8) {
            el.style.maxWidth = '100%';
            el.style.minWidth = '0';
            if (el.style.width && /px/i.test(el.style.width)) el.style.width = 'auto';
            if (el.style.float) el.style.float = 'none';
            fixed++;
          }
        } catch (_) {}
      }
      if (root.scrollWidth <= root.clientWidth + 4) break;
    }
    return { passes: passes, fixed: fixed };
  }

  function runOnFrame(frame) {
    try {
      var doc = frame.contentDocument;
      if (!doc) return null;
      return clampOverflow(doc, 3);
    } catch (_) {
      return null;
    }
  }

  global.SoloLayoutGuard = { clampOverflow: clampOverflow, runOnFrame: runOnFrame };
})(typeof window !== 'undefined' ? window : globalThis);
