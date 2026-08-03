import { describe, it, expect } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { buildMetadataXml } from '../src/core/metadata.js';

describe('buildMetadataXml', () => {
  it('nests a single xpath', () => {
    expect(buildMetadataXml({ 'MWDL/title': ['Hello'] })).toBe(
      '<xml><MWDL><title>Hello</title></MWDL></xml>',
    );
  });

  it('merges sibling paths under a shared parent', () => {
    const xml = buildMetadataXml({ 'MWDL/title': ['T'], 'MWDL/abstract': ['A'] });
    expect(xml).toBe('<xml><MWDL><title>T</title><abstract>A</abstract></MWDL></xml>');
  });

  it('emits repeated values as sibling elements', () => {
    const xml = buildMetadataXml({ 'MWDL/creators/creator': ['Ann', 'Bob'] });
    expect(xml).toBe(
      '<xml><MWDL><creators><creator>Ann</creator><creator>Bob</creator></creators></MWDL></xml>',
    );
  });

  it('emits an empty tag for a blank value', () => {
    expect(buildMetadataXml({ 'MWDL/abstract': [''] })).toBe('<xml><MWDL><abstract/></MWDL></xml>');
  });

  it('escapes XML metacharacters', () => {
    const xml = buildMetadataXml({ 'MWDL/description': ['A & B <c> "d"'] });
    expect(xml).toBe(
      '<xml><MWDL><description>A &amp; B &lt;c&gt; &quot;d&quot;</description></MWDL></xml>',
    );
  });

  it('handles the real jury description without corruption', () => {
    const desc =
      'Jury Video - To download video file: Apple : Right-click on link and choose ' +
      '"Download linked file"; for Windows: Right click link and choose "Save Target As"';
    const xml = buildMetadataXml({ 'MWDL/description': [desc] });
    expect(xml).toContain('&quot;Download linked file&quot;');
    expect(xml).not.toContain('<"');
  });

  it('nests four levels deep', () => {
    const xml = buildMetadataXml({
      'BYUI_extended/BYUI_information/course_names/course_name': ['Biology 101'],
    });
    expect(xml).toBe(
      '<xml><BYUI_extended><BYUI_information><course_names>' +
        '<course_name>Biology 101</course_name>' +
        '</course_names></BYUI_information></BYUI_extended></xml>',
    );
  });

  it('emits multiple top-level roots in input order', () => {
    const xml = buildMetadataXml({
      'MWDL/title': ['T'],
      'BYUI_extended/byui_rights/restriction': ['R'],
    });
    expect(xml).toBe(
      '<xml><MWDL><title>T</title></MWDL>' +
        '<BYUI_extended><byui_rights><restriction>R</restriction></byui_rights></BYUI_extended></xml>',
    );
  });

  it('round-trips metacharacters through a real XML parser without corruption', () => {
    const original = `A & B <c> "d" 'e' O'Brien <tag> & &amp;`;
    const xml = buildMetadataXml({ 'MWDL/description': [original] });
    const parser = new XMLParser({ ignoreAttributes: true });
    const parsed = parser.parse(xml) as { xml: { MWDL: { description: string } } };
    expect(parsed.xml.MWDL.description).toBe(original);
  });

  it('returns an empty <xml></xml> element for empty input', () => {
    expect(buildMetadataXml({})).toBe('<xml></xml>');
  });

  it('builds a realistic full row matching the real batch header shape', () => {
    const xml = buildMetadataXml({
      'MWDL/title': ['Vocal Jury Fall 2026 - Trujillo, Ethan'],
      'MWDL/description': [
        'Jury Video - To download video file: Macintosh : Right-click on link and choose "Download linked file"; for Windows: Right click link and choose "Save Target As"',
      ],
      'MWDL/identifier': [''],
      'MWDL/creators/creator': ['Trujillo, Ethan'],
      'BYUI_extended/byui_rights/restriction': [''],
      'BYUI_extended/BYUI_information/metadata_complete': ['true'],
      'BYUI_extended/BYUI_information/course_names/course_name': ['Music 101'],
      'MWDL/abstract': [''],
      'BYUI_extended/attachments/attachment': ['12e61400-b1e1-457b-b19c-a40730e13ef8'],
    });

    expect(xml).toBe(
      '<xml>' +
        '<MWDL>' +
        '<title>Vocal Jury Fall 2026 - Trujillo, Ethan</title>' +
        '<description>Jury Video - To download video file: Macintosh : Right-click on link and choose &quot;Download linked file&quot;; for Windows: Right click link and choose &quot;Save Target As&quot;</description>' +
        '<identifier/>' +
        '<creators><creator>Trujillo, Ethan</creator></creators>' +
        '<abstract/>' +
        '</MWDL>' +
        '<BYUI_extended>' +
        '<byui_rights><restriction/></byui_rights>' +
        '<BYUI_information>' +
        '<metadata_complete>true</metadata_complete>' +
        '<course_names><course_name>Music 101</course_name></course_names>' +
        '</BYUI_information>' +
        '<attachments><attachment>12e61400-b1e1-457b-b19c-a40730e13ef8</attachment></attachments>' +
        '</BYUI_extended>' +
        '</xml>',
    );
  });
});
