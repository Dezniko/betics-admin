// Runs before the stylesheet paints so the page never flashes the wrong theme.
(function () {
  var mode = 'auto';
  try { mode = localStorage.getItem('noir-admin-theme') || 'auto'; } catch (e) { /* private mode */ }
  var light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = mode === 'auto' ? (light ? 'light' : 'dark') : mode;
})();
