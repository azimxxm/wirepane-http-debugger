import { expect } from '../../../test-setup';

import {
    ColumnsStorage,
    LIST_COLUMNS,
    LIST_COLUMNS_STORAGE_KEY,
    ListColumnsStore
} from '../../../../src/model/ui/list-columns-store';

class MemoryStorage implements ColumnsStorage {
    readonly items = new Map<string, string>();

    async getItem(key: string) {
        return this.items.get(key) ?? null;
    }

    async setItem(key: string, value: string) {
        this.items.set(key, value);
    }
}

async function createStore(storage: ColumnsStorage) {
    const store = new ListColumnsStore(storage);
    await store.initialized;
    return store;
}

const visibleColumns = (store: ListColumnsStore) =>
    LIST_COLUMNS.filter((column) => store.isVisible(column));

describe('List columns store', () => {

    let storage: MemoryStorage;

    beforeEach(() => {
        storage = new MemoryStorage();
    });

    it('shows Type by default, and keeps Time, Duration & Size opt-in', async () => {
        const store = await createStore(storage);
        expect(visibleColumns(store)).to.deep.equal(['type']);
    });

    it('saves column choices, and a new session restores them', async () => {
        const store = await createStore(storage);
        store.toggle('duration');
        store.setVisible('size', true);
        store.setVisible('type', false);

        expect(visibleColumns(store)).to.deep.equal(['duration', 'size']);
        expect(JSON.parse(storage.items.get(LIST_COLUMNS_STORAGE_KEY)!)).to.deep.equal({
            choices: { duration: true, size: true, type: false }
        });

        const restored = await createStore(storage);
        expect(visibleColumns(restored)).to.deep.equal(['duration', 'size']);
    });

    it('keeps the default for columns the user never chose', async () => {
        // e.g. saved before Size existed
        storage.items.set(LIST_COLUMNS_STORAGE_KEY, JSON.stringify({ choices: { time: true } }));

        const store = await createStore(storage);
        expect(visibleColumns(store)).to.deep.equal(['type', 'time']);
    });

    it('ignores saved data it does not understand', async () => {
        storage.items.set(LIST_COLUMNS_STORAGE_KEY, JSON.stringify({ choices: { time: 'yes', type: 0 } }));
        expect(visibleColumns(await createStore(storage))).to.deep.equal(['type']);

        storage.items.set(LIST_COLUMNS_STORAGE_KEY, '{ not json');
        const store = await createStore(storage);
        expect(visibleColumns(store)).to.deep.equal(['type']);

        // ...and still saves new choices over it
        store.setVisible('time', true);
        expect(visibleColumns(await createStore(storage))).to.deep.equal(['type', 'time']);
    });

    it('can go back to the default columns', async () => {
        const store = await createStore(storage);
        store.setVisible('time', true);
        store.setVisible('type', false);

        store.resetToDefaults();
        expect(visibleColumns(store)).to.deep.equal(['type']);
        expect(visibleColumns(await createStore(storage))).to.deep.equal(['type']);
    });

    it('opens the columns menu under its button or at the pointer, without saving that', async () => {
        const store = await createStore(storage);

        store.openOptionsMenu();
        expect(store.optionsMenu).to.deep.equal({ anchor: 'button' });

        store.openOptionsMenu({ x: 120, y: 48 });
        expect(store.optionsMenu).to.deep.equal({ anchor: 'pointer', x: 120, y: 48 });

        store.closeOptionsMenu();
        expect(store.optionsMenu).to.equal(undefined);
        expect(storage.items.has(LIST_COLUMNS_STORAGE_KEY)).to.equal(false);
    });
});
