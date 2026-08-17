// tests/ai/verify.test.ts
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { documentEvidence, unsupportedClaims } from '../../src/core/ai/verify.js';
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
   * THE FAILURE THIS MODULE EXISTS FOR. The document places the death only by
   * season and time of day and states no date at all; the model wrote a full
   * ISO date, and produced a DIFFERENT one each time the call was repeated at
   * temperature zero. Nothing is being misread -- a plausibly shaped value is
   * being generated to fill a slot.
   */
  it('is refused', () => {
    const claims = unsupportedClaims(
      'Alder Hawthorn died on 2024-01-06.',
      'Alder Hawthorn died at home, quietly and with his family beside him, on an afternoon at the end of the harvest.',
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
    expect(kinds('Born in 1907.', 'Alder Hawthorn was born in 1907 in Thistledown.')).toEqual([]);
    expect(kinds('Born in 1907.', 'Alder Hawthorn was born on November 13, 1907.')).toEqual([]);
    expect(kinds('Died 2024-01.', 'Alder Hawthorn died on January 6, 2024.')).toEqual([]);
  });

  it('is refused when the year alone is one the document never gives', () => {
    expect(kinds('Born in 1907.', 'Alder Hawthorn was born in Thistledown.')).toEqual(['date']);
  });

  /** Two invented dates are two claims, so the note can name both. */
  it('reports every unsupported date, not just the first', () => {
    expect(
      kinds('Died 2024-01-06; born 1907-11-13.', 'Alder Hawthorn lived his whole life in Marrowfield.'),
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

/**
 * THE GAP THAT MADE THE WHOLE LAYER OPTIONAL.
 *
 * There was no month-and-day form and no separator form without a four-digit
 * year, so "no form matched" was treated as "no claim was made" and every one of
 * these was written into a permanent catalogue. The layer passed its first real
 * batch only because the model that ran it happens to answer in ISO -- a model
 * writing `He died on January 6` defeated it completely.
 */
describe('a date with no year', () => {
  const DATELESS =
    'Alder Hawthorn died at home, quietly and with his family beside him, at the end of the harvest.';

  it('is a claim, and is refused where the document states no date at all', () => {
    for (const generated of [
      'He died on January 6.',
      'He died on January 6th.',
      'He died on Jan. 6.',
      'He died 1/6.',
      'He died on the 6th of January.',
    ]) {
      expect(kinds(generated, DATELESS), generated).toEqual(['date']);
    }
  });

  it('is accepted where the document does state that day', () => {
    for (const generated of ['He died on January 6.', 'He died 1/6.', 'He died on the 6th of January.']) {
      expect(
        kinds(generated, 'Alder Hawthorn died on January 6, 2024, at home in Marrowfield.'),
        generated,
      ).toEqual([]);
    }
  });

  /**
   * A YEAR IS NOT A DAY, IN EITHER DIRECTION. The document states the year and
   * the age; the model added a day and a month it never wrote, and the age it
   * did -- so the number passes and the date must not.
   */
  it('is refused where the document gives only the year, however plausible the rest', () => {
    expect(
      kinds('He died on January 6, aged 87.', 'He died in 2024 aged eighty-seven.'),
    ).toEqual(['date']);
  });

  /** A month behind a date preposition is a claim about when, and nothing but a
   *  month in the document supports it. */
  it('is a claim for a bare month name behind a date preposition', () => {
    expect(kinds('He died in January.', DATELESS)).toEqual(['date']);
    expect(kinds('He died in January.', 'The funeral was held in January.')).toEqual([]);
  });

  /**
   * AND IS NOT A CLAIM WITHOUT ONE. `May`, `March` and `August` are a modal
   * verb, a verb and an adjective, and "May he rest in peace" is a sentence a
   * model writes about exactly these documents. Refusing a whole description
   * over it would be the expensive mistake in the wrong direction.
   */
  it('is not a claim for a month name used as an ordinary English word', () => {
    expect(kinds('May he rest in peace.', DATELESS)).toEqual([]);
    expect(kinds('The band would march at the head of the parade.', DATELESS)).toEqual([]);
  });
});

/**
 * THE SAME GAP LAUNDERING FABRICATED PRECISION. Each of these states a day over
 * a document that gives only the year, and each used to be written because the
 * only part the recogniser could see was the `2024` the document does support.
 */
describe('a day-precision claim on a year-only document', () => {
  const YEAR_ONLY = 'Alder Hawthorn, of Marrowfield, died in 2024 after a long illness.';

  it('is refused however the model formatted it', () => {
    for (const generated of [
      'Died 2024-01-06.',
      'Died 2024-01-06T00:00:00Z.',
      'Died 2024-01-06 12:30.',
      'Died in January of 2024.',
      'Died January the 6th, 2024.',
      'Died the 6th of January 2024.',
      'Died 6.1.2024.',
    ]) {
      expect(kinds(generated, YEAR_ONLY), generated).toEqual(['date']);
    }
  });

  /** A timestamp is a date, and the whole of it is quoted back so the operator
   *  can find it in the reply. The `T` is a word character, which is the entire
   *  reason the old `\b`-terminated pattern saw a bare `2024` here. */
  it('names the timestamp the model actually wrote', () => {
    const claims = unsupportedClaims('Died 2024-01-06T00:00:00Z.', YEAR_ONLY, withoutPresence);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.claim).toBe('2024-01-06T00:00:00Z');
  });

  it('is accepted when the document does reach that day', () => {
    for (const generated of [
      'Died 2024-01-06T00:00:00Z.',
      'Died in January of 2024.',
      'Died January the 6th, 2024.',
    ]) {
      expect(kinds(generated, 'He died on 6 January 2024 at home.'), generated).toEqual([]);
    }
  });
});

/**
 * TWELVE CONFIRMED CLASSES OF FALSE REJECTION, each a CORRECT description
 * refused whole. A false rejection discards good work and teaches the operator
 * to distrust the check, which is the more expensive of the two failures this
 * module can have.
 */
describe('a correct description that used to be refused', () => {
  it('is accepted across the date formats a document really uses', () => {
    expect(kinds('Died 2024-01-06.', 'He died 6.1.2024.')).toEqual([]);
    expect(kinds('Died 2024-01-06.', 'He died 6-1-2024.')).toEqual([]);
    expect(kinds('Died 1998-04-02.', 'He died 4/2/98.')).toEqual([]);
    expect(kinds('Died 1998-04-02.', 'He died 2.4.98.')).toEqual([]);
    expect(kinds('Died 2024-01-06.', 'He died the 6th of January 2024.')).toEqual([]);
    expect(kinds('Died 2024-01-06.', 'He died January the 6th, 2024.')).toEqual([]);
  });

  it('is accepted where the document spells a number out above ninety-nine', () => {
    expect(kinds('Some 200 mourners attended.', 'Two hundred mourners attended.')).toEqual([]);
    expect(kinds('Some 1000 mourners attended.', 'A thousand mourners attended.')).toEqual([]);
    expect(kinds('112 names are listed.', 'One hundred and twelve names are listed.')).toEqual([]);
  });

  it('is accepted where the document writes an ordinal in words', () => {
    expect(kinds('The 21st reunion.', 'The twenty-first reunion was held that autumn.')).toEqual([]);
    expect(kinds('The 40th anniversary.', 'They marked their fortieth anniversary.')).toEqual([]);
  });

  it('is accepted where the document says a dozen', () => {
    expect(kinds('Some 12 books survive.', 'A dozen books survive.')).toEqual([]);
  });

  it('is accepted across every thousands separator', () => {
    expect(kinds('1200 people.', 'Some 1.200 people attended.')).toEqual([]);
    expect(kinds('1200 people.', 'Some 1 200 people attended.')).toEqual([]);
    expect(kinds('1200 people.', 'Some 1,200 people attended.')).toEqual([]);
  });

  it('is accepted where the document spells out a decimal', () => {
    expect(kinds('It ran 3.5 miles.', 'The route ran three and a half miles.')).toEqual([]);
  });

  /**
   * A GROUPED NUMBER STILL OFFERS ITS PARTS. `3 200` in a document is 3200 to a
   * European reader and "three 200-metre races" to an English one, and the
   * supporting set holds every reading -- more readings of the DOCUMENT can only
   * excuse a value, never refuse one.
   */
  it('is accepted for either reading of a space-grouped number', () => {
    expect(kinds('3200 metres.', 'He ran 3 200 metres.')).toEqual([]);
    expect(kinds('200 metres.', 'He ran 3 200 metres.')).toEqual([]);
  });
});

/**
 * FINDING 4: THE NOTE MUST NOT SAY WHAT THE DOCUMENT CONTAINS.
 *
 * `MONTH_NAMES` is English, so at a Spanish- or German-language institution
 * every day-precision claim is refused. REFUSING IS THE SAFE DIRECTION and
 * stays -- the founding fabrication came from a genuinely dateless document.
 * What must not stand is the wording: "the document states no such date" is a
 * claim about the document, and all that is known is that no date THIS TOOL CAN
 * READ supports it.
 */
describe('a document in a language the tool cannot read', () => {
  const SPANISH = 'Falleció el 6 de enero de 2024 en Marrowfield.';
  const GERMAN = 'Er starb am 6. Januar 2024 in Marrowfield.';

  it('still refuses a day-precision claim, which is the safe direction', () => {
    expect(kinds('Died 2024-01-06.', SPANISH)).toEqual(['date']);
    expect(kinds('Died 2024-01-06.', GERMAN)).toEqual(['date']);
  });

  it('never claims the document states no such date', () => {
    for (const document of [SPANISH, GERMAN, 'He lived his whole life in Marrowfield.']) {
      for (const claim of unsupportedClaims('Died 2024-01-06 in January.', document, withoutPresence)) {
        expect(claim.why, claim.claim).not.toMatch(/document states no such date/i);
        expect(claim.why, claim.claim).toMatch(/this tool can read/i);
      }
    }
  });
});

/**
 * FINDING 5: A NOTE THAT SENDS THE OPERATOR TO LOOK FOR THE ONE THING THAT IS
 * NOT THE PROBLEM is this codebase's named failure shape, inside the sentence
 * they act on.
 */
describe('what the refusal is reported as', () => {
  /** A bare four-digit run has just failed BOTH checks, and the sentence says
   *  so rather than naming only the date it might not be. */
  it('does not send them hunting for a date when the model wrote a number', () => {
    const claims = unsupportedClaims(
      'Call 555-1234 for details.',
      'Alder Hawthorn worked as a bookbinder in Marrowfield.',
      withoutPresence,
    );
    const four = claims.find((claim) => claim.claim === '1234');
    expect(four).toBeDefined();
    expect(four!.why).toMatch(/neither a date nor a number/i);
  });

  /** `06.01.2024` is a date, and reporting `06.01` as an invented NUMBER was the
   *  same misdirection from the other side. */
  it('reports a dotted date as the date the model wrote', () => {
    const claims = unsupportedClaims('Died 06.01.2024.', 'He died at home.', withoutPresence);
    expect(claims.map((c) => c.kind)).toEqual(['date']);
    expect(claims[0]!.claim).toBe('06.01.2024');
  });

  /** THE CLAIM MUST BE FINDABLE VERBATIM IN THE REPLY. `-40` was reported as
   *  `40`, so the operator went looking for something that is not there. */
  it('quotes a negative number the way the model wrote it', () => {
    const reply = 'The winter reached -40 degrees.';
    const claims = unsupportedClaims(reply, 'It was a hard winter.', withoutPresence);
    expect(claims.map((c) => c.kind)).toEqual(['number']);
    expect(claims[0]!.claim).toBe('-40');
    expect(reply).toContain(claims[0]!.claim);
  });

  /** A hyphen between two numbers is a range, not a sign. */
  it('does not read a page range as a negative number', () => {
    expect(kinds('Pages 120-140.', 'The article runs from page 120 to page 140.')).toEqual([]);
  });
});

/**
 * FINDING 6: THE YEAR/NUMBER EQUIVALENCE RUNS BOTH WAYS, AND IS NOT GUARDED.
 *
 * A bare four-digit run is ambiguous on BOTH sides, and nothing context-free can
 * tell a year from a count without reading the prose around it -- which is the
 * thing this module refuses to do. So the behaviour is pinned rather than fixed,
 * and the docblock says so: these two PASS, and the cell stays flagged for the
 * reviewer who can tell.
 */
describe('the year and number equivalence', () => {
  it('excuses a quantity supported only by an unrelated year', () => {
    expect(kinds('Enrolment reached 2019.', 'He died in 2019.')).toEqual([]);
  });

  it('excuses a year supported only by an unrelated quantity', () => {
    expect(kinds('Born in 1938.', 'He owned 1938 books.')).toEqual([]);
  });

  it('refuses it where the document supports it as neither', () => {
    expect(kinds('Born in 1938.', 'He owned a great many books.')).toEqual(['date']);
  });
});

/**
 * FINDING 2: `blank()` MASKED THE WRONG WINDOW.
 *
 * `span.start`/`span.end` come from `RegExpExecArray.index`, which counts UTF-16
 * code units; `[...text]` is a code-point array. One astral character earlier in
 * the reply desynchronised them, IN BOTH DIRECTIONS -- and a model that opens
 * with an emoji is not exotic.
 */
describe('a reply containing astral characters', () => {
  const SEEDLING = '\u{1F331}';

  /** Ten of them shift the mask far enough to swallow a fabricated number. */
  it('does not let a shifted mask hide an invented number', () => {
    const claims = unsupportedClaims(
      `${SEEDLING.repeat(10)} Died 2024-01-06 after 47 years.`,
      'Alder Hawthorn died on January 6, 2024.',
      withoutPresence,
    );
    expect(claims.map((c) => c.kind)).toEqual(['number']);
    expect(claims[0]!.claim).toBe('47');
  });

  /** Two of them expose half of a date the date check has already passed, and
   *  the exposed `20` is then refused as a number that appears nowhere. */
  it('does not expose part of an accepted date to the number check', () => {
    expect(
      kinds(`${SEEDLING.repeat(2)} Died 2024-01-06.`, 'Alder Hawthorn died on January 6, 2024.'),
    ).toEqual([]);
  });
});

/**
 * FINDING 7: FOUR MUTATIONS THAT SURVIVED THE WHOLE SUITE.
 *
 * Each of these exists to make one of them die. A threshold nothing pins is a
 * threshold anybody may move, and the last of them is the dangerous one: it
 * turns the assertion check off while leaving it reporting success.
 */
describe('the thresholds and guards nothing used to pin', () => {
  const SILENT = 'He is survived by his family, who remember him fondly.';

  it('checks a number as small as ten, and no smaller', () => {
    expect(kinds('Survived by 9 grandchildren.', SILENT)).toEqual([]);
    expect(kinds('Survived by 10 grandchildren.', SILENT)).toEqual(['number']);
    expect(kinds('Survived by 12 grandchildren.', SILENT)).toEqual(['number']);
    expect(kinds('Survived by 29 grandchildren.', SILENT)).toEqual(['number']);
  });

  /** The exemption is for INTEGERS. A fabricated measurement is not arithmetic
   *  on anything the document lists, however small it is. */
  it('checks a fraction below the threshold', () => {
    expect(kinds('It ran 3.5 miles.', 'He walked to work every day of his life.')).toEqual([
      'number',
    ]);
    expect(kinds('It measured 0.5 acres.', 'He kept a small garden.')).toEqual(['number']);
  });

  /**
   * A DATE-SHAPED STRING THAT IS NOT A DATE MUST RELEASE ITS SPAN. `45/67/2024`
   * has no reading, so its digits belong to the number check; keeping the span
   * would excuse them as "part of a date" -- a check reporting success over
   * something it never examined.
   */
  it('gives the digits of an impossible date back to the number check', () => {
    expect(kinds('Died 45/67/2024.', 'He died at home.')).toEqual(['date', 'number', 'number']);
    // `02` is below the threshold and exempt; `30` is not, and it only reaches
    // the number check because February has no thirtieth and the span was let go.
    expect(kinds('Died 2024-02-30.', 'He died at home.')).toEqual(['date', 'number']);
  });

  /**
   * ONE BLANK STRING IN A TRIGGER LIST USED TO TURN THE ASSERTION CHECK OFF, and
   * leave it reporting success -- `includes('')` is true of every string, so the
   * document looked as though it evidenced the trigger. Precisely the failure
   * this module exists to prevent, sitting inside it.
   */
  it('ignores a blank trigger rather than letting it disable the check', () => {
    const withBlank: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [
        {
          path: 'SCHEMA/relation',
          composeOnly: true,
          sources: [
            { presence: { any: ['', '   ', 'Larkspur Academy'], then: 'Attended Larkspur Academy' } },
          ],
        },
        { path: 'SCHEMA/description', sources: [{ opening: true }, { ai: true }] },
      ],
    };
    expect(
      kinds(
        'Alder Hawthorn attended Larkspur Academy before returning to Marrowfield.',
        'Alder Hawthorn lived his whole life in Marrowfield and worked as a bookbinder.',
        withBlank,
      ),
    ).toEqual(['assertion']);
  });

  /** A list of nothing but blanks is a source with no vocabulary, which is the
   *  same as no source: the check does not run, and nothing is substituted. */
  it('runs no check at all for a trigger list of nothing but blanks', () => {
    const allBlank: Profile = {
      version: 1,
      pattern: '{name}.pdf',
      columns: [
        {
          path: 'SCHEMA/relation',
          composeOnly: true,
          sources: [{ presence: { any: ['', '  '], then: 'Attended Larkspur Academy' } }],
        },
        { path: 'SCHEMA/description', sources: [{ opening: true }, { ai: true }] },
      ],
    };
    expect(kinds('Attended Larkspur Academy.', 'He lived in Marrowfield.', allBlank)).toEqual([]);
  });
});

/**
 * FINDING 9: THE CONSTRAINT THIS MODULE EXISTS TO SATISFY, DEMONSTRATED.
 *
 * Every other fixture in this file is a death notice, so the suite asserted the
 * module's institution-agnosticism without ever showing it. Nothing below is an
 * obituary, no column here appears in any shipped template, and the trigger
 * vocabulary is a funding body -- read it as though obituaries had never
 * existed. If anything in `verify.ts` ever learns what a death date is, this is
 * the block that fails.
 */
describe('a journal-article collection, which is not an obituary collection', () => {
  const journalArticle: Profile = {
    version: 1,
    pattern: '{name}.pdf',
    columns: [
      {
        path: 'DC/relation',
        composeOnly: true,
        sources: [
          {
            presence: {
              any: ['Thornfield Trust', 'the Thornfield Foundation', 'Thornfield grant'],
              then: 'Funded by the Thornfield Trust',
            },
          },
        ],
      },
      { path: 'DC/description', sources: [{ section: 'Abstract' }, { ai: true }] },
    ],
  };

  const FUNDED =
    'Sediment transport in the Bracken Valley. Abstract: this paper reports 118 sampling ' +
    'stations across four seasons and runs to 24 pages. The work was supported by the ' +
    'Thornfield Trust.';
  const UNFUNDED =
    'Sediment transport in the Bracken Valley. Abstract: this paper reports 118 sampling ' +
    'stations across four seasons and runs to 24 pages.';

  it('accepts an abstract that reports what the paper reports', () => {
    expect(
      kinds(
        'Reports 118 sampling stations across four seasons, in 24 pages, funded by the Thornfield Trust.',
        FUNDED,
        journalArticle,
      ),
    ).toEqual([]);
  });

  it('refuses a page count the paper does not give', () => {
    expect(kinds('A 240-page study of sediment transport.', FUNDED, journalArticle)).toEqual([
      'number',
    ]);
  });

  it('refuses a funding body the paper never names', () => {
    const claims = unsupportedClaims(
      'A study of sediment transport, funded by the Thornfield Trust.',
      UNFUNDED,
      journalArticle,
    );
    expect(claims.map((c) => c.kind)).toEqual(['assertion']);
    expect(claims[0]!.claim).toBe('Thornfield Trust');
  });

  it('accepts a paraphrase that adds no checkable claim', () => {
    expect(
      kinds('A field study of river sediment, with seasonal sampling.', UNFUNDED, journalArticle),
    ).toEqual([]);
  });
});

/**
 * The document is read ONCE PER DOCUMENT rather than once per cell. Every
 * enabled column on a row was re-deriving every date and number in the whole
 * file -- and `fill.ts` goes to explicit trouble to slice once per row for
 * exactly this reason.
 */
describe('evidence prepared once for a whole row', () => {
  it('answers identically however the document is passed', () => {
    const document = 'Alder Hawthorn died on January 6, 2024, leaving 47 years of work behind him.';
    const evidence = documentEvidence(document);
    for (const generated of [
      'Died 2024-01-06 after 47 years.',
      'Died 2024-01-07 after 48 years.',
      'A bookbinder of Marrowfield.',
    ]) {
      expect(
        unsupportedClaims(generated, evidence, withPresence),
        generated,
      ).toEqual(unsupportedClaims(generated, document, withPresence));
    }
  });

  it('gives the same answer when the same evidence is reused', () => {
    const evidence = documentEvidence('He died in 2024.');
    const first = unsupportedClaims('Died 2024-01-06.', evidence, withoutPresence);
    const second = unsupportedClaims('Died 2024-01-06.', evidence, withoutPresence);
    expect(second).toEqual(first);
  });
});

/**
 * A GUARD ON THE SOURCE FILE ITSELF, and it is not housekeeping.
 *
 * A raw NUL byte in the dedupe separator made git and ripgrep classify
 * `verify.ts` as binary, so every content search over it silently returned
 * nothing -- including the grep offered as evidence that the module names no
 * institution. It happened again during this work, with a no-break space in a
 * regex character class, which is invisible in every editor. The class below
 * covers both: control characters and invisible spaces, but not the ordinary
 * accented prose a comment is entitled to.
 */
describe('the source file stays searchable', () => {
  it('contains no control character and no invisible space', () => {
    const source = readFileSync(new URL('../../src/core/ai/verify.ts', import.meta.url), 'utf8');
    // Built from escapes on purpose: a character class of literal invisible
    // characters is exactly the thing this test exists to forbid.
    const forbidden = new RegExp(
      '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f' +
        '\\u00a0\\u1680\\u2000-\\u200f\\u2028-\\u202f\\u205f\\u2060\\u3000\\ufeff]',
    );
    expect(forbidden.test(source)).toBe(false);
  });
});
