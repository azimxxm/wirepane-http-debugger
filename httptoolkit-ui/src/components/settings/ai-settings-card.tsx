import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import { Sparkle } from '@phosphor-icons/react';

import { UiStore } from '../../model/ui/ui-store';

import { MediumCard } from '../common/card';
import { SettingsButton, SettingsExplanation } from './settings-components';

/*
 * Wirepane: points to the AI assistant (MCP) setup from Settings, so every way to set
 * Wirepane up is listed here. The setup itself stays in its dialog, also on the rail.
 */
export const AiSettingsCard = inject('uiStore')(observer((p: {
    uiStore?: UiStore,
    id?: string
}) => <MediumCard id={p.id} aria-labelledby='settings-ai-heading'>
    <header>
        <h1 id='settings-ai-heading'>AI assistants</h1>
    </header>
    <SettingsButton onClick={p.uiStore!.openMcpModal}>
        <Sparkle size={16} aria-hidden={true} /> Connect an AI assistant…
    </SettingsButton>
    <SettingsExplanation>
        AI assistants and agents can read the traffic Wirepane captures, and use its
        operations, through the Model Context Protocol (MCP).
    </SettingsExplanation>
</MediumCard>));
