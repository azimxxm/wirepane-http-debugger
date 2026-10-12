import { expect } from '../../../test-setup';

import { matchCommand, searchCommands } from '../../../../src/model/ui/command-search';

const SECTIONS = ['Go', 'Capture', 'Help'];

const commands = [
    { label: 'Go to Intercept', section: 'Go', keywords: ['connect', 'sources'] },
    { label: 'Go to View', section: 'Go', keywords: ['traffic', 'requests'] },
    { label: 'Go to Send', section: 'Go' },
    { label: 'Open Settings', section: 'Go', keywords: ['preferences'] },
    { label: 'Pause recording', section: 'Capture', description: "Traffic keeps flowing" },
    { label: 'Copy proxy address', section: 'Capture', description: 'http://localhost:8000' },
    { label: 'Import HAR…', section: 'Capture' },
    { label: 'Export HAR…', section: 'Capture' },
    { label: 'Connect an iPhone or iPad', section: 'Help', keywords: ['ios'] },
    { label: 'Report an issue', section: 'Help', keywords: ['feedback', 'bug'] },
    { label: 'Open documentation', section: 'Help', description: "HTTP Toolkit's guides, which also cover Wirepane" }
];

const labelsFor = (query: string) => searchCommands(commands, query, SECTIONS)
    .reduce<string[]>((all, group) => all.concat(group.matches.map((match) => match.command.label)), []);

describe('Command search', () => {

    it('shows everything, in sections and in order, with no query', () => {
        const groups = searchCommands(commands, '   ', SECTIONS);

        expect(groups.map((group) => group.section)).to.deep.equal(['Go', 'Capture', 'Help']);
        expect(labelsFor('')).to.deep.equal(commands.map((command) => command.label));
    });

    it('matches whole words, ignoring case', () => {
        expect(labelsFor('PROXY')).to.deep.equal(['Copy proxy address']);
        expect(labelsFor('har')).to.deep.equal(['Import HAR…', 'Export HAR…']);
    });

    it('puts the best match first', () => {
        // "Export HAR" starts with it; nothing else has it at the start of a word
        expect(labelsFor('ex')[0]).to.equal('Export HAR…');
        expect(labelsFor('view')[0]).to.equal('Go to View');
    });

    it('matches letters from the start of words', () => {
        expect(labelsFor('gtv')).to.deep.equal(['Go to View']);
        expect(labelsFor('prxy')).to.deep.equal(['Copy proxy address']);
        // Camel humps count as word starts:
        expect(labelsFor('phone')).to.deep.equal(['Connect an iPhone or iPad']);
    });

    it("doesn't match letters scattered from the middle of words", () => {
        expect(labelsFor('xpr')).to.deep.equal([]);
        expect(labelsFor('zzz')).to.deep.equal([]);
    });

    it("doesn't match letters picked from unrelated words", () => {
        // "HTTP Toolkit's guides, which also cover Wirepane" has an H, then an a, then an r:
        expect(labelsFor('har')).to.not.include('Open documentation');
        // ...but the letters may start new words, like an acronym:
        expect(labelsFor('cpa')[0]).to.equal('Copy proxy address');
    });

    it('needs every word to match', () => {
        expect(labelsFor('go send')).to.deep.equal(['Go to Send']);
        expect(labelsFor('go nothing')).to.deep.equal([]);
    });

    it('matches keywords, sections & descriptions too', () => {
        expect(labelsFor('preferences')).to.deep.equal(['Open Settings']);
        expect(labelsFor('bug')).to.deep.equal(['Report an issue']);
        expect(labelsFor('localhost')).to.deep.equal(['Copy proxy address']);
        expect(labelsFor('capture')).to.deep.equal([
            'Pause recording', 'Copy proxy address', 'Import HAR…', 'Export HAR…'
        ]);
    });

    it('ranks label matches above keyword matches', () => {
        const traffic = labelsFor('traffic');
        // In the description of Pause recording, & a keyword of Go to View:
        expect(traffic).to.include.members(['Go to View', 'Pause recording']);
        expect(traffic.indexOf('Go to View')).to.be.lessThan(traffic.indexOf('Pause recording'));
    });

    it('orders sections by their best match', () => {
        const groups = searchCommands(commands, 'report', SECTIONS);
        expect(groups.map((group) => group.section)).to.deep.equal(['Help']);

        const issueFirst = searchCommands(commands, 'i', SECTIONS);
        expect(issueFirst[0].section).to.equal('Capture'); // "Import" starts with it
    });

    it('says which label characters matched, for highlighting', () => {
        expect(matchCommand(commands[1], 'view')!.labelMatches).to.deep.equal([6, 7, 8, 9]);
        expect(matchCommand(commands[1], 'gtv')!.labelMatches).to.deep.equal([0, 3, 6]);
        // Matched by a keyword only: nothing in the label to highlight
        expect(matchCommand(commands[1], 'traffic')!.labelMatches).to.deep.equal([]);
    });

});
