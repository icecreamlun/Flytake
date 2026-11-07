import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installDebugHooks } from './debug';
import './ui/styles.css';

// /?loc=sf flies San Francisco instead (its own engine, loaded on demand so this page never
// pulls in the argus city code).
if (new URLSearchParams(location.search).get('loc') === 'sf') {
  void import('./sf/main');
} else {
  installDebugHooks();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
