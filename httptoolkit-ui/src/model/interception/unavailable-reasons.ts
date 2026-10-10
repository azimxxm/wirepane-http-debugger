import { isMac } from '../../util/ui';

import { Interceptor } from './interceptors';

export const THIS_MACHINE = isMac ? 'this Mac' : 'this computer';

export interface UnavailableReason {
    // One short line: why it's unavailable, or the next step to fix that
    text: string;
    // A longer explanation, for the tooltip
    detail?: string;
    helpUrl?: string;
}

/**
 * Explains why an intercept option can't be used right now, based on what the
 * server checks before it marks each interceptor as activable.
 */
export function getUnavailableReason(interceptor: Interceptor): UnavailableReason {
    switch (interceptor.id) {
        case 'docker-attach':
            return {
                text: isMac ? 'Start Docker Desktop' : 'Start Docker',
                detail: "Wirepane can't reach the Docker engine. Start Docker, and this option turns on by itself."
            };
        case 'android-adb':
            return {
                text: 'Needs adb (Android platform-tools)',
                detail: 'Install the Android platform-tools, then connect a device or start an emulator.',
                helpUrl: interceptor.notAvailableHelpUrl
            };
        case 'android-frida':
        case 'ios-frida':
            return {
                text: 'Needs a rooted/jailbroken device with frida-server',
                detail: 'Connect a rooted Android or jailbroken iOS device that is running frida-server.'
            };
    }

    // Browsers the server knows how to launch, but couldn't find. (Unsupported browser
    // options, like Arc, fall through to the generic message, since installing won't help.)
    if (interceptor.isSupported && interceptor.tags.includes('browsers')) {
        return {
            text: `Not installed on ${THIS_MACHINE}`,
            detail: `Install ${interceptor.name} to intercept it from here.`
        };
    }

    return { text: `Not available on ${THIS_MACHINE}` };
}
