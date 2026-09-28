import { render } from 'preact';
import { App } from './App';
import { requestPersistence } from './lib/db';
import { loadAll } from './lib/store';
import './styles.css';

render(<App />, document.getElementById('app')!);
void loadAll();
void requestPersistence();

// Service worker (offline support) — only in production builds.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })).catch(() => {});
}
