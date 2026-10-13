import type { UiTheme } from './types';
import { el } from './el';

const THEME_KEY = 'ibh:theme';
const THEME_ORDER: readonly UiTheme[] = ['light', 'dark', 'system'];
const THEME_ICON: Record<UiTheme, string> = { light: '☀', dark: '☾', system: '◐' };

function readStoredTheme(): UiTheme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  } catch {
    return null;
  }
}

export interface ThemeInstall {
  setTheme(theme: UiTheme): void;
  dispose(): void;
}

/**
 * Panel theming: light / dark / system. `system` follows prefers-color-scheme
 * live. The resolved theme is applied to the HOST element (`data-ibh-theme`)
 * so the shadow-root CSS can react.
 */
export function installTheme(opts: {
  host: HTMLElement;
  btnTheme: HTMLButtonElement;
  initialTheme?: UiTheme;
}): ThemeInstall {
  const { host, btnTheme } = opts;
  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  let themePref: UiTheme = opts.initialTheme ?? readStoredTheme() ?? 'system';

  const applyTheme = () => {
    const resolved = themePref === 'system' ? (scheme.matches ? 'dark' : 'light') : themePref;
    host.setAttribute('data-ibh-theme', resolved);
    btnTheme.textContent = THEME_ICON[themePref];
    btnTheme.title = `Theme: ${themePref} (click to switch)`;
  };

  const onSchemeChange = () => {
    if (themePref === 'system') applyTheme();
  };
  scheme.addEventListener('change', onSchemeChange);

  btnTheme.addEventListener('click', () => {
    const next = (THEME_ORDER.indexOf(themePref) + 1) % THEME_ORDER.length;
    themePref = THEME_ORDER[next] ?? 'system';
    try {
      localStorage.setItem(THEME_KEY, themePref);
    } catch {
      /* private mode: theme just won't persist */
    }
    applyTheme();
  });

  applyTheme();

  return {
    setTheme(theme: UiTheme) {
      themePref = theme;
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch {
        /* private mode */
      }
      applyTheme();
    },
    dispose: () => scheme.removeEventListener('change', onSchemeChange),
  };
}

export function makeThemeButton(): HTMLButtonElement {
  const btnTheme = el('button', 'icon-btn');
  btnTheme.title = 'Theme';
  return btnTheme;
}
