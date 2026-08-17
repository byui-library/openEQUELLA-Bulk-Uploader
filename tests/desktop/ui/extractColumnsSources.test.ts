// tests/desktop/ui/extractColumnsSources.test.ts
import { describe, it, expect } from 'vitest';
import { renderExtractColumns, type ExtractColumnsProps } from '../../../src/desktop/ui/screens/extractColumns.js';
import { FakeElement } from '../../helpers/fakeDom.js';
import { ATTACHMENT_COLUMN, type Profile, type Source } from '../../../src/core/extract/types.js';

/**
 * ## The one dropdown, and the chain behind it
 *
 * The columns screen shows a single source per column. Until the chain gets its
 * own editor, the row has to SAY what the dropdown does not govern -- an
 * operator reading "Built from other columns" has no way to know a language
 * model runs after it, and no way to know that choosing something else here
 * leaves it running.
 *
 * Asserted through `fakeDom` rather than as a returned string, because the
 * dropdown's `change` listener is the half that used to collapse the chain, and
 * a markup assertion cannot reach it.
 */

function chained(sources: Source[]): Profile {
  return {
    version: 1,
    pattern: '{part1}.pdf',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/description', sources },
    ],
  };
}

function render(profile: Profile, over: Partial<ExtractColumnsProps> = {}): FakeElement {
  const root = new FakeElement();
  const props: ExtractColumnsProps = {
    profile,
    profilePath: null,
    sampleFilename: 'a.pdf',
    scan: { labels: [], properties: [], tableColumns: [], sections: ['Abstract'] },
    preview: [],
    busy: false,
    error: null,
    onPatternChange: () => {},
    onSourceChange: () => {},
    onDefaultChange: () => {},
    onRemove: () => {},
    onMove: () => {},
    onAdd: () => {},
    removed: null,
    onUndoRemove: () => {},
    onOpenProfile: () => {},
    onSaveProfile: () => {},
    onContinue: () => {},
    onBack: () => {},
    ...over,
  };
  renderExtractColumns(root as unknown as HTMLElement, props);
  return root;
}

describe('a column whose source chain is longer than the dropdown', () => {
  it('names what runs after the source the dropdown shows', () => {
    const html = render(chained([{ compose: '{birth_date}' }, { ai: true }])).innerHTML;
    expect(html).toContain('then: A language model');
  });

  it('says nothing extra when the column has a single source', () => {
    const html = render(chained([{ compose: '{birth_date}' }])).innerHTML;
    expect(html).not.toContain('then:');
  });
});

describe('choosing a source from the dropdown', () => {
  /**
   * The option index is the dropdown's value, so this walks the same list the
   * screen built rather than assuming a position -- an assumed index would pass
   * while pointing at the wrong source.
   */
  function chooseByLabel(root: FakeElement, label: string): void {
    const select = root.querySelector('.source-select') as unknown as FakeElement;
    const index = [...root.innerHTML.matchAll(/<option value="(\d+)"[^>]*>([^<]*)</g)].find((m) =>
      m[2]!.startsWith(label),
    );
    select.value = index![1]!;
    select.listeners.get('change')!.forEach((fn) => fn({}));
  }

  it('offers a language model, and reports choosing it as { ai: true }', () => {
    const chosen: Source[] = [];
    const root = render(chained([{ compose: '{x}' }]), {
      onSourceChange: (_path, source) => {
        if (source) chosen.push(source);
      },
    });
    chooseByLabel(root, 'A language model');
    expect(chosen).toEqual([{ ai: true }]);
  });

  /**
   * The index the dropdown reports is an offset into a list this screen
   * rebuilds inside the listener. Pinning a second option proves it is read
   * rather than that one position happens to line up.
   */
  it('maps the chosen option to its own source', () => {
    const chosen: Source[] = [];
    const root = render(chained([{ compose: '{x}' }]), {
      onSourceChange: (_path, source) => {
        if (source) chosen.push(source);
      },
    });
    chooseByLabel(root, 'Section: Abstract');
    expect(chosen).toEqual([{ section: 'Abstract' }]);
  });

  it('reports no source at all when the blank option is chosen', () => {
    const chosen: (Source | null)[] = [];
    const root = render(chained([{ compose: '{x}' }, { ai: true }]), {
      onSourceChange: (_path, source) => chosen.push(source),
    });
    const select = root.querySelector('.source-select') as unknown as FakeElement;
    select.value = '';
    select.listeners.get('change')!.forEach((fn) => fn({}));
    expect(chosen).toEqual([null]);
  });
});
