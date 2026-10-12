import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import {
    type Icon as PhosphorIconComponent,
    CircleHalf,
    Desktop,
    Moon,
    Sun,
    Swatches
} from '@phosphor-icons/react';

import { styled, Theme, ThemeName } from '../../styles';
import { uploadFile } from '../../util/ui';

import { UiStore } from '../../model/ui/ui-store';

import { CollapsibleCard, CollapsibleCardHeading, CollapsibleCardProps } from '../common/card';
import { ContainerSizedEditor } from '../editor/base-editor';
import { SettingsButton, SettingsExplanation, SettingsSubheading } from './settings-components';

import amIUsingHtml from '../../amiusing.html';

/*
 * Wirepane: Settings' Appearance card, formerly "Themes". The same themes, as one radio
 * group, with custom themes loaded from a file and their problems shown inline.
 */

type ThemeChoice = ThemeName | 'automatic';

const THEME_OPTIONS: Array<{ value: ThemeChoice, label: string, icon: PhosphorIconComponent }> = [
    { value: 'automatic', label: 'System', icon: Desktop },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'high-contrast', label: 'High contrast', icon: CircleHalf }
];

const ThemeOptions = styled.div`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 8px;
    margin: 10px 0 6px;
`;

const ThemeOption = styled.label`
    position: relative;
    cursor: pointer;

    > input {
        position: absolute;
        opacity: 0;
        width: 1px;
        height: 1px;
        margin: 0;
    }

    > span {
        height: 64px;
        box-sizing: border-box;
        border-radius: 8px;
        border: 1px solid ${p => p.theme.inputBorder};
        background-color: ${p => p.theme.mainBackground};

        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;

        font-size: ${p => p.theme.textInputFontSize};
        font-weight: 500;
        color: ${p => p.theme.mainColor};

        transition: background-color 0.12s, border-color 0.12s;
    }

    &:hover > span {
        background-color: ${p => p.theme.rowHover};
    }

    > input:checked + span {
        border-color: ${p => p.theme.popColor};
        box-shadow: inset 0 0 0 1px ${p => p.theme.popColor};
        color: ${p => p.theme.popColor};
        font-weight: 600;
    }

    > input:focus-visible + span {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: 2px;
    }
`;

const CustomThemeRow = styled.div`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    margin-top: 10px;
`;

const ThemeError = styled.p`
    margin-top: 8px;
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.error};
`;

const PreviewRow = styled.div`
    display: flex;
    gap: 16px;
    align-items: stretch;
    margin-top: 10px;
`;

const Swatches_ = styled.div`
    flex-shrink: 0;
    display: grid;
    grid-template-columns: repeat(2, 24px);
    grid-auto-rows: 24px;
    gap: 4px;
    align-content: start;
`;

const Swatch = styled.div<{ themeColor: keyof Theme }>`
    border-radius: 4px;
    box-shadow: inset 0 0 0 1px ${p => p.theme.containerBorder};
    background-color: ${p => p.theme[p.themeColor] as string};
`;

const EditorPreview = styled.div`
    flex-grow: 1;
    min-width: 0;
    height: 180px;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 0 0 1px ${p => p.theme.containerBorder};
`;

const SWATCH_KEYS: Array<keyof Theme> = [
    'mainColor',
    'mainBackground',
    'highlightColor',
    'highlightBackground',
    'primaryInputColor',
    'primaryInputBackground',
    'containerWatermark',
    'containerBorder',
    'mainLowlightBackground',
    'containerBackground'
];

export const AppearanceSettingsCard = inject('uiStore')(observer((p: CollapsibleCardProps & {
    uiStore?: UiStore
}) => {
    const { uiStore, ...cardProps } = p;
    const store = uiStore!;
    const [customThemeError, setCustomThemeError] = React.useState<string | undefined>();

    const loadCustomTheme = async () => {
        const themeFile = await uploadFile('text', ['.htktheme', '.htk-theme', '.json']);
        if (!themeFile) return;

        try {
            store.setTheme(store.buildCustomTheme(themeFile));
            setCustomThemeError(undefined);
        } catch (e: any) {
            setCustomThemeError(`That theme couldn't be loaded: ${e?.message ?? e}`);
        }
    };

    // Custom themes are built from a file with a name in it (UiStore.buildCustomTheme)
    const customThemeName = store.themeName === 'custom'
        ? (store.theme as unknown as { name?: string }).name
        : undefined;

    return <CollapsibleCard {...cardProps}>
        <header>
            <CollapsibleCardHeading onCollapseToggled={cardProps.onCollapseToggled}>
                Appearance
            </CollapsibleCardHeading>
        </header>

        <SettingsSubheading id='settings-theme-label'>Theme</SettingsSubheading>
        <ThemeOptions role='radiogroup' aria-labelledby='settings-theme-label'>
            { THEME_OPTIONS.map(({ value, label, icon: OptionIcon }) =>
                <ThemeOption key={value}>
                    <input
                        type='radio'
                        name='wirepane-theme'
                        value={value}
                        checked={store.themeName === value}
                        onChange={() => {
                            store.setTheme(value);
                            setCustomThemeError(undefined);
                        }}
                    />
                    <span>
                        <OptionIcon size={22} aria-hidden={true} />
                        { label }
                    </span>
                </ThemeOption>
            ) }
        </ThemeOptions>
        <SettingsExplanation>
            System follows your computer's light or dark mode.
        </SettingsExplanation>

        <CustomThemeRow>
            <SettingsButton onClick={loadCustomTheme}>
                <Swatches size={16} aria-hidden={true} /> Load a custom theme…
            </SettingsButton>
            { store.themeName === 'custom' && <span>
                Using { customThemeName ? `“${customThemeName}”` : 'a custom theme' }
            </span> }
        </CustomThemeRow>
        { customThemeError && <ThemeError role='alert'>{ customThemeError }</ThemeError> }

        <SettingsSubheading>Preview</SettingsSubheading>
        <PreviewRow>
            <Swatches_ aria-hidden={true}>
                { SWATCH_KEYS.map((key) => <Swatch key={key} themeColor={key} title={key} />) }
            </Swatches_>
            <EditorPreview>
                <ContainerSizedEditor
                    contentId={null}
                    language='html'
                    defaultValue={amIUsingHtml}
                />
            </EditorPreview>
        </PreviewRow>
    </CollapsibleCard>;
}));
