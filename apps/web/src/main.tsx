import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { MfaChallengePage } from './pages/MfaChallengePage';
import { BootstrapWizardPage } from './pages/BootstrapWizardPage';
import { AuthenticatedShell } from './pages/AuthenticatedShell';
import { RequisiteLayout } from './requisite/RequisiteLayout';
import { RequisiteHome } from './requisite/RequisiteHome';
import { RequisitionListPage } from './requisite/RequisitionListPage';
import { NewRequisitionPage } from './requisite/NewRequisitionPage';
import { RequisitionDetailPage } from './requisite/RequisitionDetailPage';
import { PurchaseOrderListPage } from './requisite/PurchaseOrderListPage';
import { PurchaseOrderDetailPage } from './requisite/PurchaseOrderDetailPage';
import { SupplierListPage } from './requisite/SupplierListPage';
import { GoodsReceiptListPage } from './requisite/GoodsReceiptListPage';
import { RfqListPage } from './requisite/RfqListPage';
import { ReportsPage } from './requisite/ReportsPage';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<BootstrapWizardPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/mfa" element={<MfaChallengePage />} />
        <Route path="/" element={<AuthenticatedShell />}>
          <Route path="requisite" element={<RequisiteLayout />}>
            <Route index element={<RequisiteHome />} />
            <Route path="requisitions" element={<RequisitionListPage />} />
            <Route path="requisitions/new" element={<NewRequisitionPage />} />
            <Route path="requisitions/:id" element={<RequisitionDetailPage />} />
            <Route path="purchase-orders" element={<PurchaseOrderListPage />} />
            <Route path="purchase-orders/:id" element={<PurchaseOrderDetailPage />} />
            <Route path="suppliers" element={<SupplierListPage />} />
            <Route path="goods-receipts" element={<GoodsReceiptListPage />} />
            <Route path="rfqs" element={<RfqListPage />} />
            <Route path="reports" element={<ReportsPage />} />
          </Route>
          <Route index element={<Navigate to="/requisite" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
