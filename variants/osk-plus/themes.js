// Colour palettes and the stylesheet built from them. Every rule is scoped to
// the keyboard's .osk-plus class, so nothing else in the shell is affected.
import GLib from 'gi://GLib';

export const ACCENTS = {
    desktop: null,
    mauve: '#cba6f7', blue: '#89b4fa', sapphire: '#74c7ec', teal: '#94e2d5',
    green: '#a6e3a1', peach: '#fab387', red: '#f38ba8', pink: '#f5c2e7',
};

// bg: keyboard; key: letters; fn: function keys; text; accent (null = desktop's).
export const THEMES = {
    desktop: {name: 'Desktop'},
    mocha: {name: 'Mocha', bg: '#1e1e2e', key: '#313244', fn: '#45475a', text: '#cdd6f4'},
    macchiato: {name: 'Macchiato', bg: '#24273a', key: '#363a4f', fn: '#494d64', text: '#cad3f5'},
    frappe: {name: 'Frappé', bg: '#303446', key: '#414559', fn: '#51576d', text: '#c6d0f5'},
    latte: {name: 'Latte', bg: '#dce0e8', key: '#eff1f5', fn: '#ccd0da', text: '#4c4f69', light: true},
    graphite: {name: 'Graphite', bg: '#202124', key: '#3c4043', fn: '#2d2f31', text: '#e8eaed'},
    paper: {name: 'Paper', bg: '#e8eaed', key: '#ffffff', fn: '#d2d5da', text: '#202124', light: true},
    oled: {name: 'Black', bg: '#000000', key: '#161616', fn: '#242424', text: '#f2f2f2'},
};

const MOCHA_ACCENT = '#cba6f7';

function hex(rgb) {
    return `#${rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function rgb(hexColour) {
    const n = parseInt(hexColour.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a, b, t) {
    const [x, y] = [rgb(a), rgb(b)];
    return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hexColour) {
    const [r, g, b] = rgb(hexColour).map(v => v / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function readDconf(key) {
    try {
        const [ok, out] = GLib.spawn_command_line_sync(`dconf read /org/gnome/shell/extensions/openbar/${key}`);
        const text = ok ? new TextDecoder().decode(out) : '';
        const values = [...text.matchAll(/[\d.]+/g)].map(m => Number(m[0]));
        return values.length >= 3 ? hex(values.slice(0, 3)) : null;
    } catch {
        return null;
    }
}

// The desktop's own colours, from the Open Bar panel settings when present.
export function desktopPalette() {
    const bg = readDconf('dark-bgcolor') ?? readDconf('bgcolor');
    const key = readDconf('dark-smbgcolor') ?? readDconf('smbgcolor');
    const text = readDconf('dark-fgcolor') ?? readDconf('fgcolor');
    const accent = readDconf('dark-accent-color') ?? readDconf('accent-color');
    const base = THEMES.mocha;
    const palette = {
        bg: bg ?? base.bg,
        key: key ?? base.key,
        text: text ?? base.text,
        accent: accent ?? MOCHA_ACCENT,
    };
    palette.fn = mix(palette.key, palette.text, 0.1);
    palette.light = luminance(palette.bg) > 0.5;
    return palette;
}

export function resolvePalette(settings) {
    const desktop = desktopPalette();
    const theme = settings.theme === 'desktop' || !THEMES[settings.theme] ? desktop : {...THEMES[settings.theme]};
    theme.accent = ACCENTS[settings.accent] ?? desktop.accent;
    theme.onAccent = luminance(theme.accent) > 0.45 ? '#11111b' : '#ffffff';
    theme.press = mix(theme.key, theme.text, 0.18);
    theme.subtle = mix(theme.bg, theme.text, 0.55);
    return theme;
}

export function stylesheet(p) {
    return `
#keyboard.osk-plus { background-color: ${p.bg}; padding: 0 4px 6px 4px; }
.osk-plus .key-container { padding: 3px; }
.osk-plus .keyboard-key, .osk-plus .keyboard-key:focus, .osk-plus .keyboard-key:hover,
.osk-plus .keyboard-key.default-key, .osk-plus .keyboard-key.default-key:hover {
  background-color: ${p.key}; color: ${p.text}; border-width: 0; box-shadow: none;
  border-radius: 12px; font-weight: 500; font-size: 1.3em; }
.osk-plus .keyboard-key.default-key, .osk-plus .keyboard-key.default-key:hover { background-color: ${p.fn}; font-size: 1.1em; }
.osk-plus .keyboard-key:active, .osk-plus .keyboard-key:active:hover, .osk-plus .keyboard-key:active:focus,
.osk-plus .keyboard-key.default-key:active, .osk-plus .keyboard-key.default-key:active:hover { background-color: ${p.press}; }
.osk-plus .keyboard-key:checked, .osk-plus .keyboard-key:checked:hover, .osk-plus .keyboard-key.default-key:checked {
  background-color: ${p.accent}; color: ${p.onAccent}; }
.osk-plus .keyboard-key.osk-plus-enter, .osk-plus .keyboard-key.osk-plus-enter:hover {
  background-color: ${p.accent}; color: ${p.onAccent}; border-radius: 999px; }
.osk-plus .keyboard-key.osk-plus-enter:active { background-color: ${mix(p.accent, p.text, 0.25)}; }
.osk-plus .word-suggestions { color: ${p.text}; }
.keyboard-subkeys { -arrow-background-color: ${p.bg}; -arrow-border-color: ${p.fn}; color: ${p.text}; }
.keyboard-subkeys .keyboard-key { background-color: ${p.key}; color: ${p.text}; border-width: 0; border-radius: 12px; box-shadow: none; }
.keyboard-subkeys .keyboard-key:hover, .keyboard-subkeys .keyboard-key:active { background-color: ${p.accent}; color: ${p.onAccent}; }

.osk-plus-bar { height: 44px; padding: 4px 4px 2px 4px; spacing: 4px; }
.osk-plus-bar-button { color: ${p.text}; border-radius: 999px; padding: 0 14px; min-width: 32px; background-color: transparent; }
.osk-plus-bar-button StIcon { icon-size: 20px; }
.osk-plus-bar-button:hover { background-color: ${mix(p.bg, p.key, 0.6)}; }
.osk-plus-bar-button:active { background-color: ${p.press}; }
.osk-plus-bar-button.osk-plus-busy { color: ${p.accent}; }
.osk-plus-bar-button.osk-plus-listening { color: ${p.onAccent}; background-color: ${p.accent}; }
.osk-plus-chips { spacing: 6px; }
.osk-plus-chip { color: ${p.text}; padding: 0 14px; border-radius: 999px; font-size: 1.05em; }
.osk-plus-chip:hover, .osk-plus-chip:active { background-color: ${p.key}; }
.osk-plus-chip.osk-plus-primary { font-weight: bold; }
.osk-plus-live { color: ${p.subtle}; font-style: italic; }
.osk-plus-divider { width: 1px; background-color: ${mix(p.bg, p.text, 0.2)}; margin: 10px 0; }

.osk-plus-settings { padding: 8px 14px; spacing: 10px; color: ${p.text}; }
.osk-plus-settings-title { font-weight: bold; color: ${p.subtle}; font-size: 0.9em; }
.osk-plus-swatches { spacing: 8px; }
.osk-plus-swatch { border-radius: 999px; padding: 6px 14px; border: 2px solid; font-size: 0.95em; }
.osk-plus-swatch.osk-plus-selected { border-color: ${p.accent}; }
.osk-plus-dot { width: 30px; height: 30px; border-radius: 999px; border: 2px solid transparent; }
.osk-plus-dot.osk-plus-selected { border-color: ${p.text}; }
.osk-plus-toggle { border-radius: 999px; padding: 6px 16px; background-color: ${p.key}; color: ${p.text}; }
.osk-plus-toggle.osk-plus-selected { background-color: ${p.accent}; color: ${p.onAccent}; }
`;
}
