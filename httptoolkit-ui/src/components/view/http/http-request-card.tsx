import * as React from 'react';
import { observer } from 'mobx-react';

import { HtkRequest, HttpVersion, HttpExchangeView } from '../../../types';

import { getMethodDocs } from '../../../model/http/http-docs';
import { areStepsModifying } from '../../../model/rules/rules';

import {
    CollapsibleCardHeading,
    CollapsibleCard,
    CollapsibleCardProps
} from '../../common/card';
import { PillMethod, RequestPill } from './exchange-pills'; // wirepane: no content-type colour
import { HostnameText } from '../../common/hostname-text'; // wirepane: the real hostname
import {
    CollapsibleSection,
    CollapsibleSectionSummary,
    CollapsibleSectionBody
} from '../../common/collapsible-section';
import {
    ContentLabel,
    ContentLabelBlock,
    ContentMonoValue,
    ContentMonoValueInline,
    CopyableMonoValue, // wirepane: JA4
    Markdown
} from '../../common/text-content';
import { describeJa4, getJa4FromTags } from '../../../model/interception/vpn-ja4'; // wirepane: JA4 from the VPN
import { DocsLink } from '../../common/docs-link';
import { SourceIcon } from '../../common/source-icon';
import { HttpVersionPill } from '../../common/http-version-pill';
import { HeaderDetails, HeaderHeadingContainer } from './header-details';
import { UrlBreakdown } from '../url-breakdown';
import { StepClassKey } from '../../../model/rules/rules';
import { MatchedRulePill } from './matched-rule-pill';

const RawRequestDetails = (p: {
    request: HtkRequest,
    httpVersion: HttpVersion
}) => {
    const methodDocs = getMethodDocs(p.request.method);
    const methodDetails = [
        methodDocs && <Markdown
            key='method-docs'
            content={methodDocs.summary}
        />,
        methodDocs && <p key='method-link'>
            <DocsLink href={methodDocs.url}>Find out more</DocsLink>
        </p>
    ].filter(d => !!d);

    // wirepane: the JA4 fingerprint of the client's TLS hello, when it came through the VPN
    const ja4 = getJa4FromTags(p.request.tags);

    return <div>
        <CollapsibleSection contentName={`${p.request.method} method documentation`}>
            <CollapsibleSectionSummary>
                <ContentLabel>Method:</ContentLabel> { p.request.method }
            </CollapsibleSectionSummary>

            {
                methodDetails.length ?
                    <CollapsibleSectionBody>
                        { methodDetails }
                    </CollapsibleSectionBody>
                : null
            }
        </CollapsibleSection>

        <ContentLabelBlock>URL</ContentLabelBlock>

        <CollapsibleSection
            contentName='URL components'
            prefixTrigger={true}
        >
            <CollapsibleSectionSummary>
                <ContentMonoValueInline>{
                    p.request.parsedUrl.parseable
                        ? p.request.parsedUrl.toString()
                        : p.request.url
                }</ContentMonoValueInline>
            </CollapsibleSectionSummary>

            {
                <CollapsibleSectionBody>
                    <UrlBreakdown url={p.request.parsedUrl} />
                </CollapsibleSectionBody>
            }
        </CollapsibleSection>

        { ja4 && <>
            { /* wirepane: JA4 */ }
            <ContentLabelBlock>TLS fingerprint (JA4)</ContentLabelBlock>
            <ContentMonoValue>
                <CopyableMonoValue title={describeJa4(ja4)}>{ ja4 }</CopyableMonoValue>
            </ContentMonoValue>
        </> }

        <CollapsibleSection
            contentName='Headers'
            collapsePersistKey='httpRequestHeaders'
        >
            <HeaderHeadingContainer>
                <ContentLabelBlock>Headers</ContentLabelBlock>
            </HeaderHeadingContainer>

            <HeaderDetails
                httpVersion={p.httpVersion}
                headers={p.request.rawHeaders}
                requestUrl={p.request.parsedUrl}
            />
        </CollapsibleSection>
    </div>;
}

interface HttpRequestCardProps extends CollapsibleCardProps {
    exchange: HttpExchangeView;
    matchedRuleData: {
        stepTypes: StepClassKey[],
        status: 'unchanged' | 'modified-types' | 'deleted'
    } | undefined;
    onRuleClicked: () => void;
}

export const HttpRequestCard = observer((props: HttpRequestCardProps) => {
    const { exchange, matchedRuleData, onRuleClicked } = props;
    const { request } = exchange;

    return <CollapsibleCard {...props} direction='right'>
        <header>
            { areStepsModifying(matchedRuleData?.stepTypes) &&
                <MatchedRulePill
                    ruleData={matchedRuleData}
                    onClick={onRuleClicked}
                />
            }
            <SourceIcon source={request.source} />
            <HttpVersionPill request={request} />
            <RequestPill>{ /* wirepane: the method in its own colour */ }
                { exchange.isWebSocket() ? 'WebSocket ' : '' }
                <PillMethod httpMethod={request.method}>{ request.method }</PillMethod> <HostnameText>{ request.parsedUrl.hostname || '' }</HostnameText>
            </RequestPill>
            <CollapsibleCardHeading onCollapseToggled={props.onCollapseToggled}>
                Request
            </CollapsibleCardHeading>
        </header>

        <RawRequestDetails
            request={request}
            httpVersion={exchange.httpVersion}
        />
    </CollapsibleCard>;
});