import { expect } from '../../../test-setup';

import { buildNativeContextMenuItems, ContextMenuItem } from '../../../../src/model/ui/context-menu';

describe('Native context menu items', () => {

    it('keep their accelerators, so the native menu shows them', () => {
        const noop = () => {};
        const items: ContextMenuItem<void>[] = [
            { type: 'option', label: 'Toggle Pinning', accelerator: 'CmdOrCtrl+P', callback: noop },
            { type: 'separator' },
            {
                type: 'submenu',
                label: 'More',
                items: [
                    { type: 'option', label: 'Rename…', accelerator: 'F2', callback: noop },
                    { type: 'option', label: 'Copy', callback: noop }
                ]
            }
        ];

        const nativeItems = buildNativeContextMenuItems(items) as any[];

        expect(nativeItems[0]).to.deep.equal({
            type: 'option',
            label: 'Toggle Pinning',
            accelerator: 'CmdOrCtrl+P',
            callback: undefined, // Callbacks can't be sent over IPC
            id: '0'
        });
        expect(nativeItems[2].items[0]).to.include({ accelerator: 'F2', id: '2.items.0' });
        expect(nativeItems[2].items[1].accelerator).to.equal(undefined);
    });

});
