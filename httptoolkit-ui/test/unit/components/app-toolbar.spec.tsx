import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';

import { expect } from '../../test-setup';

import { ThemeProvider, lightTheme } from '../../../src/styles';
import { AppToolbar } from '../../../src/components/app-toolbar';
import { PageHeader } from '../../../src/components/common/page-header';
import { closeCommandPalette, commandPaletteState } from '../../../src/model/ui/command-palette-state';

describe('App toolbar', () => {

    let container: HTMLDivElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        act(() => { ReactDOM.unmountComponentAtNode(container); });
        container.remove();
        closeCommandPalette();
    });

    const render = (page: React.ReactElement) => act(() => {
        ReactDOM.render(<ThemeProvider theme={lightTheme}>
            <AppToolbar />
            <main>{ page }</main>
        </ThemeProvider>, container);
    });

    const toolbar = () => container.querySelector('header[aria-label="Toolbar"]') as HTMLElement;
    const commandField = () => toolbar().querySelector('button[aria-label="Search or run a command"]') as HTMLButtonElement;

    it("shows the page's title, purpose and actions in the toolbar, not in the page", () => {
        render(<>
            <PageHeader title='View' purpose='Every request that passes through Wirepane.'>
                <button>Clear</button>
            </PageHeader>
            <p>Page content</p>
        </>);

        expect(toolbar().querySelector('h1')!.textContent).to.equal('View');
        expect(toolbar().textContent).to.include('Every request that passes through Wirepane.');
        expect(Array.from(toolbar().querySelectorAll('button')).map((b) => b.textContent))
            .to.include('Clear');
        expect(container.querySelector('main')!.textContent).to.equal('Page content');
        expect(document.title).to.equal('View — Wirepane');
    });

    it('keeps the toolbar in sync when the page changes', () => {
        render(<PageHeader title='View' purpose='Inspect traffic.'><button>Clear</button></PageHeader>);
        render(<PageHeader title='Settings' purpose='Reconfigure Wirepane.' />);

        expect(toolbar().querySelector('h1')!.textContent).to.equal('Settings');
        expect(toolbar().textContent).not.to.include('Inspect traffic.');
        expect(Array.from(toolbar().querySelectorAll('button')).map((b) => b.textContent))
            .not.to.include('Clear');
        expect(document.title).to.equal('Settings — Wirepane');
    });

    it('shows sub-pages as a breadcrumb, with a clickable parent', () => {
        let wentBack = 0;
        render(<PageHeader
            title='iPhone or iPad'
            purpose="Send an iPhone's traffic through Wirepane."
            parent={{
                label: 'Intercept',
                description: 'Back to all sources',
                onSelect: () => { wentBack++; },
                shortcut: 'Cmd+['
            }}
        />);

        const parent = Array.from(toolbar().querySelectorAll('button'))
            .find((button) => button.textContent === 'Intercept')!;
        expect(parent.title).to.match(/^Back to all sources \((⌘\[|Ctrl\+\[)\)$/);
        expect(toolbar().querySelector('h1')!.textContent).to.equal('iPhone or iPad');
        expect(document.title).to.equal('Intercept › iPhone or iPad — Wirepane');

        act(() => { parent.click(); });
        expect(wentBack).to.equal(1);
    });

    it('comes first in the keyboard order: breadcrumb, search, then page actions', () => {
        render(<PageHeader
            title='GET /todos/1'
            purpose='Every request.'
            parent={{ label: 'View', description: 'Close the inspector', onSelect: () => {} }}
        >
            <button>Clear</button>
        </PageHeader>);

        const focusable = Array.from(toolbar().querySelectorAll('button, input, a[href]'))
            .map((element) => element.getAttribute('aria-label') ?? element.textContent);
        expect(focusable).to.deep.equal(['View', 'Search or run a command', 'Clear']);
    });

    it('opens the command palette from its search field', () => {
        render(<PageHeader title='View' purpose='Every request.' />);

        act(() => { commandField().click(); });
        expect(commandPaletteState.isOpen).to.equal(true);
        expect(commandPaletteState.initialQuery).to.equal('');
    });

    it('opens the palette with whatever is typed into the field', () => {
        render(<PageHeader title='View' purpose='Every request.' />);

        const typed = new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true });
        act(() => { commandField().dispatchEvent(typed); });

        expect(typed.defaultPrevented).to.equal(true);
        expect(commandPaletteState.isOpen).to.equal(true);
        expect(commandPaletteState.initialQuery).to.equal('e');
    });

    it('leaves shortcuts typed into the field alone', () => {
        render(<PageHeader title='View' purpose='Every request.' />);

        const shortcut = new KeyboardEvent('keydown', { key: 'r', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true });
        act(() => { commandField().dispatchEvent(shortcut); });

        expect(shortcut.defaultPrevented).to.equal(false);
        expect(commandPaletteState.isOpen).to.equal(false);
    });
});
