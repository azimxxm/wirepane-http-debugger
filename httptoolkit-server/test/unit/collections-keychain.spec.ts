import { expect } from 'chai';
import {
    storeInKeychain,
    readFromKeychain,
    deleteFromKeychain,
    isKeychainSupported,
    StoredSecret
} from '../../src/collections/keychain-store';

describe("Collections Keychain Store", function () {
    this.timeout(5000);

    const testService = `tech.httptoolkit.test.collections.${Date.now()}`;
    const testCollectionId = 'test_col_123';

    afterEach(async () => {
        if (isKeychainSupported()) {
            await deleteFromKeychain(testCollectionId, testService);
        }
    });

    it("reports whether Keychain is supported on the current platform", () => {
        expect(isKeychainSupported()).to.equal(process.platform === 'darwin');
    });

    if (process.platform === 'darwin') {
        it("stores and reads back secrets from Keychain", async () => {
            const secrets: StoredSecret[] = [
                { environment: 'Production', variable: 'apiKey', value: 'secret-key-xyz' },
                { environment: 'Staging', variable: 'dbPass', value: 'staging-pass-123' }
            ];

            const stored = await storeInKeychain(testCollectionId, secrets, testService);
            expect(stored).to.equal(true);

            const readBack = await readFromKeychain(testCollectionId, testService);
            expect(readBack).to.deep.equal(secrets);
        });

        it("updates existing secrets when saved again", async () => {
            const initial: StoredSecret[] = [
                { environment: 'Production', variable: 'token', value: 'v1' }
            ];
            await storeInKeychain(testCollectionId, initial, testService);

            const updated: StoredSecret[] = [
                { environment: 'Production', variable: 'token', value: 'v2' }
            ];
            await storeInKeychain(testCollectionId, updated, testService);

            const readBack = await readFromKeychain(testCollectionId, testService);
            expect(readBack).to.deep.equal(updated);
        });

        it("returns undefined for non-existent secrets", async () => {
            const readBack = await readFromKeychain('non_existent_id', testService);
            expect(readBack).to.equal(undefined);
        });

        it("deletes secrets cleanly from Keychain", async () => {
            const secrets: StoredSecret[] = [
                { environment: 'Production', variable: 'token', value: 'v1' }
            ];
            await storeInKeychain(testCollectionId, secrets, testService);

            const deleted = await deleteFromKeychain(testCollectionId, testService);
            expect(deleted).to.equal(true);

            const readBack = await readFromKeychain(testCollectionId, testService);
            expect(readBack).to.equal(undefined);

            // Deleting again should also succeed without error
            const deletedAgain = await deleteFromKeychain(testCollectionId, testService);
            expect(deletedAgain).to.equal(true);
        });
    }
});
