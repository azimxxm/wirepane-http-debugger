import { observable } from 'mobx';
import { User } from '@httptoolkit/accounts';

import { lazyObservablePromise } from '../../util/observable';

// Upstream turns some features on per account with these flags. Wirepane turns on:
// - 'raw-tunnels': connections the proxy can't read as HTTP or TLS go straight through to
//   their destination and show up in View as raw tunnels, instead of getting a 400 back
//   (proxy-store.ts). Apps hooked with Frida also reach the proxy over SOCKS, so it knows
//   where their non-HTTP connections were going and can tunnel them too (frida-config.tsx).
// The other upstream flags ('arc-browser', 'tls-mirroring') stay off.
const FEATURE_FLAGS = ['raw-tunnels'];

// Wirepane is free: every feature is open to everyone, with no account, login or subscription.
// This user passes every paid-feature check, so the rest of the UI works unchanged.
const FULL_ACCESS_USER: User = {
    banned: false,
    featureFlags: FEATURE_FLAGS,
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

    // Like upstream, the flags are the user's
    readonly featureFlags: string[] = this.user.featureFlags;

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
