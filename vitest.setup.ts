/**
 * Shared test setup.
 * - Under jsdom: stub browser APIs jsdom lacks (matchMedia, ResizeObserver).
 * - Under node: everything is a guarded no-op.
 * - Marks the environment as React-act for @testing-library/react.
 */

if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;

  if (!w.matchMedia) {
    w.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }

  if (!w.ResizeObserver) {
    w.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export {};
