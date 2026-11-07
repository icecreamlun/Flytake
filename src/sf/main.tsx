/**
 * Entry for /?loc=sf (code-split from src/main.tsx so the Emerald Bay page never loads argus).
 * San Francisco around the Ferry Building, rendered by argus's own engine and flown with
 * Flytake's drone (SfApp). ?time=<hours> sets the initial time of day (PST, as on Emerald Bay).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installSfDebugHooks } from './debug';
import { SfApp } from './SfApp';

installSfDebugHooks();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SfApp />
  </StrictMode>,
);
