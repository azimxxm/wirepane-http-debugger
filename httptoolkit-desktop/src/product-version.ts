// wirepane: Wirepane's own version, from the VERSION file at the repo root. The app's internal
// version (package.json, e.g. 1.27.2) stays HTTP Toolkit's, because the UI checks it to turn
// features on. A packaged app has it in its package.json as wirepaneVersion
// (build-setup/wirepane-builder.config.cjs adds it), a dev run reads the file itself.

import { readFileSync } from 'fs';
import * as path from 'path';
import { app } from 'electron';

import packageJson from '../package.json' with { type: 'json' };

const readVersionFile = (): string | undefined => {
    try {
        return readFileSync(path.join(app.getAppPath(), '..', 'VERSION'), 'utf8').trim() || undefined;
    } catch {
        return undefined; // Not in this repo's layout
    }
};

const packagedVersion = (packageJson as Record<string, unknown>).wirepaneVersion;

export const PRODUCT_VERSION: string = typeof packagedVersion === 'string'
    ? packagedVersion
    : readVersionFile() ?? 'dev';
