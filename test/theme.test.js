import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeThemePreference, resolveTheme } from '../src/theme.js';

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function themeTokens(selector) {
  const block = styles.match(new RegExp(`${selector}\\s*\\{([^}]+)\\}`))?.[1] || '';
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map(([, name, value]) => [name, value]));
}

function contrastRatio(foreground, background) {
  const luminance = (color) => {
    const channels = color.match(/[\da-f]{2}/gi).map((value) => parseInt(value, 16) / 255);
    const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

function assertContrast(foreground, background, minimum, label) {
  assert.ok(contrastRatio(foreground, background) >= minimum, `${label} must be at least ${minimum}:1`);
}

test('normalizes and resolves ON LIVE theme preferences', () => {
  assert.equal(normalizeThemePreference('dark'), 'dark');
  assert.equal(normalizeThemePreference('unexpected'), 'system');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('theme color pairs meet WCAG 2.2 AA contrast thresholds', () => {
  const light = themeTokens(':root');
  const dark = { ...light, ...themeTokens(':root\\[data-theme="dark"\\]') };
  const systemDark = { ...light, ...themeTokens(':root:not\\(\\[data-theme\\]\\)') };
  const selectionColor = styles.match(/::selection\s*\{[^}]*\bcolor:\s*(#[\da-f]{6})/i)?.[1];

  for (const [name, theme] of Object.entries({ light, dark, systemDark })) {
    for (const surface of ['page', 'panel', 'soft']) {
      assertContrast(theme.ink, theme[surface], 4.5, `${name} ink on ${surface}`);
      assertContrast(theme.muted, theme[surface], 4.5, `${name} muted on ${surface}`);
      assertContrast(theme['line-strong'], theme[surface], 3, `${name} strong line on ${surface}`);
    }
  }

  assertContrast(selectionColor, light.brand, 4.5, 'selected text on brand');
  assertContrast('#ffffff', light.live, 4.5, 'live badge text');
});
