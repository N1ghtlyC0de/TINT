import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { auth } from './lib/firebase';
import { startHostSession } from './lib/authSession';
import './index.css';

// Una sola vez al arrancar: mantiene fresco el ID token del host (caduca a la hora).
startHostSession(auth);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
