// OSK Plus: a reworked GNOME on-screen keyboard.
//
// - Top bar: copy, paste, swipe suggestions or live dictation text, mic, settings.
// - Swipe typing: slide across letters; a trail follows the finger and the
//   osk-dictation service turns the path into words (best one typed, the
//   others offered in the bar).
// - Slide along the space bar to move the cursor.
// - Colours follow the desktop (or a theme picked in settings).
// - Taller keys in portrait; a split, thumb-friendly layout in landscape.
// - Dictation as in OSK Dictation: live underlined text, level meter.
//
// It replaces osk-dictation@electro while enabled (both patch the same keyboard).
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as KeyboardUI from 'resource:///org/gnome/shell/ui/keyboard.js';
import {getInputSourceManager, INPUT_SOURCE_TYPE_IBUS} from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ACCENTS, THEMES, mix, resolvePalette, stylesheet} from './themes.js';

const BUS_NAME = 'io.github.electro_sheep.OskDictation';
const OBJECT_PATH = '/io/github/electro_sheep/OskDictation';
const DictationProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="io.github.electro_sheep.OskDictation">
    <method name="Prepare"/>
    <method name="Start"><arg name="context" type="s" direction="in"/><arg name="purpose" type="s" direction="in"/></method>
    <method name="Stop"/>
    <method name="Cancel"/>
    <method name="GlideLayout"><arg name="keys" type="a{s(dd)}" direction="in"/><arg name="radius" type="d" direction="in"/></method>
    <method name="Glide"><arg name="points" type="a(dd)" direction="in"/><arg name="before" type="s" direction="in"/><arg name="purpose" type="s" direction="in"/><arg name="words" type="as" direction="out"/></method>
    <method name="Suggest"><arg name="before" type="s" direction="in"/><arg name="purpose" type="s" direction="in"/><arg name="words" type="as" direction="out"/></method>
    <signal name="State"><arg name="state" type="s"/></signal>
    <signal name="Partial"><arg name="text" type="s"/></signal>
    <signal name="Final"><arg name="text" type="s"/><arg name="replace" type="b"/></signal>
    <signal name="Level"><arg name="level" type="d"/></signal>
  </interface>
</node>`);

const ORIGINAL_UUID = 'osk-dictation@electro';
const MIC_ICON = 'audio-input-microphone-symbolic';
const HIDDEN_FOR = [Clutter.InputContentPurpose.PASSWORD, Clutter.InputContentPurpose.PIN]
    .filter(purpose => purpose !== undefined);
const BUSY_STATES = ['loading', 'starting', 'finishing', 'retrying'];
const SESSION_STATES = ['starting', 'listening', 'finishing'];
const SETTINGS_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'osk-dictation', 'keyboard.json']);
const DEFAULT_SETTINGS = {theme: 'desktop', accent: 'desktop', landscape: 'split'};

const BAR_HEIGHT = 46;          // matches .osk-plus-bar plus padding
const PORTRAIT_SHARE = 0.29;    // keyboard height as a share of the screen
const LANDSCAPE_SHARE = 0.47;
const SPLIT_GAP = 2.5;          // key widths between the halves in landscape
const GLIDE_START = 0.6;        // finger travel (key widths) that turns a press into a swipe
const CURSOR_START = 12;        // px along the space bar before the cursor moves
const CURSOR_STEP = 16;         // px per cursor step
const TRAIL_POINTS = 60;
const PREVIEW_EVERY = 180000;   // µs between live swipe guesses

// Pages replacing GNOME's two symbol levels: a calculator-style number pad
// behind ?123, and all the symbols behind #+=.
const k = (s, width = 1) => ({strings: [s], width});
const chars = (text, width = 1) => [...text].map(c => k(c, width));
const DEL = width => ({action: 'delete', iconName: 'edit-clear-symbolic', width});
const ENTER = width => ({keyval: '0xff0d', iconName: 'keyboard-enter-symbolic', width});
const TO = (level, label, width) => ({action: 'levelSwitch', level, label, width});
const HIDE = width => ({action: 'hide', iconName: 'keyboard-hide-symbolic', width});
const SPACE = width => ({strings: [' '], width});
const NUMBERS = [
    [...chars('()%+'), ...chars('123'), DEL(1.5)],
    [...chars('$:=-'), ...chars('456'), ENTER(1.5)],
    [TO('opt+shift', '#+=', 2), ...chars('*/'), ...chars('789'), k(',', 1.5)],
    [TO('default', 'ABC', 2), ...chars('@#'), ...chars('.0'), SPACE(1), HIDE(1.5)],
];
const SYMBOLS = [
    [...chars('!@#$%^&*()'), DEL(1.5)],
    [...chars('-_=+[]{}<>'), ENTER(1.5)],
    [TO('opt', '123', 1.5), ...chars('\'":;/\\?|~`')],
    [TO('default', 'ABC', 1.5), {action: 'emoji', iconName: 'face-smile-symbolic', width: 1.5},
        ...chars('£€'), SPACE(4), ...chars(',.'), HIDE(1.5)],
];
const TERMINAL_KEYS = [['Esc', Clutter.KEY_Escape], ['Tab', Clutter.KEY_Tab], ['Ctrl+C', Clutter.KEY_c, true],
    ['↑', Clutter.KEY_Up], ['↓', Clutter.KEY_Down], ['Ctrl+R', Clutter.KEY_r, true]];

const isPress = t => t === Clutter.EventType.BUTTON_PRESS || t === Clutter.EventType.TOUCH_BEGIN;
const isMove = t => t === Clutter.EventType.MOTION || t === Clutter.EventType.TOUCH_UPDATE;
const isRelease = t => t === Clutter.EventType.BUTTON_RELEASE || t === Clutter.EventType.TOUCH_END ||
    t === Clutter.EventType.TOUCH_CANCEL;

function rgb01(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export default class OskPlusExtension extends Extension {
    enable() {
        this._settings = this._loadSettings();
        this._state = 'idle';
        this._preedit = null;
        this._live = '';
        this._level = 0;
        this._sessionWindow = null;
        this._discardFinals = false;
        this._keyInfo = new WeakMap();
        this._password = false;
        this._gesture = null;
        this._glideSignature = null;
        this._lastGlide = null;
        this._keyboard = null;
        this._portrait = this._isPortrait();

        // Hand over from the original extension; only one may patch the keyboard.
        this._handoverId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._handoverId = 0;
            if (Main.extensionManager.lookup(ORIGINAL_UUID)?.state === 1)
                Main.extensionManager.disableExtension(ORIGINAL_UUID);
            return GLib.SOURCE_REMOVE;
        });

        this._proxy = new DictationProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (p, error) => {
            if (error)
                console.error(`osk-plus: ${error.message}`);
        }, null, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION);
        this._proxySignals = [
            this._proxy.connectSignal('State', (_p, _s, [state]) => this._onState(state)),
            this._proxy.connectSignal('Partial', (_p, _s, [text]) => this._onPartial(text)),
            this._proxy.connectSignal('Final', (_p, _s, [text, replace]) => this._onFinal(text, replace)),
            this._proxy.connectSignal('Level', (_p, _s, [level]) => this._onLevel(level)),
        ];

        this._keyboardVisibilityId = Main.keyboard.connect('visibility-changed', () => this._onVisibility());
        this._focusWindowId = global.display.connect('notify::focus-window', () => this._onFocusWindowChanged());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._onMonitorsChanged());
        // If the shell theme is replaced, our stylesheet goes with it: load it again.
        this._themeContextId = St.ThemeContext.get_for_stage(global.stage).connect('changed', ctx => {
            if (this._applyingTheme)
                return;
            const loaded = ctx.get_theme().get_custom_stylesheets().some(f => this._themeFile && f.equal(this._themeFile));
            if (!loaded)
                this._applyTheme();
        });

        const ext = this;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(KeyboardUI.Keyboard.prototype, '_setupKeyboard', original => function (...args) {
            const result = original.call(this, ...args);
            ext._decorate(this);
            return result;
        });
        this._injections.overrideMethod(KeyboardUI.Keyboard.prototype, '_relayout', original => function (...args) {
            original.call(this, ...args);
            ext._resize(this);
        });
        this._injections.overrideMethod(KeyboardUI.Keyboard.prototype, '_addRowKeys', original => function (keys, layout, emojiVisible) {
            ext._password = HIDDEN_FOR.includes(this._purpose);
            if (ext._micButton)
                ext._micButton.visible = !ext._password;
            const index = layout._nRows - 1;
            if (index === 0) {
                const first = keys[0]?.strings?.[0];
                layout._oskPlusPage = first === '1' ? 'numbers' : first === '~' ? 'symbols' : 'letters';
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => ext._refreshIdleChips() ?? GLib.SOURCE_REMOVE);
            }
            const page = layout._oskPlusPage;
            let row = page === 'numbers' ? NUMBERS[index] : page === 'symbols' ? SYMBOLS[index] : keys;
            row = ext._dropLanguageKey(JSON.parse(JSON.stringify(row ?? keys)));
            if (page !== 'numbers' && ext._landscapeSplit())
                row = ext._splitRow(row);
            const shown = row.filter(k => !(k.action === 'emoji' && !emojiVisible));
            const meta = shown.map(k => ({first: k.strings?.[0], action: k.action, keyval: k.keyval, icon: k.iconName}));
            let i = 0;
            layout.appendKey = function (button, ...rest) {
                ext._adoptKey(button, meta[i++]);
                return Object.getPrototypeOf(this).appendKey.call(this, button, ...rest);
            };
            try {
                return original.call(this, row, layout, emojiVisible);
            } finally {
                delete layout.appendKey;
            }
        });

        this._applyTheme();
        const keyboard = Main.keyboard.keyboardActor;
        if (keyboard) {
            this._decorate(keyboard);
            keyboard._updateKeys();
            keyboard._relayout();
        }
    }

    disable() {
        if (this._handoverId)
            GLib.source_remove(this._handoverId);
        if (this._suggestId)
            GLib.source_remove(this._suggestId);
        if (SESSION_STATES.includes(this._state))
            this._call('Cancel');
        this._clearLive();
        this._injections.clear();
        this._injections = null;
        Main.keyboard.disconnect(this._keyboardVisibilityId);
        global.display.disconnect(this._focusWindowId);
        Main.layoutManager.disconnect(this._monitorsId);
        St.ThemeContext.get_for_stage(global.stage).disconnect(this._themeContextId);
        for (const id of this._proxySignals)
            this._proxy.disconnectSignal(id);
        this._proxy = null;
        this._undecorate();
        this._unloadTheme();
        const keyboard = Main.keyboard.keyboardActor;
        if (keyboard) {
            keyboard._updateKeys();
            keyboard._relayout();
        }
    }

    // ------------------------------------------------------------ settings and theme

    _loadSettings() {
        try {
            const [, bytes] = GLib.file_get_contents(SETTINGS_FILE);
            return {...DEFAULT_SETTINGS, ...JSON.parse(new TextDecoder().decode(bytes))};
        } catch {
            return {...DEFAULT_SETTINGS};
        }
    }

    _saveSettings() {
        GLib.mkdir_with_parents(GLib.path_get_dirname(SETTINGS_FILE), 0o755);
        GLib.file_set_contents(SETTINGS_FILE, JSON.stringify(this._settings, null, 1));
    }

    _applyTheme() {
        this._applyingTheme = true;
        try {
            this._loadTheme();
        } finally {
            this._applyingTheme = false;
        }
    }

    _loadTheme() {
        this._palette = resolvePalette(this._settings);
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'osk-plus']);
        GLib.mkdir_with_parents(dir, 0o755);
        const file = Gio.File.new_for_path(`${dir}/theme-${GLib.get_monotonic_time()}.css`);
        file.replace_contents(new TextEncoder().encode(stylesheet(this._palette)), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        this._unloadTheme();
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(file);
        this._themeFile = file;
        const keyboard = this._keyboard;
        if (keyboard) {  // re-resolve styles across the keyboard
            keyboard.remove_style_class_name('osk-plus');
            keyboard.add_style_class_name('osk-plus');
        }
    }

    _unloadTheme() {
        if (!this._themeFile)
            return;
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._themeFile);
        try {
            this._themeFile.delete(null);
        } catch {}
        this._themeFile = null;
    }

    // ------------------------------------------------------------ keyboard decoration

    _decorate(keyboard) {
        if (this._keyboard === keyboard)
            return;
        this._keyboard = keyboard;
        keyboard.add_style_class_name('osk-plus');
        keyboard.connectObject('destroy', () => {
            this._keyboard = null;
            this._micButton = null;
        }, this);

        this._bar = this._buildBar();
        keyboard.insert_child_at_index(this._bar, 0);
        const suggestions = keyboard._suggestions;
        const syncSuggestions = () => (suggestions.visible = suggestions.get_n_children() > 0);
        suggestions.connectObject('child-added', syncSuggestions, 'child-removed', syncSuggestions, this);
        syncSuggestions();
        this._settingsPanel = this._buildSettings();
        keyboard.insert_child_above(this._settingsPanel, keyboard._aspectContainer);

        const ac = keyboard._aspectContainer;
        ac.setRatio = () => this._fill(keyboard);  // keys fill the area instead of keeping GNOME's ratio
        ac.reactive = true;  // Clutter only runs captured-event on reactive actors
        this._trail = new St.DrawingArea({reactive: false, x_expand: true, y_expand: true});
        this._trail.connect('repaint', area => this._paintTrail(area));
        this._trailPoints = [];
        ac.add_child(this._trail);
        ac.connectObject('captured-event', (actor, event) => this._onKeyEvent(event), this);
    }

    _undecorate() {
        const keyboard = this._keyboard;
        if (!keyboard)
            return;
        keyboard.disconnectObject(this);
        keyboard._aspectContainer.disconnectObject(this);
        keyboard._suggestions.disconnectObject(this);
        keyboard._suggestions.show();
        delete keyboard._aspectContainer.setRatio;
        keyboard._aspectContainer.reactive = false;
        keyboard.remove_style_class_name('osk-plus');
        for (const actor of [this._bar, this._settingsPanel, this._trail])
            actor?.destroy();
        keyboard._aspectContainer.show();
        this._bar = this._settingsPanel = this._trail = this._micButton = this._chips = null;
        this._keyboard = null;
    }

    _isPortrait() {
        const monitor = Main.layoutManager.keyboardMonitor ?? Main.layoutManager.primaryMonitor;
        return monitor ? monitor.height > monitor.width : false;
    }

    _landscapeSplit() {
        return !this._isPortrait() && this._settings.landscape === 'split';
    }

    _resize(keyboard) {
        const monitor = Main.layoutManager.keyboardMonitor;
        if (!monitor)
            return;
        keyboard.height = Math.round(monitor.height * (monitor.height > monitor.width ? PORTRAIT_SHARE : LANDSCAPE_SHARE));
        this._fill(keyboard);
    }

    _fill(keyboard) {
        const ac = keyboard._aspectContainer;
        const width = Math.max(1, keyboard.width - 8);
        const strip = keyboard._suggestions.visible ? keyboard._suggestions.height : 0;
        const height = Math.max(1, keyboard.height - BAR_HEIGHT - strip - 6);
        ac._ratio = width / height;
        ac.queue_relayout();
    }

    _onMonitorsChanged() {
        const portrait = this._isPortrait();
        if (portrait === this._portrait)
            return;
        this._portrait = portrait;
        this._glideSignature = null;
        const keyboard = this._keyboard;
        if (keyboard) {
            keyboard._updateKeys();
            keyboard._relayout();
        }
    }

    // In landscape, open a gap down the middle of every row for two-thumb typing.
    // A space bar spanning the middle becomes two half-width space bars.
    // The language key opened GNOME's menu, which could jam all keyboard input;
    // layouts are chosen in settings instead, and the space bar takes the room.
    _dropLanguageKey(row) {
        const i = row.findIndex(k => k.action === 'languageMenu');
        if (i < 0)
            return row;
        const [removed] = row.splice(i, 1);
        const space = row.find(k => !k.action && k.strings?.[0] === ' ') ?? row[i - 1];
        if (space)
            space.width = (space.width ?? 1) + (removed.width ?? 1);
        return row;
    }

    _splitRow(keys) {
        const row = keys.map(k => ({...k, strings: k.strings ? [...k.strings] : k.strings}));
        const total = row.reduce((sum, k) => sum + (k.leftOffset ?? 0) + (k.width ?? 1), 0);
        const mid = total / 2;
        let left = 0;
        for (let i = 0; i < row.length; i++) {
            const key = row[i];
            left += key.leftOffset ?? 0;
            const width = key.width ?? 1;
            const right = left + width;
            if (left < mid && right > mid) {  // this key spans the middle
                if (!key.action && key.strings?.[0] === ' ') {
                    row.splice(i, 1, {...key, width: width / 2},
                        {...key, width: width / 2, leftOffset: SPLIT_GAP, strings: [...key.strings]});
                } else {
                    const gapAfter = mid - left > right - mid;
                    const next = gapAfter ? row[i + 1] : key;
                    if (next)
                        next.leftOffset = (next.leftOffset ?? 0) + SPLIT_GAP;
                }
                break;
            }
            if (left >= mid) {
                key.leftOffset = (key.leftOffset ?? 0) + SPLIT_GAP;
                break;
            }
            left = right;
        }
        return row;
    }

    _adoptKey(key, meta) {
        if (!meta)
            return;
        let info = {kind: 'other'};
        if (meta.first && /^[a-zA-Z]$/.test(meta.first) && !meta.action)
            info = {kind: 'letter', char: meta.first.toLowerCase()};
        else if (meta.first === ' ' && !meta.action)
            info = {kind: 'space'};
        if (meta.icon === 'keyboard-enter-symbolic' || parseInt(meta.keyval, 16) === Clutter.KEY_Return)
            key.keyButton.add_style_class_name('osk-plus-enter');
        this._keyInfo.set(key, info);
    }

    // ------------------------------------------------------------ top bar

    _buildBar() {
        const bar = new St.BoxLayout({style_class: 'osk-plus-bar', x_expand: true});
        const button = (icon, label, onActivate, onPress = false) => {
            const b = new St.Button({
                style_class: 'osk-plus-bar-button', can_focus: false, accessible_name: label,
                child: new St.Icon({icon_name: icon}), y_expand: true,
            });
            if (onPress)  // react on touch-down: the mic takes ~250 ms to open
                b.connect('notify::pressed', () => b.pressed && onActivate());
            else
                b.connect('clicked', onActivate);
            return b;
        };
        bar.add_child(button('edit-copy-symbolic', 'Copy', () => this._shortcut(Clutter.KEY_c)));
        bar.add_child(button('edit-paste-symbolic', 'Paste', () => this._shortcut(Clutter.KEY_v)));
        bar.add_child(new St.Widget({style_class: 'osk-plus-divider', y_expand: true}));
        this._chips = new St.BoxLayout({style_class: 'osk-plus-chips', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        bar.add_child(this._chips);
        bar.add_child(new St.Widget({style_class: 'osk-plus-divider', y_expand: true}));
        this._micButton = button(MIC_ICON, 'Dictate', () => this._onMicPressed(), true);
        this._micButton.visible = !this._password;
        bar.add_child(this._micButton);
        bar.add_child(button('emblem-system-symbolic', 'Keyboard settings', () => this._toggleSettings()));
        this._styleMic();
        return bar;
    }

    _purposeName() {
        return this._keyboard?._purpose === Clutter.InputContentPurpose.TERMINAL ? 'terminal' : 'normal';
    }

    _tap(keyval, mods = [], times = 1) {
        const controller = this._keyboard?._keyboardController;
        if (!controller)
            return;
        for (let i = 0; i < times; i++) {
            mods.forEach(m => controller.keyvalPress(m));
            controller.keyvalPress(keyval);
            controller.keyvalRelease(keyval);
            [...mods].reverse().forEach(m => controller.keyvalRelease(m));
        }
    }

    // Ctrl+C / Ctrl+V to the focused app (with Shift in terminals).
    _shortcut(keyval) {
        const terminal = this._purposeName() === 'terminal';
        this._tap(keyval, terminal ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L] : [Clutter.KEY_Control_L]);
    }

    // With nothing to suggest, terminals get the keys a touch keyboard lacks.
    _refreshIdleChips() {
        if (this._chips && this._chips.get_n_children() === 0 || this._idleChips)
            this._setChips([]);
    }

    // ---- word suggestions: complete the current word, then predict the next

    _scheduleSuggest() {
        if (this._password || SESSION_STATES.includes(this._state) || !this._keyboard)
            return;
        if (this._suggestId)
            GLib.source_remove(this._suggestId);
        this._suggestId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._suggestId = 0;
            this._suggest().catch(e => console.warn(`osk-plus: suggest: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _suggest() {
        if (!Main.inputMethod.currentFocus || this._lastGlide || !this._proxy)
            return;
        const before = await this._textBeforeCursor();
        const [words] = await this._proxy.SuggestAsync(before, this._purposeName());
        if (this._lastGlide || this._gesture || SESSION_STATES.includes(this._state))
            return;
        const typing = /[A-Za-z']$/.test(before);
        const prefix = typing ? /[A-Za-z][A-Za-z']*$/.exec(before)?.[0] ?? '' : '';
        const items = words.map((w, i) => ({text: w, primary: i === 0, onClick: () => this._acceptSuggestion(prefix, w)}));
        if (items.length === 3)  // best guess in the middle, as on phones
            items.splice(0, 2, items[1], items[0]);
        this._setChips(items);
    }

    _acceptSuggestion(prefix, word) {
        this._tap(Clutter.KEY_BackSpace, [], [...prefix].length);
        this._commit(`${word} `);
        this._scheduleSuggest();
    }

    _setChips(items) {
        if (!this._chips)
            return;
        this._idleChips = false;
        if (!items.length && this._purposeName() === 'terminal' && !this._password) {
            items = TERMINAL_KEYS.map(([text, keyval, ctrl]) => ({
                text, onClick: () => this._tap(keyval, ctrl ? [Clutter.KEY_Control_L] : []),
            }));
            this._idleChips = true;
        }
        this._chips.destroy_all_children();
        for (const item of items) {
            if (item.live) {
                this._chips.add_child(new St.Label({
                    text: item.text, style_class: 'osk-plus-live', y_align: Clutter.ActorAlign.CENTER,
                }));
                continue;
            }
            const chip = new St.Button({
                label: item.text, can_focus: false, y_expand: true,
                style_class: item.primary ? 'osk-plus-chip osk-plus-primary' : 'osk-plus-chip',
            });
            chip.connect('clicked', item.onClick);
            this._chips.add_child(chip);
        }
    }

    // ------------------------------------------------------------ settings panel

    _buildSettings() {
        const panel = new St.BoxLayout({style_class: 'osk-plus-settings', vertical: true, x_expand: true, y_expand: true, visible: false});
        const section = (title, child) => {
            panel.add_child(new St.Label({text: title, style_class: 'osk-plus-settings-title'}));
            panel.add_child(child);
        };
        const row = () => new St.BoxLayout({style_class: 'osk-plus-swatches', x_expand: true});

        this._themeButtons = new Map();
        const themes = row();
        for (const [id, theme] of Object.entries(THEMES)) {
            const palette = id === 'desktop' ? resolvePalette({theme: 'desktop', accent: 'desktop'}) : theme;
            const b = new St.Button({
                label: theme.name, can_focus: false, style_class: 'osk-plus-swatch',
                style: `background-color: ${palette.key}; color: ${palette.text}; border-color: ${palette.bg};`,
            });
            b.connect('clicked', () => this._changeSetting('theme', id));
            this._themeButtons.set(id, b);
            themes.add_child(b);
        }
        section('Colours', themes);

        this._accentButtons = new Map();
        const accents = row();
        for (const [id, colour] of Object.entries(ACCENTS)) {
            const shown = colour ?? resolvePalette({theme: 'desktop', accent: 'desktop'}).accent;
            const b = new St.Button({
                can_focus: false, style_class: 'osk-plus-dot', accessible_name: id,
                style: `background-color: ${shown};`,
            });
            if (id === 'desktop')
                b.child = new St.Icon({icon_name: 'computer-symbolic', icon_size: 14, style: 'color: #11111b;'});
            b.connect('clicked', () => this._changeSetting('accent', id));
            this._accentButtons.set(id, b);
            accents.add_child(b);
        }
        section('Accent', accents);

        this._layoutButtons = new Map();
        const layouts = row();
        for (const [id, label] of [['split', 'Split'], ['full', 'Full width']]) {
            const b = new St.Button({label, can_focus: false, style_class: 'osk-plus-toggle'});
            b.connect('clicked', () => this._changeSetting('landscape', id));
            this._layoutButtons.set(id, b);
            layouts.add_child(b);
        }
        section('Landscape layout', layouts);

        this._sourceButtons = new Map();
        const sources = row();
        for (const source of Object.values(getInputSourceManager().inputSources)) {
            const b = new St.Button({label: source.displayName, can_focus: false, style_class: 'osk-plus-toggle'});
            b.connect('clicked', () => {
                source.activate(true);
                this._refreshSettings();
            });
            this._sourceButtons.set(source.id, b);
            sources.add_child(b);
        }
        const done = new St.Button({label: 'Done', can_focus: false, style_class: 'osk-plus-toggle osk-plus-selected', x_expand: true, x_align: Clutter.ActorAlign.END});
        done.connect('clicked', () => this._toggleSettings());
        sources.add_child(done);
        section('Keyboard layout', sources);
        return panel;
    }

    _toggleSettings() {
        const keyboard = this._keyboard;
        if (!keyboard)
            return;
        const open = !this._settingsPanel.visible;
        this._settingsPanel.visible = open;
        keyboard._aspectContainer.visible = !open;
        this._refreshSettings();
    }

    _changeSetting(name, value) {
        this._settings[name] = value;
        this._saveSettings();
        if (name === 'landscape') {
            this._glideSignature = null;
            this._keyboard?._updateKeys();
        } else {
            this._applyTheme();
        }
        this._refreshSettings();
    }

    _refreshSettings() {
        const mark = (buttons, selected) => {
            for (const [id, b] of buttons ?? []) {
                if (id === selected)
                    b.add_style_class_name('osk-plus-selected');
                else
                    b.remove_style_class_name('osk-plus-selected');
            }
        };
        mark(this._themeButtons, this._settings.theme);
        mark(this._accentButtons, this._settings.accent);
        mark(this._layoutButtons, this._settings.landscape);
        mark(this._sourceButtons, getInputSourceManager().currentSource?.id);
    }

    // ------------------------------------------------------------ gestures: space cursor and swipe typing

    _keyAt(event) {
        let actor = global.stage.get_event_actor(event);
        while (actor && !this._keyInfo.has(actor))
            actor = actor.get_parent();
        return actor;
    }

    _slot(event) {
        return event.get_event_sequence()?.get_slot() ?? -1;
    }

    _onKeyEvent(event) {
        const type = event.type();
        const [x, y] = event.get_coords();
        if (isRelease(type) && !this._gesture)
            this._scheduleSuggest();
        if (isPress(type)) {
            if (this._gesture)
                return Clutter.EVENT_PROPAGATE;
            const key = this._keyAt(event);
            const info = key && this._keyInfo.get(key);
            if (key && this._lastGlide) {
                this._lastGlide = null;  // any tap moves on; swipe alternatives no longer apply
                this._setChips([]);
            }
            if (!info || info.kind === 'other')
                return Clutter.EVENT_PROPAGATE;
            this._gesture = {key, info, slot: this._slot(event), x0: x, y0: y, mode: null, points: [[x, y]], step: x};
            return Clutter.EVENT_PROPAGATE;
        }
        const g = this._gesture;
        if (!g || this._slot(event) !== g.slot)
            return Clutter.EVENT_PROPAGATE;

        if (isMove(type)) {
            if (!g.mode) {
                const dx = x - g.x0, dy = y - g.y0;
                if (g.info.kind === 'space' && Math.abs(dx) > CURSOR_START && Math.abs(dx) > Math.abs(dy)) {
                    g.mode = 'cursor';
                    g.step = g.x0 + Math.sign(dx) * CURSOR_START;
                    this._cancelKey(g.key);
                } else if (g.info.kind === 'letter' && !this._password &&
                           Math.hypot(dx, dy) > GLIDE_START * g.key.width) {
                    g.mode = 'glide';
                    this._cancelKey(g.key);
                    g.context = this._textBeforeCursor();
                    this._startTrail(g.points);
                }
            }
            if (g.mode === 'cursor') {
                const controller = this._keyboard._keyboardController;
                while (x - g.step >= CURSOR_STEP) {
                    controller.keyvalPress(Clutter.KEY_Right);
                    controller.keyvalRelease(Clutter.KEY_Right);
                    g.step += CURSOR_STEP;
                }
                while (g.step - x >= CURSOR_STEP) {
                    controller.keyvalPress(Clutter.KEY_Left);
                    controller.keyvalRelease(Clutter.KEY_Left);
                    g.step -= CURSOR_STEP;
                }
                return Clutter.EVENT_STOP;
            }
            if (g.mode === 'glide') {
                g.points.push([x, y]);
                this._addTrailPoint(x, y);
                const now = GLib.get_monotonic_time();
                if (!g.previewing && g.points.length > 6 && now - (g.previewAt ?? 0) > PREVIEW_EVERY) {
                    g.previewing = true;
                    g.previewAt = now;
                    this._previewGlide(g).catch(() => {}).finally(() => (g.previewing = false));
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (isRelease(type)) {
            this._gesture = null;
            if (g.mode === 'glide') {
                this._endTrail();
                if (type !== Clutter.EventType.TOUCH_CANCEL)
                    this._finishGlide(g).catch(e => console.error(`osk-plus: swipe failed: ${e.message}`));
                return Clutter.EVENT_STOP;
            }
            if (g.mode === 'cursor')
                return Clutter.EVENT_STOP;
            this._scheduleSuggest();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Stop the key the finger went down on from typing its letter on release.
    _cancelKey(key) {
        key.cancel();
        key._pressed = false;
        key.keyButton.remove_style_pseudo_class('active');
    }

    _letterCentres() {
        const keys = {};
        let radius = 0;
        for (const key of this._keyboard?._currentPage?.get_children() ?? []) {
            const info = this._keyInfo.get(key);
            if (info?.kind !== 'letter' || !key.mapped)
                continue;
            const [x, y] = key.keyButton.get_transformed_position();
            const [w, h] = key.keyButton.get_transformed_size();
            keys[info.char] = [x + w / 2, y + h / 2];
            radius = Math.max(radius, Math.min(w, h) / 2);
        }
        return [keys, radius];
    }

    async _sendLayout() {
        const [keys, radius] = this._letterCentres();
        if (Object.keys(keys).length < 20)
            return;
        const signature = JSON.stringify(Object.entries(keys).map(([c, [x, y]]) => [c, Math.round(x), Math.round(y)]));
        if (signature === this._glideSignature)
            return;
        this._glideSignature = signature;
        await this._call('GlideLayout', keys, radius);
    }

    // While the finger is still moving, show the word the path spells so far.
    async _previewGlide(g) {
        await this._sendLayout();
        const [words] = await this._proxy.GlideAsync(g.points.slice(), '', this._purposeName());
        if (this._gesture === g && words.length)
            this._setChips([{live: true, text: words[0].trim()}]);
    }

    async _finishGlide(g) {
        await this._sendLayout();
        const before = await g.context;
        const [words] = await this._proxy.GlideAsync(g.points, before, this._purposeName());
        if (!words.length)
            return;
        this._commit(words[0]);
        this._lastGlide = words[0];
        const pick = word => {
            if (!this._lastGlide)
                return;
            const controller = this._keyboard._keyboardController;
            for (let i = 0; i < [...this._lastGlide].length; i++) {
                controller.keyvalPress(Clutter.KEY_BackSpace);
                controller.keyvalRelease(Clutter.KEY_BackSpace);
            }
            this._commit(word);
            this._lastGlide = word;
            showChips(word);
        };
        const showChips = chosen => this._setChips(words.map(w => ({text: w.trim(), primary: w === chosen, onClick: () => pick(w)})));
        showChips(words[0]);
    }

    _startTrail(points) {
        const ac = this._keyboard._aspectContainer;
        ac.set_child_above_sibling(this._trail, null);
        this._trailPoints = [];
        for (const [x, y] of points)
            this._addTrailPoint(x, y);
    }

    _addTrailPoint(x, y) {
        const [ok, lx, ly] = this._trail.transform_stage_point(x, y);
        if (!ok)
            return;
        this._trailPoints.push([lx, ly]);
        if (this._trailPoints.length > TRAIL_POINTS)
            this._trailPoints.shift();
        this._trail.queue_repaint();
    }

    _endTrail() {
        this._trailPoints = [];
        this._trail.queue_repaint();
    }

    _paintTrail(area) {
        const cr = area.get_context();
        const pts = this._trailPoints;
        const [r, g, b] = rgb01(this._palette.accent);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        for (let i = 1; i < pts.length; i++) {
            const fresh = i / pts.length;  // older segments fade and thin out
            cr.setSourceRGBA(r, g, b, 0.15 + 0.7 * fresh);
            cr.setLineWidth(3 + 7 * fresh);
            cr.moveTo(...pts[i - 1]);
            cr.lineTo(...pts[i]);
            cr.stroke();
        }
        cr.$dispose();
    }

    // ------------------------------------------------------------ dictation (as in OSK Dictation)

    _onVisibility() {
        if (Main.keyboard.visible) {
            this._call('Prepare');
            // Send the key positions once they've been laid out, so the first swipe is quick.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                this._sendLayout().catch(() => {});
                return GLib.SOURCE_REMOVE;
            });
        } else {
            if (['starting', 'listening'].includes(this._state))
                this._call('Stop');
            if (this._settingsPanel?.visible)
                this._toggleSettings();
            this._setChips([]);
        }
    }

    _onMicPressed() {
        if (['idle', 'loading'].includes(this._state))
            this._start().catch(e => console.error(`osk-plus: ${e.message}`));
        else if (['starting', 'listening'].includes(this._state))
            this._call('Stop');
    }

    async _start() {
        this._sessionWindow = global.display.focus_window;
        this._discardFinals = false;
        this._onState('starting');
        if (!await this._call('Start', await this._textBeforeCursor(), 'normal'))
            this._onState('idle');
    }

    _textBeforeCursor() {
        const im = Main.inputMethod;
        if (!im.currentFocus)
            return Promise.resolve('');
        return new Promise(resolve => {
            let signalId = 0, timeoutId = 0;
            const finish = () => {
                im.disconnect(signalId);
                if (timeoutId)
                    GLib.source_remove(timeoutId);
                const [text, cursor] = im.getSurroundingText();
                resolve(text ? GLib.utf8_substring(text, 0, cursor) : '');
            };
            signalId = im.connect('surrounding-text-set', finish);
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                timeoutId = 0;
                finish();
                return GLib.SOURCE_REMOVE;
            });
            im.request_surrounding();
        }).catch(() => '');
    }

    async _call(method, ...args) {
        if (!this._proxy)
            return false;
        try {
            await this._proxy[`${method}Async`](...args);
            return true;
        } catch (e) {
            let reason = e.message.replace(/^GDBus\.Error:[\w.]+: /, '');
            console.warn(`osk-plus: ${method} failed: ${reason}`);
            if (/was not provided by any \.service files/.test(reason))
                reason = "The osk-dictation service isn't installed. Run install.sh from the osk-dictation folder.";
            if (!['Prepare', 'GlideLayout'].includes(method))
                Main.notify('Keyboard', reason);
            return false;
        }
    }

    _onState(state) {
        if (state.startsWith('error:')) {
            Main.notify('Dictation', state.slice('error:'.length));
            return;
        }
        this._state = state;
        if (state === 'idle') {
            this._clearLive();
            this._level = 0;
        }
        this._styleMic();
    }

    _onFocusWindowChanged() {
        if (!SESSION_STATES.includes(this._state) || this._discardFinals)
            return;
        if (global.display.focus_window === this._sessionWindow)
            return;
        this._discardFinals = true;
        this._clearLive();
        this._call('Cancel');
        Main.notify('Dictation', 'Stopped because you switched windows. The phrase in progress was dropped.');
    }

    _onLevel(level) {
        this._level = Math.max(level, this._level * 0.7);
        this._styleMic();
    }

    _styleMic() {
        const b = this._micButton;
        if (!b)
            return;
        const listening = this._state === 'listening';
        if (listening)
            b.add_style_class_name('osk-plus-listening');
        else
            b.remove_style_class_name('osk-plus-listening');
        if (BUSY_STATES.includes(this._state))
            b.add_style_class_name('osk-plus-busy');
        else
            b.remove_style_class_name('osk-plus-busy');
        // Level meter: the accent brightens with your voice.
        b.set_style(listening && this._palette
            ? `background-color: ${mix(mix(this._palette.accent, this._palette.bg, 0.45), this._palette.accent, this._level)};`
            : null);
    }

    _onPartial(text) {
        if (!SESSION_STATES.includes(this._state) || this._discardFinals)
            return;
        if (this._canPreedit()) {
            this._showPreedit(text);
        } else {
            this._live = text.trim();
            this._setChips(this._live ? [{live: true, text: this._live.length > 60 ? `…${this._live.slice(-60)}` : this._live}] : []);
        }
    }

    _canPreedit() {
        const im = Main.inputMethod;
        return Boolean(im.currentFocus) && im.can_show_preedit &&
            getInputSourceManager().currentSource?.type !== INPUT_SOURCE_TYPE_IBUS;
    }

    _showPreedit(text) {
        if (!text) {
            this._clearPreedit();
            return;
        }
        const length = [...text].length;
        Main.inputMethod.set_preedit_text(text, length, length, Clutter.PreeditResetMode.CLEAR);
        this._preedit = text;
    }

    _clearPreedit() {
        if (this._preedit === null)
            return;
        this._preedit = null;
        if (Main.inputMethod.currentFocus)
            Main.inputMethod.set_preedit_text(null, 0, 0, Clutter.PreeditResetMode.CLEAR);
    }

    _clearLive() {
        this._clearPreedit();
        if (this._live) {
            this._live = '';
            this._setChips([]);
        }
    }

    _commit(text) {
        const controller = this._keyboard?._keyboardController;
        if (controller)
            controller.commit(text).catch(e => console.error(`osk-plus: ${e.message}`));
        else
            Main.inputMethod.commit(text);
    }

    _onFinal(text, replace) {
        if (replace || !text || this._discardFinals)
            return;
        this._clearLive();
        this._lastGlide = null;
        this._commit(text);
        this._scheduleSuggest();
    }
}
