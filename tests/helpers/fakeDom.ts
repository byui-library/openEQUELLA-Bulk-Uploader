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
   * One stub per selector, discarded whenever `innerHTML` is replaced -- the
   * real DOM destroys and recreates every child on that assignment, and a
   * listener left over from the previous render would make a stale control
   * look live.
   */
  private children = new Map<string, FakeElement>();
  /** As `children`, for the group `querySelectorAll` returns. Cleared with it. */
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
    this.children.clear();
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

  setSelectionRange(start: number, _end: number): void {
    this.selectionStart = start;
  }

  querySelector(selector: string): FakeElement | null {
    if (!present(this.html, selector)) return null;
    const existing = this.children.get(selector);
    if (existing) return existing;
    const el = new FakeElement();
    el.ownerDocument = this.ownerDocument;
    this.children.set(selector, el);
    return el;
  }

  /**
   * Every match for a selector, as Review, Confirm and the extract screens ask
   * for when they wire a repeated control.
   *
   * ONE STUB PER OCCURRENCE, counted in the markup, rather than an empty array:
   * a fake that answered "no matches" to a selector the markup really does
   * carry would let a renderer stop wiring a whole group of controls with every
   * test still green. Nothing here fires one -- the group exists so the
   * renderers run at all.
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
