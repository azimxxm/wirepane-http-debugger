import { observable } from 'mobx';
import { User } from '@httptoolkit/accounts';

import { lazyObservablePromise } from '../../util/observable';

// Wirepane is free: every feature is open to everyone, with no account, login or subscription.
// This user passes every paid-feature check, so the rest of the UI works unchanged.
const FULL_ACCESS_USER: User = {
    banned: false,
    featureFlags: [],
    isStatusUnexpired: () => true,
    isPaidUser: () => true,
    isPastDueUser: () => false,
    userHasSubscription: () => false
};

export class AccountStore {

    readonly initialized = lazyObservablePromise(async () => {
        console.log('Account store initialized');
    });

    readonly user: User = FULL_ACCESS_USER;

    readonly featureFlags: string[] = [];

    // Upstream stores watch this to drop paid settings when an account loses its plan.
    // There are no accounts here, so it never changes.
    @observable
    accountDataLastUpdated = 0;

    // Everyone has full access from the start, there's no account data to wait for
    readonly mightBePaidUser = true;

    // Upstream's "Get Pro" prompts still call this. They never show up (everyone passes
    // isPaidUser) and there's nothing to buy, so it does nothing.
    getPro = (_source: string) => {};
}
