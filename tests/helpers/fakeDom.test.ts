import { describe, it, expect } from 'vitest';
import { FakeElement } from './fakeDom.js';

/**
 * The test harness needs testing, because a fault in it is worse than a fault
 * in a test: it does not fail, it lies about the code under test. This one had
 * exactly that shape -- `querySelector` and `querySelectorAll` kept separate
 * caches, so the same selector produced different objects depending on which
 * method a renderer happened to call. A listener wired through one was
 * invisible through the other, and `fire()` would report "no click listener"
 * on a control that plainly had one. The failure would have been read as a bug
 * in the screen.
 */
describe('FakeElement selector identity', () => {
  const root = () => {
    const el = new FakeElement();
    el.innerHTML = '<button id="save">Save</button><button class="row-btn"></button><button class="row-btn"></button>';
    return el;
  };

  it('gives querySelector the same object querySelectorAll puts first', () => {
    const el = root();
    expect(el.querySelector('#save')).toBe(el.querySelectorAll('#save')[0]);
  });

  /** The case the two caches broke: wired one way, fired the other. */
  it('fires a listener that was wired through querySelectorAll', () => {
    const el = root();
    let clicked = 0;
    for (const b of el.querySelectorAll('.row-btn')) b.addEventListener('click', () => (clicked += 1));
    el.fire('.row-btn');
    expect(clicked).toBe(1);
  });

  it('fires a listener that was wired through querySelector', () => {
    const el = root();
    let clicked = 0;
    el.querySelector('#save')?.addEventListener('click', () => (clicked += 1));
    el.fire('#save');
    expect(clicked).toBe(1);
  });

  it('still counts every occurrence, so a group is not silently one element', () => {
    expect(root().querySelectorAll('.row-btn')).toHaveLength(2);
  });

  it('still answers null for a selector the markup does not carry', () => {
    expect(root().querySelector('#absent')).toBeNull();
  });

  /**
   * Replacing innerHTML destroys and recreates children in a real DOM. A stub
   * surviving that would carry a listener from the previous render, making a
   * stale control look live -- which is the same class of lie as above.
   */
  it('discards stubs when the markup is replaced', () => {
    const el = root();
    const before = el.querySelector('#save');
    el.innerHTML = '<button id="save">Save</button>';
    expect(el.querySelector('#save')).not.toBe(before);
  });
});
