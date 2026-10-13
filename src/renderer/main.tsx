import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { useKinetix } from './store';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

void useKinetix.getState().boot();
