import React from 'react';
import { PageHeader, EmptyState } from '@hexyrn/design-system';

/**
 * Quotes/RFQs (item 9) - list/comparison/recording UI. NOTE: no backend
 * HTTP routes exist yet for RfqService (only the service layer was built
 * in the backend phase) - this screen is a real, honest placeholder
 * wired into navigation, not a fabricated feature. See
 * docs/decisions/REQUISITE-V1-DEVIATIONS.md.
 */
export function RfqListPage() {
  return (
    <div>
      <PageHeader title="Quotes/RFQs" />
      <EmptyState message="Quote/RFQ management is not yet available in this release - the underlying comparison and selection logic exists on the backend, but its screens are not yet built." />
    </div>
  );
}
