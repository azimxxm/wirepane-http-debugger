import * as _ from 'lodash';
import * as React from 'react';
import { observer, inject } from "mobx-react";

import { WithInjected } from '../../types';
import { styled, Theme, ThemeName } from '../../styles';
import { uploadFile } from '../../util/ui';

import { UiStore } from '../../model/ui/ui-store';
import { serverVersion, versionSatisfies, PORT_RANGE_SERVER_RANGE } from '../../services/service-versions';

import { CollapsibleCard, CollapsibleCardHeading } from '../common/card';
import { PageHeader, PageLayout } from '../common/page-header';
import { TabbedOptionsContainer, Tab, TabsContainer } from '../common/tabbed-options';
import { ContainerSizedEditor } from '../editor/base-editor';

import amIUsingHtml from '../../amiusing.html';

import { ProxySettingsCard } from './proxy-settings-card';
import { ConnectionSettingsCard } from './connection-settings-card';
import { ApiSettingsCard } from './api-settings-card';

interface SettingsPageProps {
    uiStore: UiStore;
}

const SettingsPageScrollContainer = styled.div`
    height: 100%;
    width: 100%;
    overflow-y: auto;
`;

const SettingPageContainer = styled.section`
    margin: 0px auto 20px;
    padding: 40px;
    max-width: 800px;
    position: relative;

    * {
        transition: background-color 0.3s, margin-bottom 0.1s;
    }
`;

const ThemeColors = styled.div`
    display: grid;
    grid-template-columns: 1fr 1fr;
    border: 3px solid #999;
    margin: auto 20px;
`;

const ThemeColorBlock = styled.div<{ themeColor: keyof Theme }>`
    width: 60px;
    height: 60px;
    background-color: ${p => p.theme[p.themeColor]};
`;

const EditorContainer = styled.div`
    border: 3px solid #999;
    height: 300px;
    flex-grow: 1;
    margin: auto 0;
`;

@inject('uiStore')
@observer
class SettingsPage extends React.Component<SettingsPageProps> {

    render() {
        const { uiStore } = this.props;
        const cardProps = uiStore.settingsCardProps;

        return <PageLayout><PageHeader
            title='Settings'
            purpose='Proxy port, certificates, upstream proxy and appearance.'
        /><SettingsPageScrollContainer>
            <SettingPageContainer>
                {
                    _.isString(serverVersion.value) &&
                    versionSatisfies(serverVersion.value, PORT_RANGE_SERVER_RANGE) && <>
                        <ProxySettingsCard {...cardProps.proxy} />
                        <ConnectionSettingsCard {...cardProps.connection} />
                    </>
                }

                <ApiSettingsCard {...cardProps.api} />

                <CollapsibleCard {...cardProps.themes}>
                    <header>
                        <CollapsibleCardHeading onCollapseToggled={
                            cardProps.themes.onCollapseToggled
                        }>
                            Themes
                        </CollapsibleCardHeading>
                    </header>
                    <TabbedOptionsContainer>
                        <TabsContainer
                            onClick={async (value: ThemeName | 'automatic' | 'custom') => {
                                if (value === 'custom') {
                                    const themeFile = await uploadFile('text', ['.htktheme', '.htk-theme', '.json']);
                                    if (!themeFile) return;
                                    try {
                                        const customTheme = uiStore.buildCustomTheme(themeFile);
                                        uiStore.setTheme(customTheme);
                                    } catch (e: any) {
                                        alert(e.message || e);
                                    }
                                } else {
                                    uiStore.setTheme(value);
                                }
                            }}
                            isSelected={(value: ThemeName | 'automatic' | 'custom') =>
                                uiStore.themeName === value
                            }
                        >
                            <Tab
                                icon='MagicWand'
                                value='automatic'
                            >
                                Automatic
                            </Tab>
                            <Tab
                                icon='Sun'
                                value='light'
                            >
                                Light
                            </Tab>
                            <Tab
                                icon='Moon'
                                value='dark'
                            >
                                Dark
                            </Tab>
                            <Tab
                                icon='CircleHalf'
                                value='high-contrast'
                            >
                                High Contrast
                            </Tab>
                            <Tab
                                icon='Swatches'
                                value='custom'
                            >
                                Custom
                            </Tab>
                        </TabsContainer>
                        <ThemeColors>
                            <ThemeColorBlock themeColor='mainColor' />
                            <ThemeColorBlock themeColor='mainBackground' />
                            <ThemeColorBlock themeColor='highlightColor' />
                            <ThemeColorBlock themeColor='highlightBackground' />
                            <ThemeColorBlock themeColor='primaryInputColor' />
                            <ThemeColorBlock themeColor='primaryInputBackground' />
                            <ThemeColorBlock themeColor='containerWatermark' />
                            <ThemeColorBlock themeColor='containerBorder' />
                            <ThemeColorBlock themeColor='mainLowlightBackground' />
                            <ThemeColorBlock themeColor='containerBackground' />
                        </ThemeColors>

                        <EditorContainer>
                            <ContainerSizedEditor
                                contentId={null}
                                language='html'
                                defaultValue={amIUsingHtml}
                            />
                        </EditorContainer>
                    </TabbedOptionsContainer>
                </CollapsibleCard>
            </SettingPageContainer>
        </SettingsPageScrollContainer></PageLayout>;
    }
}

// Annoying cast required to handle the store prop nicely in our types
const InjectedSettingsPage = SettingsPage as unknown as WithInjected<
    typeof SettingsPage,
    'uiStore'
>;
export { InjectedSettingsPage as SettingsPage };