// Light/dark theme. Follows the OS setting until the user picks one with the button at the top right;
// that choice is remembered in localStorage. Loaded in <head> so the theme is set before the first paint.
(() => {
  const KEY = 'mcp-master-tester.theme';
  const root = document.documentElement;
  const systemLight = matchMedia('(prefers-color-scheme: light)');
  const SUN = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2"/><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M3.05 12.95l1.13-1.13M11.82 4.18l1.13-1.13"/></svg>';
  const MOON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1z"/></svg>';

  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  } catch { /* storage blocked: follow the OS */ }

  const current = () => root.dataset.theme ?? (systemLight.matches ? 'light' : 'dark');

  function sync() {
    const btn = document.getElementById('themeBtn');
    if (!btn) return;
    const dark = current() === 'dark';
    btn.innerHTML = dark ? SUN : MOON; // show the theme a click switches to
    btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', btn.title);
  }

  systemLight.addEventListener('change', sync);
  addEventListener('DOMContentLoaded', () => {
    sync();
    document.getElementById('themeBtn')?.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch { /* not remembered, still applied */ }
      sync();
    });
  });
})();
