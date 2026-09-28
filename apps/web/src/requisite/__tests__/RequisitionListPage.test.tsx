import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RequisitionListPage } from '../RequisitionListPage';
import { requisiteApi } from '../../api/requisite';

vi.mock('../../api/requisite', () => ({
  requisiteApi: { listRequisitions: vi.fn() },
}));

const SAMPLE = [
  {
    id: 'r1',
    requisition_number: 'REQ-000001',
    status: 'draft',
    reason: 'Office chairs',
    estimated_value_minor: '10000',
    currency: 'GBP',
    created_at: '2026-01-01T00:00:00Z',
    lines: [],
  },
  {
    id: 'r2',
    requisition_number: 'REQ-000002',
    status: 'awaiting_approval',
    reason: 'Site signage',
    estimated_value_minor: '25000',
    currency: 'GBP',
    created_at: '2026-01-02T00:00:00Z',
    lines: [],
  },
] as any;

describe('RequisitionListPage (item 5)', () => {
  beforeEach(() => {
    vi.mocked(requisiteApi.listRequisitions).mockReset();
  });

  it('EMPTY STATE: shows an intentional empty state with a call to action when there are no requisitions', async () => {
    vi.mocked(requisiteApi.listRequisitions).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <RequisitionListPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Nothing requested yet.')).toBeInTheDocument();
    expect(screen.getByText('Create your first requisition')).toBeInTheDocument();
  });

  it('lists requisitions with a human-readable status label, never the raw backend value', async () => {
    vi.mocked(requisiteApi.listRequisitions).mockResolvedValue(SAMPLE);
    render(
      <MemoryRouter>
        <RequisitionListPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('REQ-000001')).toBeInTheDocument();
    expect(screen.getByText('Awaiting Approval', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByText('awaiting_approval')).not.toBeInTheDocument();
  });

  it('SEARCH/FILTER: filtering by status narrows the list', async () => {
    vi.mocked(requisiteApi.listRequisitions).mockResolvedValue(SAMPLE);
    render(
      <MemoryRouter>
        <RequisitionListPage />
      </MemoryRouter>,
    );
    await screen.findByText('REQ-000001');
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'draft' } });
    expect(screen.getByText('REQ-000001')).toBeInTheDocument();
    expect(screen.queryByText('REQ-000002')).not.toBeInTheDocument();
  });

  it('SEARCH: text search matches requisition number or purpose', async () => {
    vi.mocked(requisiteApi.listRequisitions).mockResolvedValue(SAMPLE);
    render(
      <MemoryRouter>
        <RequisitionListPage />
      </MemoryRouter>,
    );
    await screen.findByText('REQ-000001');
    fireEvent.change(screen.getByLabelText('Search requisitions'), {
      target: { value: 'signage' },
    });
    await waitFor(() => expect(screen.queryByText('REQ-000001')).not.toBeInTheDocument());
    expect(screen.getByText('REQ-000002')).toBeInTheDocument();
  });

  it('ERROR STATE: shows a readable error, not a raw exception, on load failure', async () => {
    vi.mocked(requisiteApi.listRequisitions).mockRejectedValue(new Error('Network error'));
    render(
      <MemoryRouter>
        <RequisitionListPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
  });
});
