import React from 'react';
import { PageHeader, EmptyState } from '@hexyrn/design-system';

/**
 * Reports (item 15) - honest placeholder. The backend registers real
 * Requisite report datasets/templates through Core's P2 reporting
 * infrastructure (requisite-p2-extensions.ts), but no HTTP route yet
 * exposes Core's saved-report/dataset listing to this frontend, so this
 * screen cannot yet render real report results. Not fabricated.
 */
export function ReportsPage() {
  return (
    <div>
      <PageHeader title="Reports" />
      <EmptyState message="Report viewing is not yet available in this release - the underlying datasets (Purchasing by Supplier, Open Purchase Orders, etc.) are registered on the backend, but no screen renders them yet." />
    </div>
  );
}
