import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import { Gauge, Info } from '@phosphor-icons/react';

import { styled } from '../../styles';

import { ProxyStore } from '../../model/proxy-store';
import { getVpnModeStore } from '../../model/interception/vpn-mode';
import { VpnConditions, VpnNetworkStore } from '../../model/interception/vpn-network';

import { ActionButton } from '../common/action-button';
import { Select, TextInput, UnstyledButton } from '../common/inputs';
import {
    CONDITIONS_FIELDS,
    CONDITIONS_PRESETS,
    ConditionsDevice,
    ConditionsFieldErrors,
    ConditionsFormFields,
    ConditionsPreset,
    describeConditions,
    describePreset,
    findPreset,
    isOff,
    nameConditions,
    parseConditionsFields,
    pickDefaultDevice,
    toFormFields
} from './conditions-model';

// The Network page already pads its tabs, so the panel adds no margin of its own
const Panel = styled.div`
    display: flex;
    flex-direction: column;
    gap: 16px;

    font-size: ${p => p.theme.textSize};
    line-height: 1.5;
    color: ${p => p.theme.mainColor};
`;

const Section = styled.section`
    box-sizing: border-box;
    padding: 16px 20px;
    min-width: 0;

    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 8px;

    display: flex;
    flex-direction: column;
    gap: 12px;
`;

const SectionHeading = styled.h2`
    font-size: ${p => p.theme.subHeadingSize};
    font-weight: 600;
    line-height: 1.3;
    color: ${p => p.theme.mainColor};
`;

const Explanation = styled.p`
    display: flex;
    align-items: flex-start;
    gap: 8px;
    color: ${p => p.theme.mainLowlightColor};

    > svg {
        flex-shrink: 0;
        margin-top: 3px;
    }
`;

const DeviceRow = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;

    > label {
        font-weight: 600;
    }
`;

const DeviceSelect = styled(Select)`
    width: auto;
    min-width: 200px;
    max-width: 100%;
    padding: 4px 8px;
    font-size: ${p => p.theme.textInputFontSize};
`;

const Status = styled.div<{ isActive: boolean }>`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 10px 12px;

    border: 1px solid ${p => p.isActive ? p.theme.popColor : p.theme.containerBorder};
    border-radius: 6px;
    background-color: ${p => p.isActive ? p.theme.rowHover : p.theme.mainLowlightBackground};

    > svg {
        flex-shrink: 0;
        color: ${p => p.isActive ? p.theme.popColor : p.theme.mainLowlightColor};
    }

    > span {
        flex: 1 1 240px;
        min-width: 0;
        overflow-wrap: anywhere;
    }
`;

const PresetGrid = styled.div`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 8px;
`;

const PresetButton = styled(UnstyledButton)<{ isChosen: boolean }>`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 10px 12px;
    text-align: left;

    border: 1px solid ${p => p.isChosen ? p.theme.popColor : p.theme.containerBorder};
    border-radius: 6px;
    background-color: ${p => p.isChosen ? p.theme.rowHover : p.theme.mainBackground};
    color: ${p => p.theme.mainColor};

    > strong {
        font-weight: 600;
    }

    > span {
        font-size: ${p => p.theme.textInputFontSize};
        color: ${p => p.theme.mainLowlightColor};
    }

    &:not([disabled]):hover {
        background-color: ${p => p.theme.rowHover};
    }

    &[disabled] {
        opacity: 0.6;
    }
`;

const FieldGrid = styled.div`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: 12px;
`;

const FieldBox = styled.div`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;

    > label {
        font-weight: 600;
    }

    > small {
        font-size: ${p => p.theme.smallPrintSize};
        color: ${p => p.theme.mainLowlightColor};
    }

    > small[role="alert"] {
        color: ${p => p.theme.warningColor};
    }
`;

const InputWithUnit = styled.div`
    display: flex;
    align-items: center;
    gap: 6px;

    > input {
        flex: 1 1 auto;
        min-width: 0;
        width: 100%;
    }

    > span {
        flex-shrink: 0;
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const FormActions = styled.div`
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
`;

const ErrorText = styled.p`
    color: ${p => p.theme.warningColor};
`;

const EmptyText = styled.p`
    color: ${p => p.theme.mainLowlightColor};
`;

const describeError = (error: unknown) =>
    error instanceof Error && error.message
        ? error.message
        : 'Something went wrong. Try again.';

const fieldId = (field: string) => `conditions-field-${field}`;

// "iPad (10.73.0.3), Edge": the name, its tunnel address, and the conditions that are on
const deviceLabel = (device: ConditionsDevice, conditions: VpnConditions | null | undefined) =>
    `${device.name}${device.tunnelIp ? ` (${device.tunnelIp})` : ''}${
        isOff(conditions) ? '' : `, ${nameConditions(conditions)}`
    }`;

/**
 * Network conditions for one VPN device: pick the device, pick a preset (or type your own
 * numbers) and the sidecar slows that phone's traffic. Everything it shows comes from the
 * network store's `settings`, so it is the same after a reload.
 */
export const ConditionsPanel = observer((props: {
    store: VpnNetworkStore,
    devices: ReadonlyArray<ConditionsDevice>
}) => {
    const { store, devices } = props;
    const conditionsByPeer = store.settings?.conditions ?? {};

    // The device the user picked. Until they pick one, the best guess; it is kept once chosen,
    // so turning conditions off doesn't make the picker jump to another device.
    const [pickedPeer, setPickedPeer] = React.useState<string | undefined>();
    const device = devices.find((candidate) => candidate.peer === pickedPeer)
        ?? pickDefaultDevice(devices, conditionsByPeer);
    React.useEffect(() => {
        if (device && device.peer !== pickedPeer) setPickedPeer(device.peer);
    }, [device?.peer, pickedPeer]);

    const active: VpnConditions | null = device ? conditionsByPeer[device.peer] ?? null : null;
    const activeKey = JSON.stringify(active);

    const [fields, setFields] = React.useState<ConditionsFormFields>(() => toFormFields(active));
    const [fieldErrors, setFieldErrors] = React.useState<ConditionsFieldErrors>({});
    // True once the user typed in a field, so a refresh of the settings doesn't overwrite it
    const [edited, setEdited] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | undefined>();

    const mounted = React.useRef(true);
    React.useEffect(() => () => { mounted.current = false; }, []);

    // Show the device's current conditions in the fields, until the user starts typing
    React.useEffect(() => {
        if (!edited) setFields(toFormFields(active));
    }, [device?.peer, activeKey, edited]);

    const choosePeer = (peer: string) => {
        setPickedPeer(peer);
        setEdited(false);
        setFieldErrors({});
        setError(undefined);
    };

    const apply = async (conditions: VpnConditions | null) => {
        if (!device || busy) return;

        setBusy(true);
        setError(undefined);
        try {
            await store.configure({ conditions: { [device.peer]: conditions } });
            if (!mounted.current) return;
            setEdited(false);
            setFieldErrors({});
            setFields(toFormFields(conditions));
        } catch (e) {
            if (mounted.current) setError(describeError(e));
        } finally {
            if (mounted.current) setBusy(false);
        }
    };

    const applyPreset = (preset: ConditionsPreset) => apply(preset.conditions);

    const applyCustom = (event: React.SyntheticEvent) => {
        event.preventDefault();

        const parsed = parseConditionsFields(fields);
        if (!parsed.ok) {
            setFieldErrors(parsed.errors);
            setError(undefined);
            return;
        }
        setFieldErrors({});
        // All zeros do nothing, so it is the same as turning conditions off
        return apply(isOff(parsed.conditions) ? null : parsed.conditions);
    };

    const editField = (field: keyof ConditionsFormFields, value: string) => {
        setEdited(true);
        setFields((current) => ({ ...current, [field]: value }));
        setFieldErrors((current) => ({ ...current, [field]: undefined }));
    };

    if (!device) {
        return <Panel>
            <Section aria-labelledby='conditions-heading'>
                <SectionHeading id='conditions-heading'>Network conditions</SectionHeading>
                <EmptyText>
                    No phone is on Wirepane's VPN yet. Set one up on the iPhone page (Intercept ›
                    iPhone or iPad › Capture all apps (VPN)), start the VPN, and it shows up here.
                </EmptyText>
            </Section>
        </Panel>;
    }

    const activePreset = findPreset(active);
    const isActive = !isOff(active);

    return <Panel>
        <Section aria-labelledby='conditions-heading'>
            <SectionHeading id='conditions-heading'>Network conditions</SectionHeading>
            <Explanation>
                <Info size={16} aria-hidden />
                <span>
                    This slows every app on that phone, not only the traffic you see in View, until you turn it off.
                </span>
            </Explanation>

            <DeviceRow>
                <label htmlFor='conditions-device'>Device</label>
                <DeviceSelect
                    id='conditions-device'
                    value={device.peer}
                    disabled={busy}
                    onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
                        choosePeer(event.target.value)
                    }
                >
                    { devices.map((candidate) =>
                        <option key={candidate.peer} value={candidate.peer}>
                            { deviceLabel(candidate, conditionsByPeer[candidate.peer]) }
                        </option>
                    ) }
                </DeviceSelect>
            </DeviceRow>

            <Status isActive={isActive} role='status'>
                <Gauge size={20} aria-hidden />
                <span>
                    { isActive
                        ? <><strong>{ nameConditions(active) } on { device.name }:</strong> { describeConditions(active) }</>
                        : <><strong>Off.</strong> { device.name } uses its normal network.</>
                    }
                </span>
                { isActive && <ActionButton
                    variant='secondary'
                    disabled={busy}
                    onClick={() => apply(null)}
                >
                    Turn off
                </ActionButton> }
            </Status>

            { error && <ErrorText role='alert'>{ error }</ErrorText> }
        </Section>

        <Section aria-labelledby='conditions-presets-heading'>
            <SectionHeading id='conditions-presets-heading'>Presets</SectionHeading>
            <PresetGrid>
                { CONDITIONS_PRESETS.map((preset) =>
                    <PresetButton
                        key={preset.id}
                        isChosen={activePreset?.id === preset.id}
                        aria-pressed={activePreset?.id === preset.id}
                        disabled={busy}
                        onClick={() => applyPreset(preset)}
                    >
                        <strong>{ preset.label }</strong>
                        <span>{ describePreset(preset) }</span>
                    </PresetButton>
                ) }
            </PresetGrid>
        </Section>

        <Section aria-labelledby='conditions-custom-heading'>
            <SectionHeading id='conditions-custom-heading'>Custom</SectionHeading>
            <form onSubmit={applyCustom} noValidate>
                <FieldGrid>
                    { CONDITIONS_FIELDS.map((spec) => {
                        const fieldError = fieldErrors[spec.field];
                        const id = fieldId(spec.field);

                        return <FieldBox key={spec.field}>
                            <label htmlFor={id}>{ spec.label }</label>
                            <InputWithUnit>
                                <TextInput
                                    id={id}
                                    inputMode={spec.wholeNumber ? 'numeric' : 'decimal'}
                                    autoComplete='off'
                                    value={fields[spec.field]}
                                    invalid={!!fieldError}
                                    aria-invalid={!!fieldError}
                                    aria-describedby={`${id}-note`}
                                    disabled={busy}
                                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                                        editField(spec.field, event.target.value)
                                    }
                                    onKeyDown={(event: React.KeyboardEvent) => {
                                        // A form without a submit button doesn't submit on Enter by itself
                                        if (event.key === 'Enter') applyCustom(event);
                                    }}
                                />
                                <span>{ spec.unit }</span>
                            </InputWithUnit>
                            { fieldError
                                ? <small id={`${id}-note`} role='alert'>{ fieldError }</small>
                                : <small id={`${id}-note`}>{ spec.hint }</small>
                            }
                        </FieldBox>;
                    }) }
                </FieldGrid>
                <FormActions>
                    <ActionButton
                        variant='primary'
                        disabled={busy}
                        onClick={applyCustom}
                    >
                        Apply to { device.name }
                    </ActionButton>
                </FormActions>
            </form>
        </Section>
    </Panel>;
});

/**
 * The Network page's Conditions tab. The devices are the VPN's own list (the one the iPhone
 * page shows), read while this tab is open, unless the page passes `devices` itself.
 */
export const ConditionsTab = inject('proxyStore')(observer((props: {
    store: VpnNetworkStore,
    devices?: ReadonlyArray<ConditionsDevice>,
    proxyStore?: ProxyStore
}) => {
    const { proxyStore, devices: givenDevices } = props;

    const vpnStore = getVpnModeStore(() => proxyStore!.httpProxyPort);
    React.useEffect(() => givenDevices ? undefined : vpnStore.startPolling(), [vpnStore, givenDevices]);

    return <ConditionsPanel store={props.store} devices={givenDevices ?? vpnStore.peers} />;
}));
