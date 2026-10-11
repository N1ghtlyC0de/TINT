import '@testing-library/jest-dom/vitest';

interface GlobalWithJsdom {
  jsdom?: {
    window?: {
      localStorage?: Storage;
      sessionStorage?: Storage;
    };
  };
}

// In Node.js 22+, `globalThis.localStorage` exists as an experimental built-in property.
// Because it already exists on `globalThis`, Vitest's jsdom environment skips copying
// `window.localStorage` from JSDOM over to `globalThis`, leaving `globalThis.localStorage`
// (and consequently `window.localStorage`) evaluating to `undefined` unless explicitly assigned.
const jsdomGlobal = globalThis as unknown as GlobalWithJsdom;

if (jsdomGlobal.jsdom?.window) {
  const { localStorage: jsdomLocalStorage, sessionStorage: jsdomSessionStorage } = jsdomGlobal.jsdom.window;
  if (jsdomLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: jsdomLocalStorage,
      configurable: true,
      writable: true,
    });
  }
  if (jsdomSessionStorage) {
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: jsdomSessionStorage,
      configurable: true,
      writable: true,
    });
  }
}
