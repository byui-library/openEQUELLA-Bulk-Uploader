declare global {
  interface Window {
    oeq: { ping: () => string };
  }
}

const el = document.getElementById('status');
if (el) el.textContent = window.oeq.ping();

export {};
