import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge, Money, PageHeader, EmptyState } from '@hexyrn/design-system';

describe('design-system primitives (frontend test infra sanity check)', () => {
  it('StatusBadge renders its label text (never colour-only status)', () => {
    render(<StatusBadge label="Awaiting Approval" tone="warning" />);
    expect(screen.getByText('Awaiting Approval')).toBeInTheDocument();
  });

  it('Money formats minor units as a readable currency string, display-only', () => {
    render(<Money minorUnits="123456" currency="GBP" />);
    expect(screen.getByText('£1,234.56')).toBeInTheDocument();
  });

  it('PageHeader renders title and action', () => {
    render(<PageHeader title="Requisitions" actions={<button>New Requisition</button>} />);
    expect(screen.getByText('Requisitions')).toBeInTheDocument();
    expect(screen.getByText('New Requisition')).toBeInTheDocument();
  });

  it('EmptyState renders message and action', () => {
    render(<EmptyState message="Nothing requested yet." action={<button>Create requisition</button>} />);
    expect(screen.getByText('Nothing requested yet.')).toBeInTheDocument();
    expect(screen.getByText('Create requisition')).toBeInTheDocument();
  });
});
