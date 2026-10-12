import { expect } from '../../../test-setup';

import { AccountStore } from '../../../../src/model/account/account-store';

describe('Account store', () => {
    it('turns on raw tunnels, and none of the other upstream feature flags', () => {
        const store = new AccountStore();

        // Read by proxy-store.ts (tunnel non-HTTP connections) and frida-config.tsx (SOCKS)
        expect(store.featureFlags).to.deep.equal(['raw-tunnels']);
        expect(store.user.featureFlags).to.deep.equal(['raw-tunnels']);
    });
});
