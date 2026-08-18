/**
 * A DOM stand-in just large enough to run this app's renderers.
 *
 * This project deliberately has no jsdom, so screens have historically been
 * asserted as the markup string a pure function returns (screens/setup.ts's
 * `setupMarkup`, choose.ts's `chooseCollectionSection`). That works for what a
 * screen SAYS and cannot touch what a screen DOES -- which control is wired to
 * which handler -- and "the link goes to the destructive route" is exactly the
 * mistake a markup assertion cannot see.
 *
 * So this models the four things the renderers actually use: `innerHTML`,
 * `querySelector`, `addEventListener`, and the handful of element properties
 * read inside a listener. Nothing here is a general-purpose DOM; a selector is
 * matched against the markup by id or class rather than parsed, which is the
 * same shortcut `progressScreen.test.ts`'s fakeRoot already takes.
 */

type Listener = (event: unknown) => void;

export class FakeElement {
  private html = '';
  /**
   * One stub per occurrence of a selector, discarded whenever `innerHTML` is
   * replaced -- the real DOM destroys and recreates every child on that
   * assignment, and a listener left over from the previous render would make a
   * stale control look live.
   */
  private groups = new Map<string, FakeElement[]>();

  className = '';
  /**
   * `data-*` attributes, which Review reads inside its own listeners
   * (`select.dataset['header']`). Empty here: nothing in these tests drives a
   * per-column override, and a fake that invented one would be asserting
   * against itself.
   */
  dataset: Record<string, string> = {};
  textContent = '';
  value = '';
  checked = false;
  selectionStart: number | null = null;
  style: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  readonly attributes = new Map<string, string>();
  ownerDocument: { activeElement: FakeElement | null } = { activeElement: null };

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(next: string) {
    this.html = next;
    this.groups.clear();
  }

  addEventListener(type: string, fn: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(fn);
    this.listeners.set(type, existing);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...nodes: FakeElement[]): void {
    // Enough for renderBanner, the one renderer that builds nodes instead of
    // markup: the appended text is what a test needs to read back.
    for (const node of nodes) this.html += node.textContent;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  /**
   * ALWAYS NULL. There is no tree here -- `querySelectorAll` hands out
   * unparented stubs -- so an element has no ancestors to walk to.
   *
   * Present so that a listener which reads its row (`el.closest('tr')`, as the
   * columns screen does to recover a column's path) can be fired at all;
   * without it the listener throws and the behaviour behind it is untestable.
   * A test driven this way can assert WHAT a control reported, never WHICH row
   * reported it, and should say so rather than asserting the empty string that
   * falls out of here.
   */
  closest(_selector: string): FakeElement | null {
    return null;
  }

  setSelectionRange(start: number, _end: number): void {
    this.selectionStart = start;
  }

  /**
   * The FIRST match -- which is the same element `querySelectorAll` puts at
   * index 0, not a different one.
   *
   * This used to keep its own cache, so the two methods handed out different
   * objects for the same selector. A listener wired through one path was then
   * invisible through the other: a renderer that used `querySelectorAll` to
   * wire a repeated control would leave `fire()` reporting "no click listener"
   * on a control that plainly had one, and the failure would look like a bug
   * in the screen rather than in this helper. Delegating removes the class
   * rather than special-casing `fire()`.
   *
   * `present()` and `occurrences()` share `token()`, so "matches at all" and
   * "matches at least once" cannot disagree, and the null case is unchanged.
   */
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /**
   * Every match for a selector, as Review, Confirm and the extract screens ask
   * for when they wire a repeated control.
   *
   * ONE STUB PER OCCURRENCE, counted in the markup, rather than an empty array:
   * a fake that answered "no matches" to a selector the markup really does
   * carry would let a renderer stop wiring a whole group of controls with every
   * test still green.
   *
   * This is now the single source of stubs -- `querySelector` returns element
   * zero of whatever this produces, so a listener wired through either method
   * is visible through both.
   */
  querySelectorAll(selector: string): FakeElement[] {
    const existing = this.groups.get(selector);
    if (existing) return existing;
    const els = Array.from({ length: occurrences(this.html, selector) }, () => {
      const el = new FakeElement();
      el.ownerDocument = this.ownerDocument;
      return el;
    });
    this.groups.set(selector, els);
    return els;
  }

  /** Fire an event at a rendered control, as a click or change would. */
  fire(selector: string, type = 'click', event: Record<string, unknown> = {}): void {
    const el = this.querySelector(selector);
    if (el === null) throw new Error(`nothing rendered matches ${selector}`);
    const listeners = el.listeners.get(type) ?? [];
    if (listeners.length === 0) throw new Error(`${selector} has no ${type} listener`);
    for (const fn of listeners) fn({ target: el, preventDefault: () => {}, ...event });
  }

  /** Whether the current markup contains a control at all. */
  has(selector: string): boolean {
    return present(this.html, selector);
  }
}

/**
 * Selector matching, by id or by class name against the raw markup. Not a
 * parser: `#save` looks for `id="save"`, and anything else for the bare class
 * name, which is all these renderers ever ask for (`.progress-bar__fill`,
 * `p.error`).
 */
function present(html: string, selector: string): boolean {
  return html.includes(token(selector));
}

/** The literal substring a selector is matched by. See `present`. */
function token(selector: string): string {
  if (selector.startsWith('#')) return `id="${selector.slice(1)}"`;
  // An attribute selector (`input[name^="dup-"]`) is matched on its attribute
  // value, which is the part that actually appears in the markup.
  const attr = /\[[a-z-]+[~^|*$]?="([^"]+)"\]/i.exec(selector);
  if (attr?.[1] !== undefined) return attr[1];
  return selector.replace(/^[a-z]*\./i, '');
}

function occurrences(html: string, selector: string): number {
  return html.split(token(selector)).length - 1;
}

export interface FakeDom {
  document: { getElementById(id: string): FakeElement | null; createElement(): FakeElement };
  /** The elements index.html provides, which the app requires by id. */
  elements: Map<string, FakeElement>;
  app: FakeElement;
  banner: FakeElement;
}

export function fakeDom(ids: string[] = ['app', 'banner']): FakeDom {
  const elements = new Map<string, FakeElement>();
  for (const id of ids) elements.set(id, new FakeElement());
  return {
    elements,
    app: elements.get('app')!,
    banner: elements.get('banner')!,
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => new FakeElement(),
    },
  };
}
