// Test only. Exercises OSK Plus in a headless shell: space-bar cursor, a swipe
// for "hello", the settings panel and a theme change, and dictation from the
// bar mic. Writes result.json and screenshots to $OSK_TEST_OUT.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');

const OUT = GLib.getenv('OSK_TEST_OUT');
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => r() ?? GLib.SOURCE_REMOVE));
const read = name => {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(`${OUT}/${name}`)[1]);
    } catch {
        return '';
    }
};

async function until(condition, ms, what) {
    const end = GLib.get_monotonic_time() + ms * 1000;
    while (GLib.get_monotonic_time() < end) {
        if (condition())
            return;
        await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
}

export default class Driver extends Extension {
    enable() {
        this._log = [];
        this._checks = {};
        this._t0 = GLib.get_monotonic_time();
        this._run().then(() => this._write(true)).catch(e => {
            this._log.push(`ERROR ${e.message}\n${e.stack}`);
            this._write(false);
        });
    }

    disable() {}

    _note(m) {
        this._log.push(`${((GLib.get_monotonic_time() - this._t0) / 1e6).toFixed(1)}s ${m}`);
    }

    _write(ok) {
        GLib.file_set_contents(`${OUT}/result.json`, JSON.stringify({ok, checks: this._checks, log: this._log}, null, 1));
    }

    async _shot(name) {
        const stream = Gio.File.new_for_path(`${OUT}/${name}`).replace(null, false, Gio.FileCreateFlags.NONE, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
    }

    _pointer() {
        this._ptr ??= Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        return this._ptr;
    }

    _centre(actor) {
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        return [x + w / 2, y + h / 2];
    }

    async _move(x, y) {
        this._pointer().notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        await sleep(16);
    }

    async _button(state) {
        this._pointer().notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, state);
        await sleep(30);
    }

    async _click(actor) {
        await this._move(...this._centre(actor));
        await this._button(Clutter.ButtonState.PRESSED);
        await sleep(60);
        await this._button(Clutter.ButtonState.RELEASED);
    }

    async _run() {
        await until(() => Main.extensionManager.lookup('osk-plus@electro')?.stateObj?._injections, 15000, 'OSK Plus');
        const plus = Main.extensionManager.lookup('osk-plus@electro').stateObj;
        const target = () => global.display.list_all_windows().find(w => w.title === 'dictation target');
        await until(target, 30000, 'the target window');
        Main.overview.hide();
        await until(() => {
            if (global.display.focus_window === target())
                return true;
            Main.activateWindow(target());
            return false;
        }, 10000, 'focus on the target');
        if (!Main.keyboard.visible)
            Main.keyboard.open(Main.layoutManager.primaryIndex);
        await until(() => Main.keyboard.visible && plus._keyboard, 8000, 'the keyboard');
        await sleep(900);
        const kb = plus._keyboard;
        this._checks.portrait = plus._isPortrait();
        this._checks.keyboardSize = `${kb.width}x${kb.height}`;
        this._checks.bar = Boolean(plus._bar?.mapped);
        await this._shot('keyboard.png');
        this._note('keyboard shown');

        // Space-bar cursor: slide left five steps, then back right three.
        const keys = kb._currentPage.get_children();
        const space = keys.find(k => plus._keyInfo.get(k)?.kind === 'space' && k.mapped);
        const before = Number(read('cursor.txt'));
        const [sx, sy] = this._centre(space.keyButton);
        await this._move(sx, sy);
        await this._button(Clutter.ButtonState.PRESSED);
        for (let i = 1; i <= 12; i++)
            await this._move(sx - i * 8, sy);   // 96 px: (96 - 12) / 16 = 5 steps
        await this._button(Clutter.ButtonState.RELEASED);
        await sleep(300);
        const afterLeft = Number(read('cursor.txt'));
        await this._move(sx, sy);
        await this._button(Clutter.ButtonState.PRESSED);
        for (let i = 1; i <= 8; i++)
            await this._move(sx + i * 8, sy);   // 64 px: (64 - 12) / 16 = 3 steps
        await this._button(Clutter.ButtonState.RELEASED);
        await sleep(300);
        this._checks.cursor = {before, afterLeft, afterRight: Number(read('cursor.txt')), typed: read('typed.txt')};
        this._note(`cursor ${JSON.stringify(this._checks.cursor)}`);
        // Put the cursor back at the end for the swipe.
        const end = Number(this._checks.cursor.before);
        const back = end - this._checks.cursor.afterRight;
        for (let i = 0; i < back; i++) {
            kb._keyboardController.keyvalPress(Clutter.KEY_Right);
            kb._keyboardController.keyvalRelease(Clutter.KEY_Right);
        }
        await sleep(200);

        // Swipe "hello" through the key centres, with a few in-between points.
        const [centres] = plus._letterCentres();
        const path = [];
        const word = 'hello';
        for (let i = 0; i < word.length - 1; i++) {
            const [ax, ay] = centres[word[i]], [bx, by] = centres[word[i + 1]];
            for (let t = 0; t < 1; t += 0.2)
                path.push([ax + (bx - ax) * t + 3 * Math.sin(i + t * 6), ay + (by - ay) * t]);
        }
        path.push(centres.o);
        await this._move(...path[0]);
        await this._button(Clutter.ButtonState.PRESSED);
        for (const [i, [x, y]] of path.entries()) {
            await this._move(x, y);
            if (i === path.length - 3)
                await this._shot('swipe.png');
        }
        await this._button(Clutter.ButtonState.RELEASED);
        await until(() => /hello/i.test(read('typed.txt')), 15000, 'the swiped word');
        await sleep(400);
        this._checks.swipe = {typed: read('typed.txt'), chips: plus._chips.get_children().map(c => c.label ?? c.text)};
        await this._shot('suggestions.png');
        this._note(`swipe ${JSON.stringify(this._checks.swipe)}`);

        // Settings: open, switch to the Latte theme, screenshot, back to Desktop.
        const settingsButton = plus._bar.get_children().at(-1);
        await this._click(settingsButton);
        await sleep(400);
        this._checks.settingsOpen = plus._settingsPanel.visible;
        await this._shot('settings.png');
        await this._click(plus._themeButtons.get('latte'));
        await sleep(500);
        await this._shot('settings-latte.png');
        await this._click(plus._settingsPanel.get_children().at(-1).get_children().at(-1));  // Done
        await sleep(400);
        await this._shot('keyboard-latte.png');
        this._checks.themeSaved = read('config/osk-dictation/keyboard.json');
        await this._click(settingsButton);
        await sleep(300);
        await this._click(plus._themeButtons.get('desktop'));
        await this._click(plus._settingsPanel.get_children().at(-1).get_children().at(-1));
        await sleep(300);

        // Dictation from the bar mic.
        const typedBefore = read('typed.txt');
        await this._click(plus._micButton);
        await until(() => plus._state === 'listening', 15000, 'listening');
        await sleep(5000);
        await this._shot('dictating.png');
        await this._click(plus._micButton);
        await until(() => plus._state === 'idle', 30000, 'idle after dictation');
        await sleep(800);
        this._checks.dictated = read('typed.txt').slice(typedBefore.length);
        this._note('done');
    }
}
