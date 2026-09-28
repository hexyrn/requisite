import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RfqDetailPage } from '../RfqDetailPage';
import { requisiteApi } from '../../api/requisite';

vi.mock('../../api/requisite', () => ({
  requisiteApi: {
    getRfq: vi.fn(),
    listSuppliers: vi.fn(),
    recordQuote: vi.fn(),
    selectQuote: vi.fn(),
    rejectQuote: vi.fn(),
  },
}));

const RFQ_WITH_TWO_QUOTES = {
  id: 'rfq-1',
  rfq_number: 'RFQ-000001',
  status: 'open',
  requisition_id: null,
  created_at: '2026-01-01T00:00:00Z',
  quotes: [
    {
      id: 'q-cheap',
      rfq_id: 'rfq-1',
      supplier_id: 's1',
      supplier_name: 'Cheap Co',
      quote_reference: null,
      quote_date: null,
      expiry_date: null,
      currency: 'GBP',
      carriage_minor: '0',
      total_minor: '5000',
      status: 'received',
      selection_reason: null,
      notes: null,
    },
    {
      id: 'q-expensive',
      rfq_id: 'rfq-1',
      supplier_id: 's2',
      supplier_name: 'Premium Co',
      quote_reference: null,
      quote_date: null,
      expiry_date: null,
      currency: 'GBP',
      carriage_minor: '0',
      total_minor: '10000',
      status: 'received',
      selection_reason: null,
      notes: null,
    },
  ],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/requisite/rfqs/rfq-1']}>
      <Routes>
        <Route path="/requisite/rfqs/:id" element={<RfqDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RfqDetailPage (item 9 - comparison never auto-selects)', () => {
  beforeEach(() => {
    vi.mocked(requisiteApi.getRfq)
      .mockReset()
      .mockResolvedValue(RFQ_WITH_TWO_QUOTES as any);
    vi.mocked(requisiteApi.listSuppliers)
      .mockReset()
      .mockResolvedValue([
        { id: 's1', name: 'Cheap Co' },
        { id: 's2', name: 'Premium Co' },
      ] as any);
    vi.mocked(requisiteApi.selectQuote).mockReset();
  });

  it('shows both quotes side by side for human comparison, with Select/Reject actions on each - never an auto-recommendation', async () => {
    renderPage();
    await screen.findByLabelText('Select quote from Cheap Co');
    expect(screen.getAllByText('Cheap Co').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Premium Co').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByLabelText(/Select quote from/)).toHaveLength(2);
    // No "recommended" / "best value" auto-highlighting text anywhere.
    expect(screen.queryByText(/recommend/i)).not.toBeInTheDocument();
  });

  it('selecting a quote is an explicit human action that calls selectQuote with the chosen quote id', async () => {
    vi.mocked(requisiteApi.selectQuote).mockResolvedValue({} as any);
    renderPage();
    await screen.findByLabelText('Select quote from Cheap Co');
    fireEvent.click(screen.getByLabelText('Select quote from Cheap Co'));
    await waitFor(() =>
      expect(requisiteApi.selectQuote).toHaveBeenCalledWith('rfq-1', 'q-cheap', undefined),
    );
  });
});
