import { appHistory } from '../../../routing';
import type { CustomActivationFunction } from '../intercept-option';

export const IPHONE_SETUP_PATH = '/intercept/iphone';
export const ANDROID_SETUP_PATH = '/intercept/android';

// Clicking a phone card on the Intercept page opens its setup page instead of activating anything
const openPage = (path: string): CustomActivationFunction => async () => {
    await appHistory.navigate(path);
};

export const openIPhoneSetup = openPage(IPHONE_SETUP_PATH);
export const openAndroidSetup = openPage(ANDROID_SETUP_PATH);
