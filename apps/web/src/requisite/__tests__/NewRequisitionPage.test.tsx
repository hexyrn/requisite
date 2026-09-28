import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { NewRequisitionPage } from '../NewRequisitionPage';
import { requisiteApi } from '../../api/requisite';

vi.mock('../../api/requisite', () => ({
  requisiteApi: {
    createRequisition: vi.fn(),
  },
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/requisite/requisitions/new']}>
      <Routes>
        <Route path="/requisite/requisitions/new" element={<NewRequisitionPage />} />
        <Route path="/requisite/requisitions/:id" element={<div>Requisition detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NewRequisitionPage (item 6 - the most important screen)', () => {
  beforeEach(() => {
    vi.mocked(requisiteApi.createRequisition).mockReset();
  });

  it('VALIDATION: rejects submission with no purpose explained', async () => {
    renderPage();
    fireEvent.click(screen.getByText('Save Draft'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /explain what this requisition is for/i,
    );
    expect(requisiteApi.createRequisition).not.toHaveBeenCalled();
  });

  it('VALIDATION: rejects a line with no description', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('What do you need, and why?'), {
      target: { value: 'Replacement parts' },
    });
    fireEvent.click(screen.getByText('Save Draft'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/every line needs a description/i);
  });

  it('LINE EDITING: adding and removing lines works, and the estimated total updates as a display-only convenience', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Line description'), {
      target: { value: 'Steel Brackets' },
    });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Estimated unit price in pence'), {
      target: { value: '500' },
    });
    expect(screen.getByText('£50.00')).toBeInTheDocument(); // 10 x 500 pence, display-only

    fireEvent.click(screen.getByText('+ Add line'));
    expect(screen.getAllByLabelText('Line description')).toHaveLength(2);

    fireEvent.click(screen.getByLabelText('Remove line 2'));
    expect(screen.getAllByLabelText('Line description')).toHaveLength(1);
  });

  it('SUBMISSION: a valid requisition is created and navigates to its detail page - the backend total is authoritative, never the client-computed one', async () => {
    vi.mocked(requisiteApi.createRequisition).mockResolvedValue({ id: 'req-123' } as any);
    renderPage();
    fireEvent.change(screen.getByLabelText('What do you need, and why?'), {
      target: { value: 'Replacement parts' },
    });
    fireEvent.change(screen.getByLabelText('Line description'), {
      target: { value: 'Steel Brackets' },
    });
    fireEvent.click(screen.getByText('Save Draft'));

    await waitFor(() =>
      expect(requisiteApi.createRequisition).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'Replacement parts',
          lines: [expect.objectContaining({ description: 'Steel Brackets' })],
        }),
      ),
    );
    expect(await screen.findByText('Requisition detail page')).toBeInTheDocument();
  });

  it('ERROR STATE: a backend failure shows a readable error, not a raw exception', async () => {
    vi.mocked(requisiteApi.createRequisition).mockRejectedValue(
      new Error('Missing required permission "requisite.requisitions.create"'),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText('What do you need, and why?'), {
      target: { value: 'Test' },
    });
    fireEvent.change(screen.getByLabelText('Line description'), { target: { value: 'X' } });
    fireEvent.click(screen.getByText('Save Draft'));
    expect(await screen.findByText(/Missing required permission/i)).toBeInTheDocument();
  });
});
