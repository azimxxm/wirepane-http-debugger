import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { Warning } from '@phosphor-icons/react';

import { styled } from '../../styles';
import { VpnDnsRule, VpnNetworkStore } from '../../model/interception/vpn-network';
import {
    DnsRuleAction,
    checkDnsRuleDraft,
    describeDnsAction,
    findShadowingRule
} from '../../model/interception/vpn-dns-rules';

import { ActionButton } from '../common/action-button';
import { TextInput } from '../common/inputs';
import { VpnProblem } from '../intercept/phone/vpn-problem';

const RULE_LIST_MAX_HEIGHT = 200;

const Root = styled.section`
    flex-shrink: 0;
    box-sizing: border-box;
    padding: 12px 14px;

    display: flex;
    flex-direction: column;
    gap: 10px;

    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 8px;

    font-size: ${p => p.theme.textSize};
    line-height: 1.4;
    color: ${p => p.theme.mainColor};
`;

const Header = styled.div`
    display: flex;
    align-items: baseline;
    gap: 10px;
`;

const Title = styled.h3`
    font-size: ${p => p.theme.headingSize};
    font-weight: 600;
    color: ${p => p.theme.mainColor};
`;

const Count = styled.span`
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const Hint = styled.p`
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const AddRow = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
`;

const PatternInput = styled(TextInput)`
    flex: 1 1 240px;
    min-width: 0;
`;

const AddressInput = styled(TextInput)`
    flex: 0 1 150px;
    min-width: 0;
    font-family: ${p => p.theme.monoFontFamily};
`;

const ActionSelect = styled.select`
    font-family: inherit;
    font-size: ${p => p.theme.textInputFontSize};
    padding: 5px 8px;

    border-radius: 4px;
    border: solid 1px ${p => p.theme.inputBorder};
    background-color: ${p => p.theme.inputBackground};
    color: ${p => p.theme.inputColor};
    cursor: pointer;

    &:hover:not(:disabled) {
        background-color: ${p => p.theme.inputHoverBackground};
    }

    &:disabled {
        opacity: 0.6;
        cursor: default;
    }
`;

const FormHelp = styled.p`
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const FieldProblem = styled.p`
    display: flex;
    align-items: flex-start;
    gap: 6px;

    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainColor};

    > svg {
        flex-shrink: 0;
        margin-top: 2px;
        color: ${p => p.theme.warningColor};
    }
`;

const RuleList = styled.ul`
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: ${RULE_LIST_MAX_HEIGHT}px;
    overflow-y: auto;

    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 6px;
`;

const RuleRow = styled.li`
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 6px 4px 12px;

    & + & {
        border-top: 1px solid ${p => p.theme.containerBorder};
    }
`;

const RuleText = styled.div`
    flex: 1 1 auto;
    min-width: 0;
`;

const RulePattern = styled.span`
    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 500;
    overflow-wrap: anywhere;
`;

const RuleAction = styled.span`
    flex-shrink: 0;
    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const NeverUsed = styled.span`
    display: block;
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const NoRules = styled.p`
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const Problem = (props: { id: string, message: string }) =>
    <FieldProblem id={props.id}>
        <Warning size={14} aria-hidden={true} />
        <span>{ props.message }</span>
    </FieldProblem>;

/**
 * The DNS rules of the VPN: names that are blocked (the phone is told the name doesn't exist)
 * or answered with an address of your choice. The sidecar applies them live to every DNS query
 * of every phone on the VPN, and the first rule that matches wins.
 */
export const DnsRulesEditor = observer((props: { store: VpnNetworkStore }) => {
    const { store } = props;
    const rules = store.settings.dnsRules;

    const [pattern, setPattern] = React.useState('');
    const [action, setAction] = React.useState<DnsRuleAction>('block');
    const [ipv4, setIpv4] = React.useState('');
    // A field's problem shows once the person has left it, or pressed Add with a problem
    const [patternLeft, setPatternLeft] = React.useState(false);
    const [ipv4Left, setIpv4Left] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [saveError, setSaveError] = React.useState<string>();

    const patternInput = React.useRef<HTMLInputElement>(null);
    const ipv4Input = React.useRef<HTMLInputElement>(null);

    // Saving takes a round trip to the server; the person may have left the tab by then
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    // Only when the list changes: it compares every rule with the ones above it, and the form
    // re-renders on every key press
    const shadowedBy = React.useMemo(
        () => rules.map((_rule, index) => findShadowingRule(rules, index)),
        [rules]
    );

    const check = checkDnsRuleDraft({ pattern, action, ipv4 }, rules);
    const patternProblem = patternLeft ? check.patternProblem : undefined;
    const addressProblem = ipv4Left ? check.addressProblem : undefined;

    const save = async (nextRules: VpnDnsRule[]): Promise<boolean> => {
        setBusy(true);
        setSaveError(undefined);
        try {
            await store.configure({ dnsRules: nextRules });
            return true;
        } catch (error) {
            if (mounted.current) setSaveError(`The DNS rules were not saved: ${errorMessage(error)}`);
            return false;
        } finally {
            if (mounted.current) setBusy(false);
        }
    };

    const addRule = async () => {
        if (busy) return;

        if (!check.rule) {
            setPatternLeft(true);
            setIpv4Left(true);
            (check.patternProblem ? patternInput : ipv4Input).current?.focus();
            return;
        }

        const saved = await save([...rules, check.rule]);
        if (!saved || !mounted.current) return;

        setPattern('');
        setIpv4('');
        setPatternLeft(false);
        setIpv4Left(false);
        patternInput.current?.focus();
    };

    const removeRule = (index: number) => save(rules.filter((_rule, i) => i !== index));

    const submitOnEnter = (event: React.KeyboardEvent) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        addRule();
    };

    return <Root aria-labelledby='dns-rules-heading'>
        <Header>
            <Title id='dns-rules-heading'>DNS rules</Title>
            { rules.length > 0 && <Count>{ rules.length } { rules.length === 1 ? 'rule' : 'rules' }</Count> }
        </Header>
        <Hint>
            These rules apply to every app on phones connected through the VPN. The first rule that matches wins.
        </Hint>

        <AddRow role='group' aria-label='Add a DNS rule'>
            <PatternInput
                ref={patternInput}
                value={pattern}
                placeholder='api.example.com or *.example.com'
                aria-label='Name to match'
                aria-invalid={!!patternProblem}
                aria-describedby={patternProblem ? 'dns-rule-pattern-problem' : undefined}
                invalid={!!patternProblem}
                readOnly={busy}
                spellCheck={false}
                autoComplete='off'
                autoCapitalize='off'
                onChange={(event) => setPattern(event.target.value)}
                onBlur={() => { if (pattern.trim()) setPatternLeft(true); }}
                onKeyDown={submitOnEnter}
            />
            <ActionSelect
                aria-label='What to do with it'
                value={action}
                disabled={busy}
                onChange={(event) => setAction(event.target.value as DnsRuleAction)}
            >
                <option value='block'>Block (name not found)</option>
                <option value='answer'>Answer with an address</option>
            </ActionSelect>
            { action === 'answer' && <AddressInput
                ref={ipv4Input}
                value={ipv4}
                placeholder='192.168.0.10'
                aria-label='IPv4 address to answer with'
                aria-invalid={!!addressProblem}
                aria-describedby={addressProblem ? 'dns-rule-address-problem' : undefined}
                invalid={!!addressProblem}
                readOnly={busy}
                spellCheck={false}
                autoComplete='off'
                onChange={(event) => setIpv4(event.target.value)}
                onBlur={() => { if (ipv4.trim()) setIpv4Left(true); }}
                onKeyDown={submitOnEnter}
            /> }
            <ActionButton variant='primary' icon='Plus' disabled={busy} onClick={addRule}>
                Add rule
            </ActionButton>
        </AddRow>
        { patternProblem && <Problem id='dns-rule-pattern-problem' message={patternProblem} /> }
        { addressProblem && <Problem id='dns-rule-address-problem' message={addressProblem} /> }
        <FormHelp>*.example.com matches every subdomain, but not example.com itself.</FormHelp>

        { saveError && <VpnProblem message={saveError} /> }

        { rules.length === 0
            ? <NoRules>No rules yet. Add a name to block it, or to send it to another address.</NoRules>
            : <RuleList aria-label='DNS rules'>
                { rules.map((rule, index) => {
                    const hiddenBy = shadowedBy[index];

                    return <RuleRow key={`${index}:${rule.pattern}`}>
                        <RuleText>
                            <RulePattern>{ rule.pattern }</RulePattern>
                            { hiddenBy && <NeverUsed>
                                Never used: the rule for { hiddenBy.pattern } above it already matches this name.
                            </NeverUsed> }
                        </RuleText>
                        <RuleAction>{ describeDnsAction(rule) }</RuleAction>
                        <ActionButton
                            variant='ghost'
                            icon='Trash'
                            disabled={busy}
                            aria-label={`Remove the rule for ${rule.pattern}`}
                            onClick={() => { removeRule(index); }}
                        >
                            Remove
                        </ActionButton>
                    </RuleRow>;
                }) }
            </RuleList>
        }
    </Root>;
});
