// tests/ai/verify.test.ts
import { describe, it, expect } from 'vitest';
import { unsupportedClaims } from '../../src/core/ai/verify.js';
import type { Profile } from '../../src/core/extract/types.js';

/**
 * EVERY PERSON, PLACE, DATE AND INSTITUTION BELOW IS INVENTED, and the naming
 * convention is the repository's: botanical surnames, invented towns, invented
 * dates. See CLAUDE.md -- the real names of ten deceased people once reached
 * this repository's tests and had to be scrubbed before it could be published.
 *
 * The fixtures are modelled on the SHAPE of two failures observed against a
 * real local model on 2026-08-14 -- a full ISO date written for a document that
 * states no date at all, and an affiliation asserted for a document that
 * mentions none -- and on nothing from the documents themselves.
 */

/** A profile with one `presence` source, the generic shape the third check
 *  reads. The trigger list and the `then` string are the profile's own
 *  vocabulary; nothing in `verify.ts` knows what either means. */
const withPresence: Profile = {
  version: 1,
  pattern: '{name}.pdf',
  columns: [
    {
      path: 'SCHEMA/relation',
      composeOnly: true,
      sources: [
        {
          presence: {
            any: ['Larkspur Academy', "Larkspur's Academy", 'Larkspur Institute'],
            then: 'Attended Larkspur Academy',
          },
        },
      ],
    },
    { path: 'SCHEMA/description', sources: [{ opening: true }, { ai: true }] },
  ],
};

/** The same profile with the `presence` source removed, so the assertion check
 *  has no vocabulary to read and must simply not run. */
const withoutPresence: Profile = {
  version: 1,
  pattern: '{name}.pdf',
  columns: [{ path: 'SCHEMA/description', sources: [{ opening: true }, { ai: true }] }],
};

const kinds = (generated: string, document: string, profile: Profile = withoutPresence): string[] =>
  unsupportedClaims(generated, document, profile).map((c) => c.kind);

describe('a date the document does not state', () => {
  /**
   * THE FAILURE THIS MODULE EXISTS FOR. The document says only that the person
   * died in the early hours of a Saturday morning; the model wrote a full ISO
   * date, and produced a DIFFERENT one when the same call was repeated at
   * temperature zero. Nothing is being misread -- a plausibly shaped value is
   * being generated to fill a slot.
   */
  it('is refused', () => {
    const claims = unsupportedClaims(
      'Alder Hawthorn died on 2024-01-06.',
      'Alder Hawthorn passed away peacefully in his sleep, in the early hours of Saturday morning.',
      withoutPresence,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]!.kind).toBe('date');
    expect(claims[0]!.claim).toBe('2024-01-06');
  });

  /**
   * THE MOST IMPORTANT TEST IN THIS FILE -- the false-positive guard.
   *
   * Profiles ask the model for ISO dates, and a document writes the same day in
   * words. A check comparing strings rejects a perfectly good value here, which
   * discards a description that was right and teaches the operator to distrust
   * the check. The comparison is between PARSED values, so the two forms of one
   * day are one date.
   */
  it('is accepted when the document states the same day in another format', () => {
    expect(
      unsupportedClaims(
        'Alder Hawthorn died on 2024-01-06.',
        'Alder Hawthorn passed away on January 6, 2024, at home in Marrowfield.',
        withoutPresence,
      ),
    ).toEqual([]);
  });

  it('is accepted for every spelling of the day the same recogniser reads', () => {
    for (const stated of [
      'January 6, 2024',
      'January 6 2024',
      'January 6th, 2024',
      '6 January 2024',
      'Jan. 6, 2024',
      '2024-01-06',
      '1/6/2024',
    ]) {
      expect(
        kinds('Died 2024-01-06.', `Alder Hawthorn passed away on ${stated} at home.`),
      ).toEqual([]);
    }
  });

  /**
   * INVENTING PRECISION IS THE SAME FAILURE IN MINIATURE. A document that gives
   * only a year supports a claim about that year and nothing finer; a day and a
   * month the document never wrote are as invented as a date it never mentioned.
   */
  it('is refused at day precision where the document gives only a year', () => {
    const claims = unsupportedClaims(
      'Alder Hawthorn died on 2024-01-06.',
      'Alder Hawthorn, of Marrowfield, died in 2024 after a long illness.',
      withoutPresence,
    );
    expect(claims.map((c) => c.kind)).toEqual(['date']);
    expect(claims[0]!.why).toMatch(/precise/i);
  });

  it('is refused at day precision where the document gives only a month', () => {
    expect(
      kinds(
        'Died 2024-01-06.',
        'Alder Hawthorn died in January 2024 after a long illness.',
      ),
    ).toEqual(['date']);
  });

  /** The claim no finer than the document is supported, in both directions of
   *  precision the document can offer. */
  it('is accepted at a precision the document actually reaches', () => {
    expect(kinds('Born in 1938.', 'Alder Hawthorn was born in 1938 in Thistledown.')).toEqual([]);
    expect(kinds('Born in 1938.', 'Alder Hawthorn was born on July 22, 1938.')).toEqual([]);
    expect(kinds('Died 2024-01.', 'Alder Hawthorn died on January 6, 2024.')).toEqual([]);
  });

  it('is refused when the year alone is one the document never gives', () => {
    expect(kinds('Born in 1938.', 'Alder Hawthorn was born in Thistledown.')).toEqual(['date']);
  });

  /** Two invented dates are two claims, so the note can name both. */
  it('reports every unsupported date, not just the first', () => {
    expect(
      kinds('Died 2024-01-06; born 1938-07-22.', 'Alder Hawthorn lived his whole life in Marrowfield.'),
    ).toEqual(['date', 'date']);
  });
});

describe('a number the document does not give', () => {
  it('is refused', () => {
    const claims = unsupportedClaims(
      'Alder Hawthorn taught at the academy for 47 years.',
      'Alder Hawthorn taught at the academy for many years.',
      withoutPresence,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]!.kind).toBe('number');
    expect(claims[0]!.claim).toBe('47');
  });

  it('is accepted when the document gives it', () => {
    expect(
      kinds(
        'Alder Hawthorn taught at the academy for 47 years.',
        'He gave 47 years of service to the academy in Marrowfield.',
      ),
    ).toEqual([]);
  });

  /** Compared as VALUES, so a thousands separator on one side and not the other
   *  is not a fabrication. */
  it('is accepted across separator and trailing-zero differences', () => {
    expect(kinds('A congregation of 1200.', 'Some 1,200 people attended.')).toEqual([]);
    expect(kinds('A congregation of 1,200.', 'Some 1200 people attended.')).toEqual([]);
    expect(kinds('It measured 3.50 acres.', 'The plot measured 3.5 acres.')).toEqual([]);
  });

  /**
   * SPELLED-OUT NUMBERS IN THE DOCUMENT STILL SUPPORT A DIGIT IN THE OUTPUT.
   * Turning "forty-seven" into "47" is what summarising prose into a catalogue
   * value looks like, and refusing it would discard a description whose every
   * fact is the document's own.
   */
  it('is accepted where the document spells it out', () => {
    expect(kinds('Survived by 12 grandchildren.', 'He is survived by twelve grandchildren.')).toEqual([]);
    expect(kinds('47 years of service.', 'He gave forty-seven years of service.')).toEqual([]);
    expect(kinds('47 years of service.', 'He gave forty seven years of service.')).toEqual([]);
  });

  /**
   * SINGLE DIGITS ARE DELIBERATELY NOT CHECKED. A small count is the one number
   * a model can legitimately produce by COUNTING what the document lists rather
   * than by quoting it -- "survived by 4 children" over a document that names
   * four -- and refusing a whole description over a digit the document never
   * had to write is the expensive mistake in the wrong direction.
   */
  it('is not checked at all below ten', () => {
    expect(kinds('Survived by 4 children.', 'He is survived by his children.')).toEqual([]);
  });

  /**
   * A NUMBER THAT IS PART OF A DATE HAS ALREADY BEEN CHECKED AS A DATE. Without
   * this the `01` and `06` of an accepted `2024-01-06` are hunted for as
   * numbers, found nowhere in a document that wrote "January 6, 2024", and a
   * supported date is refused through the other check.
   */
  it('is not counted twice when it belongs to a date already checked', () => {
    expect(kinds('Died 2024-01-06.', 'Alder Hawthorn passed away on January 6, 2024.')).toEqual([]);
  });

  /** Spelled-out in the OUTPUT is not a claim this check reads: paraphrase is
   *  free to re-word, and "five" against "5" is not a difference in fact. */
  it('is not checked when the output spells it out', () => {
    expect(kinds('Survived by twelve grandchildren.', 'He is survived by his family.')).toEqual([]);
  });
});

describe('an assertion the profile already has a check for', () => {
  /**
   * THE GENERIC FORM OF THE SECOND OBSERVED FAILURE. Two documents mentioned no
   * affiliated institution and the model asserted one in both, against a profile
   * instruction saying to include that clause only where the document says so.
   *
   * The vocabulary is the PROFILE'S -- a `presence` source's own trigger list --
   * so this catches the phrasing variants too, and works for any `presence`
   * source any institution writes. Nothing here knows what an institution is.
   */
  it('is refused where the document contains none of the triggers', () => {
    const claims = unsupportedClaims(
      'Alder Hawthorn attended Larkspur Academy before returning to Marrowfield.',
      'Alder Hawthorn lived his whole life in Marrowfield and worked as a bookbinder.',
      withPresence,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]!.kind).toBe('assertion');
    expect(claims[0]!.claim).toBe('Larkspur Academy');
  });

  it('is accepted where the document does contain one', () => {
    expect(
      unsupportedClaims(
        'Alder Hawthorn attended Larkspur Academy before returning to Marrowfield.',
        'After the war he studied at Larkspur Academy, returning to Marrowfield in later life.',
        withPresence,
      ),
    ).toEqual([]);
  });

  /** Any trigger in the list evidences any other: the list exists precisely
   *  because one entity is written several ways. */
  it('is accepted where the document uses a different spelling from the list', () => {
    expect(
      unsupportedClaims(
        'Alder Hawthorn attended Larkspur Academy.',
        "He was a graduate of Larkspur's Academy.",
        withPresence,
      ),
    ).toEqual([]);
  });

  /** Case-insensitive substring, the same matching the `presence` source itself
   *  uses in `rows.ts` -- so the check and the source cannot disagree about
   *  whether the document mentions the thing. */
  it('reads the document the way the presence source reads it', () => {
    expect(
      unsupportedClaims('Attended LARKSPUR ACADEMY.', 'a graduate of larkspur academy', withPresence),
    ).toEqual([]);
  });

  /**
   * A PROFILE WITH NO `presence` SOURCE HAS NO VOCABULARY, so the check has
   * nothing to run on and refuses nothing. It must not fall back to a list of
   * its own -- a hardcoded institution is the assumption an entire release of
   * this repository was spent removing.
   */
  it('does not run at all for a profile that declares no presence source', () => {
    expect(
      unsupportedClaims(
        'Alder Hawthorn attended Larkspur Academy before returning to Marrowfield.',
        'Alder Hawthorn lived his whole life in Marrowfield and worked as a bookbinder.',
        withoutPresence,
      ),
    ).toEqual([]);
  });
});

describe('free prose', () => {
  /**
   * PARAPHRASE IS LEGITIMATE DESCRIPTION and is not checked. Eight of the ten
   * outputs in the run that prompted this work were fine; a check that reads
   * prose for support would have rejected them.
   */
  it('is accepted, and nothing in it is treated as a claim', () => {
    expect(
      unsupportedClaims(
        'A bookbinder of Marrowfield, remembered by his family for his patience and his garden.',
        'Alder Hawthorn bound books in Marrowfield for most of his life. His family recall a ' +
          'patient man who kept a garden behind the shop.',
        withPresence,
      ),
    ).toEqual([]);
  });

  /** Wording the document never used is not a claim either: this refuses facts
   *  the document does not carry, never sentences it does not contain. */
  it('is accepted even where it shares no wording with the document', () => {
    expect(
      unsupportedClaims(
        'Records the life and trade of a craftsman in a small town.',
        'Alder Hawthorn bound books in Marrowfield for most of his life.',
        withPresence,
      ),
    ).toEqual([]);
  });

  it('is accepted when there is no document text at all and no claim is made', () => {
    expect(unsupportedClaims('A short description.', '', withPresence)).toEqual([]);
  });
});

describe('what a claim carries', () => {
  it('names what the model said and gives one clause saying why', () => {
    const claims = unsupportedClaims(
      'Died 2024-01-06 after 47 years at Larkspur Academy.',
      'Alder Hawthorn lived in Marrowfield.',
      withPresence,
    );
    expect(claims.map((c) => c.kind).sort()).toEqual(['assertion', 'date', 'number']);
    for (const claim of claims) {
      expect(claim.claim).not.toBe('');
      // One clause: no leading capital, no full stop -- it is written to follow
      // '...: ' inside a longer sentence.
      expect(claim.why).not.toMatch(/[.!?]$/);
      expect(claim.why.length).toBeGreaterThan(10);
    }
  });

  it('does not report the same claim twice', () => {
    expect(
      kinds('Died 2024-01-06, and 2024-01-06 is recorded elsewhere.', 'He died at home.'),
    ).toEqual(['date']);
  });
});
