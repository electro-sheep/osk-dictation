// Test only. In a headless shell: focuses the target app, waits for the
// on-screen keyboard, clicks the mic key with a virtual pointer, lets the
// service dictate for a while, clicks again, and writes what happened (plus
// screenshots) to $OSK_TEST_OUT.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');

const OUT = GLib.getenv('OSK_TEST_OUT');
const SPEAK_MS = Number(GLib.getenv('OSK_TEST_SPEAK_SECONDS') ?? '12') * 1000;

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function until(condition, ms, what) {
    const end = GLib.get_monotonic_time() + ms * 1000;
    while (GLib.get_monotonic_time() < end) {
        if (condition())
            return;
        await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
}

export default class TestDriver extends Extension {
    enable() {
        this._log = [];
        this._t0 = GLib.get_monotonic_time();
        this._run()
            .then(() => this._write({ok: true}))
            .catch(e => this._write({ok: false, error: `${e.message}\n${e.stack}`}));
    }

    disable() {
        if (this._pollId)
            GLib.source_remove(this._pollId);
    }

    _note(message) {
        this._log.push(`${((GLib.get_monotonic_time() - this._t0) / 1e6).toFixed(2)}s ${message}`);
    }

    _write(result) {
        const data = JSON.stringify({
            ...result,
            log: this._log,
            states: this._states,
            levelColours: this._levelStyles?.size ?? 0,
            sawPreedit: this._sawPreedit ?? false,
        }, null, 1);
        GLib.file_set_contents(`${OUT}/result.json`, data);
    }

    async _screenshot(name) {
        const file = Gio.File.new_for_path(`${OUT}/${name}`);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
        this._note(`screenshot ${name}`);
    }

    async _click(actor) {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._pointer ??= seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + w / 2, y + h / 2);
        await sleep(50);
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await sleep(80);
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    }

    async _run() {
        await until(() => Main.extensionManager.lookup('osk-dictation@electro')?.stateObj?._micKeys,
            15000, 'the osk-dictation extension');
        const dictation = Main.extensionManager.lookup('osk-dictation@electro').stateObj;
        this._note('osk-dictation enabled');

        // Record every state the extension goes through, the colours the
        // listening key takes (the level meter), and whether preedit was shown.
        this._states = [];
        this._levelStyles = new Set();
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            if (this._states.at(-1) !== dictation._state)
                this._states.push(dictation._state);
            if (this._key && dictation._state === 'listening')
                this._levelStyles.add(this._key.keyButton.get_style());
            if (dictation._preedit)
                this._sawPreedit = true;
            return GLib.SOURCE_CONTINUE;
        });

        const findWindow = () => global.display.list_all_windows().find(w => w.title === 'dictation target');
        await until(findWindow, 30000, 'the target window');
        Main.overview.hide();
        // Right after startup the shell may hand focus to the other window
        // instead, so keep asking until the target really has it.
        await until(() => {
            if (global.display.focus_window === findWindow())
                return true;
            Main.activateWindow(findWindow());
            return false;
        }, 10000, 'focus on the target window');
        this._note(`target window activated: focus ${global.display.focus_window?.title}`);
        global.display.connect('notify::focus-window',
            () => this._note(`focus-window changed to ${global.display.focus_window?.title}`));

        try {
            await until(() => Main.keyboard.visible, 8000, 'the keyboard to open');
        } catch {
            this._note('keyboard did not open by itself; opening it');
            Main.keyboard.open(Main.layoutManager.primaryIndex);
            await until(() => Main.keyboard.visible, 5000, 'the keyboard to open');
        }
        await sleep(700);  // let the slide-in animation finish
        this._note('keyboard visible');

        const keyboard = Main.keyboard.keyboardActor;
        const icons = [];
        const walk = actor => {
            if (actor._icon?.icon_name && actor.mapped)
                icons.push(actor._icon.icon_name);
            actor.get_children().forEach(walk);
        };
        walk(keyboard);
        this._note(`visible key icons: ${icons.join(', ')}; purpose ${keyboard._purpose}`);
        await until(() => [...dictation._micKeys].some(k => k.mapped), 5000, 'a visible mic key');
        const key = this._key = [...dictation._micKeys].find(k => k.mapped);
        this._note(`mic keys: ${dictation._micKeys.size}, width ${key.width.toFixed(0)} px`);
        await this._screenshot('keyboard.png');

        await this._click(key.keyButton);
        this._note('clicked mic');
        await until(() => dictation._state === 'listening', 15000, 'listening');
        this._note(`listening; key classes: ${key.keyButton.get_style_class_name()}`);
        await sleep(400);
        await this._screenshot('listening.png');

        await sleep(5000);
        this._note(`live text now: ${JSON.stringify(dictation._preedit)}`);
        await this._screenshot('live.png');
        await sleep(Math.max(0, SPEAK_MS - 5000));
        await this._click(key.keyButton);
        this._note('clicked mic again');
        await until(() => dictation._state === 'idle', 30000, 'idle');
        this._note(`idle; key classes: ${key.keyButton.get_style_class_name()}; style ${key.keyButton.get_style()}`);
        await sleep(1000);
        await this._screenshot('done.png');

        // Switching windows mid-dictation must drop the session, not type into
        // the newly focused window.
        await this._click(key.keyButton);
        await until(() => dictation._state === 'listening', 15000, 'listening (second session)');
        await sleep(4000);
        const other = global.display.list_all_windows().find(w => w.title === 'other window');
        this._note(`before switch: focus ${global.display.focus_window?.title}, ` +
            `session window ${dictation._sessionWindow?.title}`);
        Main.activateWindow(other);
        await sleep(300);
        this._note(`switched to the other window mid-dictation: focus now ${global.display.focus_window?.title}`);
        await until(() => dictation._state === 'idle', 10000, 'idle after the window switch');
        this._note(`idle after switch; preedit ${JSON.stringify(dictation._preedit)}`);
        await sleep(3000);  // anything that was going to leak in would have by now
    }
}
