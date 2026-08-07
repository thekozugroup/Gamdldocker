/*
 * Resolves the theme before the browser paints.
 *
 * v1 hard-coded class="dark" on <html> and then corrected it from localStorage
 * inside a useEffect, so anyone on the light theme saw a dark flash on every
 * load. A blocking inline script in <head> is the only way to get this right;
 * it is small, has no dependencies, and runs before first paint.
 */

const SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('theme-mode');
    var mode = (stored === 'light' || stored === 'dark' || stored === 'system') ? stored : 'system';
    var dark = mode === 'dark' ||
      (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) {
    // Private-mode browsers can throw on localStorage. The default styling is
    // light, which is a fine place to land.
  }
})();
`

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
}
