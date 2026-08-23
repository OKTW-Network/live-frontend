export const THEME_STORAGE_KEY = 'onlive.theme';
export const THEME_OPTIONS = ['system', 'light', 'dark'];

export function normalizeThemePreference(value) {
  return THEME_OPTIONS.includes(value) ? value : 'system';
}

export function resolveTheme(preference, prefersDark = false) {
  const normalized = normalizeThemePreference(preference);
  if (normalized === 'system') return prefersDark ? 'dark' : 'light';
  return normalized;
}

export function applyThemePreference(preference, {
  documentImpl = globalThis.document,
  prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true,
} = {}) {
  const normalized = normalizeThemePreference(preference);
  const resolved = resolveTheme(normalized, prefersDark);
  const root = documentImpl?.documentElement;
  if (root) {
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  }
  documentImpl?.querySelector?.('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? '#0e0e10' : '#f7f7f8');
  return { preference: normalized, resolved };
}
