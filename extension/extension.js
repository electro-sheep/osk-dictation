// Adds a dictation key to GNOME's on-screen keyboard.
//
// Speech recognition runs in the osk-dictation service over D-Bus; this only
// adds the key, sends the text before the cursor when dictation starts, and
// types each finished phrase the service sends back (already spaced and
// capitalised).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as KeyboardUI from 'resource:///org/gnome/shell/ui/keyboard.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'io.github.electro_sheep.OskDictation';
const OBJECT_PATH = '/io/github/electro_sheep/OskDictation';
const DictationProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="io.github.electro_sheep.OskDictation">
    <method name="Prepare"/>
    <method name="Start">
      <arg name="context" type="s" direction="in"/>
      <arg name="purpose" type="s" direction="in"/>
    </method>
    <method name="Stop"/>
    <method name="Cancel"/>
    <signal name="State"><arg name="state" type="s"/></signal>
    <signal name="Final"><arg name="text" type="s"/><arg name="replace" type="b"/></signal>
  </interface>
</node>`);

const MIC_ICON = 'audio-input-microphone-symbolic';
const KEY_ACTION = 'osk-dictation';
// PIN only exists in newer Clutter; drop it when missing so an unknown purpose
// (undefined, e.g. keyboard opened with nothing focused) doesn't match.
const HIDDEN_FOR = [Clutter.InputContentPurpose.PASSWORD, Clutter.InputContentPurpose.PIN]
    .filter(purpose => purpose !== undefined);
const BUSY_STATES = ['loading', 'starting', 'finishing', 'retrying'];

export default class OskDictationExtension extends Extension {
    enable() {
        this._state = 'idle';
        this._micKeys = new Set();
        this._proxySignals = [];
        this._proxy = new DictationProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (proxy, error) => {
            if (error)
                console.error(`osk-dictation: ${error.message}`);
        }, null, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES |
                 Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION);
        this._proxySignals.push(
            this._proxy.connectSignal('State', (_p, _s, [state]) => this._onState(state)),
            this._proxy.connectSignal('Final', (_p, _s, [text, replace]) => this._onFinal(text, replace)));

        this._keyboardVisibilityId = Main.keyboard.connect('visibility-changed', () => {
            if (Main.keyboard.visible)
                this._call('Prepare');
            else if (['starting', 'listening'].includes(this._state))
                this._call('Stop');
        });

        const ext = this;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(KeyboardUI.Keyboard.prototype, '_addRowKeys',
            original => function (keys, layout, emojiVisible) {
                const withMic = ext._withMicKey(keys, this._purpose);
                if (withMic === keys)
                    return original.call(this, keys, layout, emojiVisible);
                // Catch the button the original builds for our key as it's added.
                layout.appendKey = function (button, ...rest) {
                    if (button._icon?.icon_name === MIC_ICON)
                        ext._adoptMicKey(button);
                    return Object.getPrototypeOf(this).appendKey.call(this, button, ...rest);
                };
                try {
                    return original.call(this, withMic, layout, emojiVisible);
                } finally {
                    delete layout.appendKey;
                }
            });
        Main.keyboard.keyboardActor?._updateKeys();
    }

    disable() {
        if (['starting', 'listening'].includes(this._state))
            this._call('Cancel');
        this._injections.clear();
        this._injections = null;
        Main.keyboard.disconnect(this._keyboardVisibilityId);
        for (const id of this._proxySignals)
            this._proxy.disconnectSignal(id);
        this._proxy = null;
        this._micKeys.clear();
        Main.keyboard.keyboardActor?._updateKeys();
    }

    // Returns the row with a mic key inserted before the space bar, which gives
    // up the room for it, or the same row when it has no room or shouldn't get one.
    _withMicKey(keys, purpose) {
        if (HIDDEN_FOR.includes(purpose))
            return keys;
        const spaceIndex = keys.findIndex(k => !k.action && k.strings?.[0] === ' ');
        const space = keys[spaceIndex];
        const spaceWidth = space?.width ?? 1;
        if (spaceIndex < 0 || spaceWidth < 3)
            return keys;
        const micWidth = Math.min(1.5, spaceWidth - 2);
        const row = keys.slice();
        row.splice(spaceIndex, 1,
            {action: KEY_ACTION, iconName: MIC_ICON, width: micWidth},
            {...space, width: spaceWidth - micWidth});
        return row;
    }

    _adoptMicKey(key) {
        this._micKeys.add(key);
        key.connect('destroy', () => this._micKeys.delete(key));
        // On touch-down rather than release: the mic takes ~250 ms to open.
        key.connect('pressed', () => this._onMicPressed());
        this._styleKey(key);
    }

    _onMicPressed() {
        if (['idle', 'loading'].includes(this._state))
            this._start().catch(e => console.error(`osk-dictation: ${e.message}`));
        else if (['starting', 'listening'].includes(this._state))
            this._call('Stop');
    }

    async _start() {
        this._onState('starting');
        const context = await this._textBeforeCursor();
        if (!await this._call('Start', context, 'normal'))
            this._onState('idle');
    }

    // The text before the cursor in the focused field, so the service can fit
    // spacing and capitals to it. Empty if the app doesn't report it in time.
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
            const reason = e.message.replace(/^GDBus\.Error:[\w.]+: /, '');
            console.warn(`osk-dictation: ${method} failed: ${reason}`);
            if (method !== 'Prepare')
                Main.notify('Dictation', reason);
            return false;
        }
    }

    _onState(state) {
        if (state.startsWith('error:')) {
            Main.notify('Dictation', state.slice('error:'.length));
            return;
        }
        this._state = state;
        for (const key of this._micKeys)
            this._styleKey(key);
    }

    _styleKey(key) {
        const button = key.keyButton;
        if (this._state === 'listening')
            button.add_style_class_name('osk-dictation-listening');
        else
            button.remove_style_class_name('osk-dictation-listening');
        if (BUSY_STATES.includes(this._state))
            button.add_style_class_name('osk-dictation-busy');
        else
            button.remove_style_class_name('osk-dictation-busy');
    }

    _onFinal(text, replace) {
        // Retry (replace) arrives in phase 4, along with undo.
        if (replace || !text)
            return;
        const controller = Main.keyboard.keyboardActor?._keyboardController;
        if (controller)
            controller.commit(text).catch(e => console.error(`osk-dictation: ${e.message}`));
        else
            Main.inputMethod.commit(text);
    }
}
