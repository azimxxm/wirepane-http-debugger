import { expect } from 'chai';
import {
    buildArchiveFilename,
    buildHarFilename,
    buildRulesFilename,
    buildRequestBaseName,
    sanitizeFilename
} from '../../../src/util/export-filenames';

describe('export-filenames', () => {

    describe('sanitizeFilename', () => {

        it('replaces path separators and Windows-reserved characters', () => {
            expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'))
                .to.equal('a_b_c_d_e_f_g_h_i_j');
        });

        it('prefixes Windows-reserved device names', () => {
            expect(sanitizeFilename('CON.txt'))
                .to.equal('_CON.txt');
            expect(sanitizeFilename('nul...'))
                .to.equal('_nul');
        });

        it('falls back for empty or traversal-only names', () => {
            expect(sanitizeFilename('')).to.equal('unnamed');
            expect(sanitizeFilename('..', 'request')).to.equal('request');
        });

    });

    describe('buildRequestBaseName', () => {

        it('builds a standard base name with hostname and path', () => {
            expect(buildRequestBaseName({
                index: 1,
                total: 20,
                method: 'GET',
                status: 200,
                url: 'https://api.github.com/repos'
            })).to.equal('01_GET_200_api.github.com__repos');
        });

        it('zero-pads based on total request count', () => {
            expect(buildRequestBaseName({
                index: 1,
                total: 200,
                method: 'GET',
                status: 200,
                url: ''
            })).to.equal('001_GET_200');
        });

        it('uppercases the method', () => {
            expect(buildRequestBaseName({
                index: 1,
                total: 20,
                method: 'post',
                status: 201,
                url: ''
            })).to.equal('01_POST_201');
        });

        it('omits unknown or invalid statuses', () => {
            expect(buildRequestBaseName({
                index: 7,
                total: 20,
                method: 'DELETE',
                status: null,
                url: ''
            })).to.equal('07_DELETE');
            expect(buildRequestBaseName({
                index: 8,
                total: 20,
                method: 'GET',
                status: 0,
                url: ''
            })).to.equal('08_GET');
        });

        it('handles large index numbers beyond padding', () => {
            expect(buildRequestBaseName({
                index: 9999,
                total: 20,
                method: 'PATCH',
                status: 204,
                url: ''
            })).to.equal('9999_PATCH_204');
        });

        it('uses REQ for empty method strings', () => {
            expect(buildRequestBaseName({
                index: 1,
                total: 20,
                method: '',
                status: 200,
                url: ''
            })).to.equal('01_REQ_200');
        });

        it('handles URL with port by dropping port', () => {
            expect(buildRequestBaseName({
                index: 1,
                total: 20,
                method: 'GET',
                status: 200,
                url: 'http://localhost:8080/api'
            })).to.equal('01_GET_200_localhost__api');
        });

        it('handles IP address URLs', () => {
            expect(buildRequestBaseName({
                index: 1,
                total: 20,
                method: 'GET',
                status: 200,
                url: 'http://192.168.1.1/test'
            })).to.equal('01_GET_200_192.168.1.1__test');
        });

        it('uses invalid URLs as sanitized path text', () => {
            expect(buildRequestBaseName({
                index: 1,
                total: 20,
                method: 'GET',
                status: 200,
                url: 'not-a-url'
            })).to.equal('01_GET_200_not-a-url');
        });

    });

    describe('buildArchiveFilename', () => {

        it('contains date and time', () => {
            const name = buildArchiveFilename(new Date(2026, 4, 17, 12, 34));
            expect(name).to.equal('Wirepane_Export_2026-05-17_12-34.zip');
        });

    });

    describe('HAR & rules export names', () => {

        it('use our name and the local date & time', () => {
            const now = new Date(2026, 9, 2, 9, 5);
            expect(buildHarFilename(now)).to.equal('Wirepane_2026-10-02_09-05.har');
            expect(buildRulesFilename(now)).to.equal('Wirepane_2026-10-02_09-05.htkrules');
        });

        it('default to now', () => {
            expect(buildHarFilename()).to.match(/^Wirepane_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.har$/);
        });

    });

});
