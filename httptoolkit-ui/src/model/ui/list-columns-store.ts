import { action, observable } from 'mobx';

import { lazyObservablePromise } from '../../util/observable';
import { persist, hydrate } from '../../util/mobx-persist/persist';
import * as LocalStorage from '../../util/mobx-persist/storage';

/*
 * Wirepane: the columns View's list shows besides the fixed ones (method, status, source,
 * host & path). Type is on by default, Time, Duration & Size are opt-in. The choice is
 * kept in localStorage, like the Devices panel's layout.
 */
export const LIST_COLUMNS = ['type', 'time', 'duration', 'size'] as const;
export type ListColumn = typeof LIST_COLUMNS[number];

export const LIST_COLUMN_LABELS: { readonly [column in ListColumn]: string } = {
    type: 'Type',
    time: 'Time',
    duration: 'Duration',
    size: 'Size'
};

export const LIST_COLUMN_DESCRIPTIONS: { readonly [column in ListColumn]: string } = {
    type: 'What kind of resource it is: document, fetch/XHR, script, image…',
    time: 'When the request started',
    duration: 'How long the response took, from the request starting until it was sent',
    size: 'The size of the response body, as sent'
};

const DEFAULT_VISIBILITY: { readonly [column in ListColumn]: boolean } = {
    type: true,
    time: false,
    duration: false,
    size: false
};

export const LIST_COLUMNS_STORAGE_KEY = 'view-list-columns';

// The part of mobx-persist's storage the store needs. Tests pass an in-memory one.
export interface ColumnsStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<unknown>;
}

export class ListColumnsStore {

    constructor(
        private readonly storage: ColumnsStorage = LocalStorage
    ) { }

    readonly initialized = lazyObservablePromise(async () => {
        const hydrateFromStorage = () => hydrate({
            key: LIST_COLUMNS_STORAGE_KEY,
            store: this,
            storage: this.storage as typeof LocalStorage
        });

        try {
            await hydrateFromStorage();
        } catch (e) {
            // Only column choices are saved, so the defaults are fine. Unreadable data is
            // replaced, so that new choices are saved again.
            console.warn("Couldn't restore the list's columns", e);
            try {
                await this.storage.setItem(LIST_COLUMNS_STORAGE_KEY, JSON.stringify({ choices: {} }));
                await hydrateFromStorage();
            } catch (e) {
                console.warn("Couldn't save the list's columns", e);
            }
        }
    });

    // Only the user's own choices are saved, so a column added later still gets its default
    @persist('object') @observable
    private choices: { [column: string]: unknown } = {};

    isVisible(column: ListColumn): boolean {
        const choice = this.choices[column];
        return typeof choice === 'boolean' ? choice : DEFAULT_VISIBILITY[column];
    }

    @action.bound
    setVisible(column: ListColumn, visible: boolean) {
        this.choices = { ...this.choices, [column]: visible };
    }

    @action.bound
    toggle(column: ListColumn) {
        this.setVisible(column, !this.isVisible(column));
    }

    @action.bound
    resetToDefaults() {
        this.choices = {};
    }

    // Where the columns menu is open: under its button, or at the pointer after a
    // right-click on the header. Not saved.
    @observable.ref
    optionsMenu: ListOptionsMenuAnchor | undefined;

    @action.bound
    openOptionsMenu(pointer?: { x: number, y: number }) {
        this.optionsMenu = pointer
            ? { anchor: 'pointer', x: pointer.x, y: pointer.y }
            : { anchor: 'button' };
    }

    @action.bound
    closeOptionsMenu() {
        this.optionsMenu = undefined;
    }
}

export type ListOptionsMenuAnchor =
    | { anchor: 'button' }
    | { anchor: 'pointer', x: number, y: number };
