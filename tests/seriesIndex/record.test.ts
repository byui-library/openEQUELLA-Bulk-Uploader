import { describe, it, expect } from 'vitest';
import { indexRecord } from '../../src/core/seriesIndex/record.js';

const schema = {
  titleHeader: 'DC/title',
  descriptionHeader: 'DC/description',
  paths: new Set(['DC/title', 'DC/description', 'DC/identifier', 'DC/type']),
};
const section = {
  columns: [
    { path: 'DC/title', value: 'Fernbrook Quarterly: index' },
    { path: 'DC/description', value: 'Every volume.' },
    { path: 'DC/identifier', value: 'FQ_index' },
    { path: 'DC/type', value: 'Text' },
  ],
};

describe('indexRecord', () => {
  it('reads title, description, identifier and every field', () => {
    const r = indexRecord(section, schema);
    expect(r.title).toBe('Fernbrook Quarterly: index');
    expect(r.description).toBe('Every volume.');
    expect(r.identifier).toEqual({ path: 'DC/identifier', value: 'FQ_index' });
    expect(r.identifierProblem).toBeNull();
    expect(r.fields).toEqual({
      'DC/title': ['Fernbrook Quarterly: index'],
      'DC/description': ['Every volume.'],
      'DC/identifier': ['FQ_index'],
      'DC/type': ['Text'],
    });
  });

  it('refuses a path the schema does not have', () => {
    expect(() =>
      indexRecord({ columns: [...section.columns, { path: 'DC/nope', value: 'x' }] }, schema),
    ).toThrow(/DC\/nope/);
  });

  it('refuses when the schema declares no name path', () => {
    expect(() => indexRecord(section, { ...schema, titleHeader: null })).toThrow(/name path/);
  });

  it('refuses when the section gives no title', () => {
    expect(() => indexRecord({ columns: section.columns.slice(1) }, schema)).toThrow(/DC\/title/);
  });

  it('refuses when the section gives no description', () => {
    expect(() =>
      indexRecord({ columns: section.columns.filter((c) => c.path !== 'DC/description') }, schema),
    ).toThrow(/DC\/description/);
  });

  it('reports -- never throws -- when the schema has no identifier field', () => {
    const r = indexRecord(
      { columns: section.columns.filter((c) => c.path !== 'DC/identifier') },
      { ...schema, paths: new Set(['DC/title', 'DC/description', 'DC/type']) },
    );
    expect(r.identifier).toBeNull();
    expect(r.identifierProblem).toMatch(/no identifier field/);
  });

  it('reports when the section gives no identifier value', () => {
    const r = indexRecord({ columns: section.columns.filter((c) => c.path !== 'DC/identifier') }, schema);
    expect(r.identifier).toBeNull();
    expect(r.identifierProblem).toMatch(/DC\/identifier/);
  });
});
