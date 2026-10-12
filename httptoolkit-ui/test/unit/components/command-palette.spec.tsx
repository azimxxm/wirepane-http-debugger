import * as React from 'react';
import * as ReactDOM from 'react-dom';

import { expect } from '../../test-setup';

import { ThemeProvider, lightTheme } from '../../../src/styles';
import { formatShortcut } from '../../../src/util/shortcuts';
import { AppAction, AppActionId, AppActionSection } from '../../../src/model/ui/app-actions';
import { CommandPalette } from '../../../src/components/command-palette';

const testAction = (
    id: AppActionId,
    section: AppActionSection,
    label: string,
    extra: Partial<AppAction> = {}
): AppAction => ({ id, section, label, enabled: true, run: () => {}, ...extra });

const ACTIONS = [
    testAction('go-view', 'Go', 'Go to View', { shortcut: 'Cmd+2' }),
    testAction('go-send', 'Go', 'Go to Send', { shortcut: 'Cmd+4' }),
    testAction('clear-traffic', 'Capture', 'Clear traffic', { enabled: false, description: 'Nothing captured yet' }),
    testAction('export-har', 'Capture', 'Export HAR…')
];

describe('Command palette', () => {

    let container: HTMLDivElement;
    let ran: string[];
    let closed: number;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        ran = [];
        closed = 0;

        ReactDOM.render(
            <ThemeProvider theme={lightTheme}>
                <CommandPalette
                    actions={ACTIONS}
                    onRun={(action) => ran.push(action.id)}
                    onClose={() => closed++}
                />
            </ThemeProvider>,
            container
        );
    });

    afterEach(() => {
        ReactDOM.unmountComponentAtNode(container);
        container.remove();
    });

    const input = () => container.querySelector('input[role=combobox]') as HTMLInputElement;
    const options = () => Array.from(container.querySelectorAll('[role=option]')) as HTMLElement[];
    const optionLabels = () => options().map((option) =>
        option.querySelector('span > span')!.textContent
    );
    const activeOption = () => {
        const id = input().getAttribute('aria-activedescendant');
        return id ? document.getElementById(id) : null;
    };

    const press = (key: string, init: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
        input().dispatchEvent(event);
        return event;
    };

    const type = (text: string) => {
        // React tracks the input's value, so it has to be set through the native setter:
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setValue.call(input(), text);
        input().dispatchEvent(new Event('input', { bubbles: true }));
    };

    it('opens as a modal dialog with the search field focused', () => {
        const dialog = container.querySelector('dialog')!;

        expect(dialog.matches(':modal')).to.equal(true);
        expect(dialog.getAttribute('aria-label')).to.equal('Command palette');
        expect(document.activeElement).to.equal(input());
    });

    it('lists every action in its section, with its shortcut', () => {
        const groups = Array.from(container.querySelectorAll('[role=group]'));

        expect(groups.map((group) => group.querySelector('[role=presentation]')!.textContent))
            .to.deep.equal(['Go', 'Capture']);
        expect(optionLabels()).to.deep.equal(['Go to View', 'Go to Send', 'Clear traffic', 'Export HAR…']);
        expect(options()[0].querySelector('kbd')!.textContent).to.equal(formatShortcut('Cmd+2'));
        expect(options()[0].getAttribute('aria-keyshortcuts')).to.match(/^(Meta|Control)\+2$/);
    });

    it('starts on the first action, and moves with the arrow keys, skipping disabled ones', () => {
        expect(activeOption()!.textContent).to.contain('Go to View');
        expect(activeOption()!.getAttribute('aria-selected')).to.equal('true');

        press('ArrowDown');
        expect(activeOption()!.textContent).to.contain('Go to Send');

        press('ArrowDown'); // Clear traffic is disabled
        expect(activeOption()!.textContent).to.contain('Export HAR');

        press('ArrowDown'); // Around to the top again
        expect(activeOption()!.textContent).to.contain('Go to View');

        press('ArrowUp');
        expect(activeOption()!.textContent).to.contain('Export HAR');

        expect(options().filter((option) => option.getAttribute('aria-selected') === 'true')).to.have.length(1);
        expect(options()[2].getAttribute('aria-disabled')).to.equal('true');
    });

    it('runs the active action with Enter', () => {
        press('ArrowDown');
        const enter = press('Enter');

        expect(ran).to.deep.equal(['go-send']);
        expect(enter.defaultPrevented).to.equal(true);
    });

    it('filters as you type, with the best match active', () => {
        type('send');

        expect(optionLabels()).to.deep.equal(['Go to Send']);
        expect(activeOption()!.textContent).to.contain('Go to Send');
        // The matched letters are highlighted:
        expect(options()[0].querySelector('strong')!.textContent).to.equal('Send');

        press('Enter');
        expect(ran).to.deep.equal(['go-send']);
    });

    it('says when nothing matches, and Enter does nothing', () => {
        type('zzz');

        expect(options()).to.have.length(0);
        expect(input().hasAttribute('aria-activedescendant')).to.equal(false);
        expect(container.querySelector('[role=status]')!.textContent).to.contain('No commands match “zzz”');

        press('Enter');
        expect(ran).to.deep.equal([]);
    });

    it('runs a clicked action, but not a disabled one', () => {
        options()[2].click(); // Clear traffic, disabled
        options()[3].click();

        expect(ran).to.deep.equal(['export-har']);
    });

    it('keeps Tab in the search field', () => {
        expect(press('Tab').defaultPrevented).to.equal(true);
        expect(press('Tab', { shiftKey: true }).defaultPrevented).to.equal(true);
    });

    it("keeps Escape from the page's own shortcuts, and closes when cancelled", () => {
        const seenByPage: string[] = [];
        const pageListener = (event: KeyboardEvent) => seenByPage.push(event.key);
        document.addEventListener('keydown', pageListener);

        try {
            press('Escape');
            // Other shortcuts, like ⌘K to close the palette again, still reach the page:
            press('k', { metaKey: true });
        } finally {
            document.removeEventListener('keydown', pageListener);
        }
        expect(seenByPage).to.deep.equal(['k']);

        // The browser fires cancel for Escape on a modal dialog:
        container.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
        expect(closed).to.equal(1);
    });

});
