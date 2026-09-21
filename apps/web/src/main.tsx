import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { MfaChallengePage } from './pages/MfaChallengePage';
import { BootstrapWizardPage } from './pages/BootstrapWizardPage';
import { AuthenticatedShell } from './pages/AuthenticatedShell';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<BootstrapWizardPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/mfa" element={<MfaChallengePage />} />
        <Route path="/" element={<AuthenticatedShell />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
