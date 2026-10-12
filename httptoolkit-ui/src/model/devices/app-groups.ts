import * as _ from 'lodash';

import type { IconProps } from '../../icons';

import { AppIdentity, AppKind, getAppKeys } from './app-identity';

// One app in the Devices panel, with every request that's known to come from it
export interface AppCount {
    name: string;
    kind: AppKind;
    count: number;
    // The Source column's icon for its first request
    icon: IconProps;
    // The keys of the requests counted under it (see getAppKeys), to match requests to it
    keys: readonly string[];
    // For its tooltip: its bundle ID & the SDKs whose requests named it, or what it is
    detail: string | undefined;
}

// What one key has counted, for one device
interface AppTally {
    key: string;
    // As the requests wrote it: "Jett Invest App", "uz.kashapp.road24", "Facebook SDK"
    label: string;
    kind: AppKind;
    isBundleId: boolean;
    count: number; // Requests counted under it (their first key)
    mentions: number; // Requests that named it at all
    icon: IconProps;
    // The SDKs & web views whose requests named this app, e.g. "Facebook SDK"
    via: Map<string, number>;
}

function increment(counts: Map<string, number>, key: string) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

function decrement(counts: Map<string, number>, key: string) {
    const count = (counts.get(key) ?? 0) - 1;
    if (count > 0) counts.set(key, count);
    else counts.delete(key);
}

const viaLabel = (identity: AppIdentity) =>
    identity.client && (identity.name || identity.bundleId) ? identity.client.label : undefined;

// Lowercase letters & digits only, to compare "road24" with the end of "uz.kashapp.road24"
const simplify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const CLIENT_DETAILS: { [kind in AppKind]?: string } = {
    library: "Sent from inside an app that its requests don't name",
    system: "The operating system's own services",
    unknown: 'Requests without a User-Agent header'
};

/**
 * Counts one device's requests by app. Requests name their app in different ways (its name,
 * its bundle ID, only an SDK's name), so each key is counted on its own, and the keys that
 * one request named together are remembered. grouped() then merges them into apps.
 */
export class AppTallies {

    private readonly tallies = new Map<string, AppTally>();
    private readonly links = new Map<string, number>();

    // Counts a request, and returns the key it's counted under
    add(identity: AppIdentity, icon: IconProps): string {
        const keys = getAppKeys(identity);

        keys.forEach((key, index) => {
            let tally = this.tallies.get(key);
            if (!tally) {
                const isBundleId = key.startsWith('bundle:');
                tally = {
                    key,
                    label: key.startsWith('name:')
                        ? identity.name!
                        : isBundleId
                            ? identity.bundleId!
                            : identity.client?.label ?? '',
                    kind: key.startsWith('name:') || isBundleId ? 'app' : identity.client?.kind ?? 'unknown',
                    isBundleId,
                    count: 0,
                    mentions: 0,
                    icon,
                    via: new Map()
                };
                this.tallies.set(key, tally);
            }

            tally.mentions += 1;
            if (index === 0) {
                tally.count += 1;
                const via = viaLabel(identity);
                if (via) increment(tally.via, via);
            }
        });

        if (keys.length > 1) increment(this.links, keys.join('\n'));
        return keys[0];
    }

    // Takes back exactly what add() counted for the same identity
    remove(identity: AppIdentity) {
        const keys = getAppKeys(identity);

        keys.forEach((key, index) => {
            const tally = this.tallies.get(key);
            if (!tally) return;

            tally.mentions -= 1;
            if (index === 0) {
                tally.count -= 1;
                const via = viaLabel(identity);
                if (via) decrement(tally.via, via);
            }
            if (tally.mentions <= 0) this.tallies.delete(key);
        });

        if (keys.length > 1) decrement(this.links, keys.join('\n'));
    }

    // The keys of each app: the ones named together, plus names that end its bundle ID
    private groupKeys(): string[][] {
        const parents = new Map<string, string>();
        const find = (key: string): string => {
            const parent = parents.get(key)!;
            if (parent === key) return key;
            const root = find(parent);
            parents.set(key, root);
            return root;
        };
        const join = (a: string, b: string) => {
            if (!parents.has(a) || !parents.has(b)) return;
            const rootA = find(a);
            const rootB = find(b);
            if (rootA !== rootB) parents.set(rootA, rootB);
        };

        this.tallies.forEach((_tally, key) => parents.set(key, key));
        this.links.forEach((_count, link) => {
            const [a, b] = link.split('\n');
            join(a, b);
        });

        // "road24/3601380 CFNetwork/…" and "uz.kashapp.road24/3.6.0 GMS-SDK/…" are one app,
        // even before a request names both
        const tallies = [...this.tallies.values()];
        const names = tallies.filter((tally) => tally.kind === 'app' && !tally.isBundleId);
        tallies.filter((tally) => tally.isBundleId).forEach((bundle) => {
            const lastPart = simplify(_.last(bundle.label.split('.'))!);
            names
                .filter((name) => simplify(name.label) === lastPart)
                .forEach((name) => join(name.key, bundle.key));
        });

        return Object.values(_.groupBy([...this.tallies.keys()], find));
    }

    /**
     * The apps, most requests first. An app is named by its own name if a request said it,
     * otherwise by its bundle ID. SDKs & OS services that no request tied to an app get an
     * entry of their own, named for what they are.
     */
    grouped(systemLabel: string): AppCount[] {
        const byUse = (tallies: AppTally[]) =>
            _.orderBy(tallies, [(tally) => tally.mentions, (tally) => tally.label.toLowerCase()], ['desc', 'asc']);

        const apps = this.groupKeys().map((keys): AppCount | undefined => {
            const members = keys.map((key) => this.tallies.get(key)!);
            const count = _.sumBy(members, (tally) => tally.count);
            if (count === 0) return undefined;

            const names = byUse(members.filter((tally) => tally.kind === 'app' && !tally.isBundleId));
            const bundleIds = byUse(members.filter((tally) => tally.isBundleId));
            const [main] = [...names, ...bundleIds, ...members];
            const busiest = _.maxBy(members, (tally) => tally.count)!;

            if (main.kind !== 'app') {
                return {
                    name: main.kind === 'system' ? systemLabel : main.label,
                    kind: main.kind,
                    count,
                    icon: main.icon,
                    keys,
                    detail: CLIENT_DETAILS[main.kind]
                };
            }

            const via = _.uniq(_.flatMap(members, (tally) => [...tally.via.keys()]));
            const detail = [
                bundleIds.map((tally) => tally.label).filter((label) => label !== main.label).join(', '),
                via.length ? `includes ${via.join(', ')}` : ''
            ].filter(Boolean).join(' · ');

            return {
                name: main.label,
                kind: 'app',
                count,
                icon: main.count > 0 ? main.icon : busiest.icon,
                keys,
                detail: detail || undefined
            };
        }).filter((app): app is AppCount => !!app);

        // The real apps first: SDKs, web views and OS services are listed below them, so a busy
        // one doesn't push the apps out of the panel's short list
        return _.orderBy(
            apps,
            [(app) => app.kind === 'app' ? 0 : 1, (app) => app.count, (app) => app.name.toLowerCase()],
            ['asc', 'desc', 'asc']
        );
    }
}
