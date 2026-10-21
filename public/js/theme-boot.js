/**
 * Applies the saved theme before the first paint.
 *
 * This is a separate file (not an inline <script>) so the strict
 * Content-Security-Policy does not have to allow inline scripts.
 */
(function () {
  try {
    document.documentElement.dataset.theme = localStorage.getItem('ms_theme') || 'dark';
  } catch (err) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
