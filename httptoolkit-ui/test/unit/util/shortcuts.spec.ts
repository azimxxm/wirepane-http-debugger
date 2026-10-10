import { expect } from '../../test-setup';

import { formatShortcut, toAccelerator, toAriaShortcut } from '../../../src/util/shortcuts';

describe('Shortcut formatting', () => {

    it('should use symbols on macOS', () => {
        expect(formatShortcut('Cmd+M', true)).to.equal('⌘M');
        expect(formatShortcut('Cmd+Shift+R', true)).to.equal('⌘⇧R');
        expect(formatShortcut('Cmd+Backspace', true)).to.equal('⌘⌫');
        expect(formatShortcut('Cmd+Enter', true)).to.equal('⌘↵');
    });

    it('should use key names elsewhere', () => {
        expect(formatShortcut('Cmd+m', false)).to.equal('Ctrl+M');
        expect(formatShortcut('Cmd+Shift+R', false)).to.equal('Ctrl+Shift+R');
        expect(formatShortcut('Cmd+Backspace', false)).to.equal('Ctrl+Backspace');
    });

    it('should build Electron accelerators', () => {
        expect(toAccelerator('Cmd+P')).to.equal('CmdOrCtrl+P');
        expect(toAccelerator('Cmd+Shift+Backspace')).to.equal('CmdOrCtrl+Shift+Backspace');
    });

    it('should build aria-keyshortcuts values', () => {
        expect(toAriaShortcut('Cmd+M', true)).to.equal('Meta+M');
        expect(toAriaShortcut('Cmd+Shift+R', false)).to.equal('Control+Shift+R');
    });

});
