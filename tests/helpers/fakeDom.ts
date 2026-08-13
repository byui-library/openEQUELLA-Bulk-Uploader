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

  className = '';
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
  if (selector.startsWith('#')) return html.includes(`id="${selector.slice(1)}"`);
  return html.includes(selector.replace(/^[a-z]*\./i, ''));
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
