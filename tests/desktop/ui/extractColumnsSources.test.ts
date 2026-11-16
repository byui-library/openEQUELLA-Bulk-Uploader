// tests/desktop/ui/extractColumnsSources.test.ts
import { describe, it, expect } from 'vitest';
import { renderExtractColumns, type ExtractColumnsProps } from '../../../src/desktop/ui/screens/extractColumns.js';
import { FakeElement } from '../../helpers/fakeDom.js';
import { describeSource, optionsForColumn } from '../../../src/desktop/ui/extract/sources.js';
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

/**
 * ## A configured column shows what it is configured with
 *
 * REPORTED BY THE OPERATOR from the shipped obituary template: every dropdown
 * read "(nothing -- fill in Excel)" while the hint beside it plainly described
 * a chain. `sourceOptions` offers what the FILES supply, none of that template's
 * first sources are among them, no label matched, and each select fell back to
 * its first entry.
 */
describe('a column configured with something the files do not supply', () => {
  const selected = (html: string): string => {
    const select = /<select[^>]*class="source-select"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';
    const marked = /<option value="[^"]*"[^>]*selected[^>]*>([^<]*)</.exec(select);
    return marked === null ? '(nothing selected)' : marked[1]!.trim();
  };

  it('shows a dateNear source rather than reporting the column empty', () => {
    const html = render(chained([{ dateNear: ['passed away', 'died'] }])).innerHTML;
    expect(selected(html)).toBe('A date after: passed away, died');
  });

  it('shows a compose source', () => {
    const html = render(chained([{ compose: 'Died {death_date}' }])).innerHTML;
    expect(selected(html)).toBe('Built from other columns: Died {death_date}');
  });

  it('still shows nothing selected for a column with no sources', () => {
    expect(selected(render(chained([])).innerHTML)).toBe('(nothing selected)');
  });

  /**
   * NOT TESTED HERE, AND THE REASON IS THE POINT: choosing the appended entry
   * back again needs the handler to know WHICH column it belongs to, and it
   * learns that from `closest('tr')`. `fakeDom` hands out unparented stubs and
   * always answers null, so a test written here would exercise the stand-in
   * rather than the screen -- and would pass whatever the screen did.
   *
   * What holds the two sides together is that both call `optionsForColumn`,
   * which is tested directly in tests/desktop/ui/extract/sources.test.ts. The
   * round trip itself was checked against the running app.
   */
});

/**
 * ## Text with parts of the name
 *
 * REPORTED BY THE OPERATOR, building the Snake River Echoes spreadsheet: a
 * description of fixed words plus the volume number -- "Upper Snake River
 * Valley Historical Society Quarterly, Volume 2" -- could not be made on this
 * screen. The format had it all along (`join`, which the shipped templates use
 * for titles); the screen offered no way to make one.
 */
describe('a column built from text with parts of the name', () => {
  const volumes = (sources: Source[]): Profile => ({
    version: 1,
    pattern: 'SRE_Vol{volume}',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/description', sources },
    ],
  });

  function choose(root: FakeElement, label: string): void {
    const select = root.querySelector('.source-select') as unknown as FakeElement;
    const index = [...root.innerHTML.matchAll(/<option value="(\d+)"[^>]*>([^<]*)</g)].find((m) =>
      m[2]!.startsWith(label),
    );
    select.value = index![1]!;
    select.listeners.get('change')!.forEach((fn) => fn({}));
  }

  it('is offered, and starts from the first part of the name', () => {
    const chosen: Source[] = [];
    const root = render(volumes([]), { onSourceChange: (_p, s) => s && chosen.push(s) });
    choose(root, 'Text with parts of the name');
    expect(chosen).toEqual([{ join: '{volume}' }]);
  });

  it('shows the text in a box to edit, selected in the list, with the parts it can use', () => {
    const html = render(volumes([{ join: 'Quarterly, Volume {volume}' }])).innerHTML;
    expect(html).toMatch(/<option value="\d+" selected>Text with parts of the name/);
    expect(html).toMatch(/class="join-input"[^>]*value="Quarterly, Volume \{volume\}"/);
    expect(html).toContain('{volume}');
    // Listed once: the text is in the box, not as a second option.
    expect(html.match(/Text with parts of the name/g)).toHaveLength(1);
  });

  it('saves what is typed when the box is left', () => {
    const chosen: Source[] = [];
    const root = render(volumes([{ join: '{volume}' }]), { onSourceChange: (_p, s) => s && chosen.push(s) });
    const input = root.querySelector('.join-input') as unknown as FakeElement;
    input.value = 'Upper Snake River Valley Historical Society Quarterly, Volume {volume}';
    input.listeners.get('change')!.forEach((fn) => fn({}));
    expect(chosen).toEqual([{ join: 'Upper Snake River Valley Historical Society Quarterly, Volume {volume}' }]);
  });

  // Asserted on the option list itself: the screen's change handler finds the
  // column through `closest('tr')`, which the fake DOM cannot answer (see
  // tests/helpers/fakeDom.ts), and it resolves the choice from exactly this list.
  it('keeps the text it had rather than resetting it when chosen again', () => {
    const scan = { labels: [], properties: [], tableColumns: [], sections: [] };
    const options = optionsForColumn('SRE_Vol{volume}', scan, [{ join: 'Quarterly, Volume {volume}' }]);
    expect(options.filter((o) => 'join' in o.source)).toEqual([
      { label: 'Text with parts of the name…', source: { join: 'Quarterly, Volume {volume}' } },
    ]);
  });

  it('ignores a blank box rather than saving a source that could never fill anything', () => {
    const chosen: (Source | null)[] = [];
    const root = render(volumes([{ join: '{volume}' }]), { onSourceChange: (_p, s) => chosen.push(s) });
    const input = root.querySelector('.join-input') as unknown as FakeElement;
    input.value = '   ';
    input.listeners.get('change')!.forEach((fn) => fn({}));
    expect(chosen).toEqual([]);
  });
});

describe('checking the typed text before it is saved', () => {
  const volumes: Profile = {
    version: 1,
    pattern: 'SRE_Vol{volume}',
    columns: [
      { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
      { path: 'MWDL/description', sources: [{ join: '{volume}' }] },
    ],
  };

  // Saving a bad text would either write it into every item (a malformed
  // brace) or be refused and re-render the box with the OLD text, throwing
  // the typing away. Not saving -- and saying why beside the box -- does neither.
  it.each(['Quarterly, Volume { volume }', 'Quarterly, Volume {Volume}', 'Quarterly, Volume {volume'])(
    'does not save %s, and says why beside the box',
    (typed) => {
      const chosen: (Source | null)[] = [];
      const root = render(volumes, { onSourceChange: (_p, s) => chosen.push(s) });
      const input = root.querySelector('.join-input') as unknown as FakeElement;
      input.value = typed;
      input.listeners.get('change')!.forEach((fn) => fn({}));
      expect(chosen).toEqual([]);
      expect(root.innerHTML).toContain('class="error join-error"');
    },
  );

  it('names a join source the same way everywhere', () => {
    expect(describeSource({ join: 'Quarterly, Volume {volume}' })).toBe(
      'Text with parts of the name: "Quarterly, Volume {volume}"',
    );
  });
});
