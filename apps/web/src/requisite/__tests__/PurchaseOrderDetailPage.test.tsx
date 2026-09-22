import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PurchaseOrderDetailPage } from '../PurchaseOrderDetailPage';
import { requisiteApi } from '../../api/requisite';

vi.mock('../../api/requisite', () => ({
  requisiteApi: { getPurchaseOrder: vi.fn(), issuePurchaseOrder: vi.fn(), recordGoodsReceipt: vi.fn() },
}));

const ISSUED_PO = {
  id: 'po-1',
  po_number: 'PO-000001',
  status: 'issued',
  supplier_id: 's1',
  currency: 'GBP',
  subtotal_minor: '10000',
  tax_minor: '2000',
  carriage_minor: '0',
  total_minor: '12000',
  order_date: '2026-01-01',
  expected_delivery_date: null,
  version: 1,
  lines: [{ id: 'line-1', description: 'Widgets', quantity_ordered: '100', quantity_received: '60', unit_price_minor: '100', line_total_minor: '10000' }],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/requisite/purchase-orders/po-1']}>
      <Routes>
        <Route path="/requisite/purchase-orders/:id" element={<PurchaseOrderDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PurchaseOrderDetailPage (items 11/12 - goods receipt with over-receipt prevention)', () => {
  beforeEach(() => {
    vi.mocked(requisiteApi.getPurchaseOrder).mockReset().mockResolvedValue(ISSUED_PO as any);
    vi.mocked(requisiteApi.recordGoodsReceipt).mockReset();
  });

  it('OUTSTANDING QUANTITY: defaults Receive Now to the full outstanding amount', async () => {
    renderPage();
    const input = (await screen.findByLabelText('Receive now for Widgets')) as HTMLInputElement;
    expect(input.value).toBe('40'); // 100 ordered - 60 received = 40 outstanding
    expect(input.max).toBe('40'); // UI-level over-receipt guard, backend/DB remain authoritative
  });

  it('shows Ordered/Received/Outstanding per line', async () => {
    renderPage();
    await screen.findByLabelText('Receive now for Widgets');
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('60')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
  });

  it('records a partial receipt and shows a readable error if the backend rejects an attempted over-receipt', async () => {
    vi.mocked(requisiteApi.recordGoodsReceipt).mockRejectedValue(new Error('Cannot receive 999 of "Widgets" - only 40 is outstanding'));
    renderPage();
    const input = await screen.findByLabelText('Receive now for Widgets');
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.click(screen.getByText('Record Goods Receipt'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/only 40 is outstanding/i);
  });

  it('a draft PO shows an "Issue Purchase Order" action instead of receipt recording', async () => {
    vi.mocked(requisiteApi.getPurchaseOrder).mockResolvedValue({ ...ISSUED_PO, status: 'draft', lines: [] } as any);
    renderPage();
    expect(await screen.findByText('Issue Purchase Order')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Receive now/)).not.toBeInTheDocument();
  });
});
