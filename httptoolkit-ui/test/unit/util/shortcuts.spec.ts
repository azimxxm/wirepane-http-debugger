import { expect } from '../../test-setup';

import {
    formatAccelerator,
    formatShortcut,
    toAccelerator,
    toAriaShortcut,
    toHotkeys
} from '../../../src/util/shortcuts';

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

    it('should show the Ctrl & Tab keys as symbols on macOS', () => {
        expect(formatShortcut('Ctrl+Tab', true)).to.equal('⌃⇥');
        expect(formatShortcut('Ctrl+Tab', false)).to.equal('Ctrl+Tab');
        expect(formatShortcut('Cmd+Shift+]', true)).to.equal('⌘⇧]');
        expect(formatShortcut('Cmd+,', true)).to.equal('⌘,');
        expect(formatShortcut('Cmd+,', false)).to.equal('Ctrl+,');
    });

    it('should format Electron accelerators like shortcuts', () => {
        expect(formatAccelerator('CmdOrCtrl+Shift+S', true)).to.equal('⌘⇧S');
        expect(formatAccelerator('CmdOrCtrl+Shift+S', false)).to.equal('Ctrl+Shift+S');
        expect(formatAccelerator('CommandOrControl+Backspace', true)).to.equal('⌘⌫');
        expect(formatAccelerator('Control+Option+K', true)).to.equal('⌃⌥K');
        expect(formatAccelerator('F2', true)).to.equal('F2');
        expect(formatAccelerator(toAccelerator('Cmd+P'), false)).to.equal('Ctrl+P');
    });

    it('should listen for the platform modifier only', () => {
        expect(toHotkeys('Cmd+K', true)).to.equal('Cmd+K');
        expect(toHotkeys('Cmd+K', false)).to.equal('Ctrl+K');
        expect(toHotkeys('Cmd+Shift+]', false)).to.equal('Ctrl+Shift+]');
    });

});
