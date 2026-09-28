import { request, uploadFile } from './client';

export interface Supplier {
  id: string;
  supplier_number: string;
  name: string;
  status: string;
  email: string | null;
  phone: string | null;
  payment_terms: string | null;
  default_currency: string;
}

export interface RequisitionLine {
  id: string;
  line_number: number;
  description: string;
  quantity: string;
  unit: string | null;
  estimated_unit_price_minor: string;
  estimated_total_minor: string;
  category: string | null;
}

export interface Requisition {
  id: string;
  requisition_number: string;
  status: string;
  reason: string | null;
  category: string | null;
  currency: string;
  estimated_value_minor: string;
  required_by_date: string | null;
  cost_object_reference: string | null;
  requester_user_account_id: string;
  version: number;
  created_at: string;
  lines: RequisitionLine[];
}

export interface RequisitionLineInput {
  description: string;
  quantity: string;
  unit?: string;
  estimatedUnitPriceMinor: string;
  category?: string;
}

export interface PurchaseOrder {
  id: string;
  po_number: string;
  status: string;
  supplier_id: string;
  currency: string;
  subtotal_minor: string;
  tax_minor: string;
  carriage_minor: string;
  total_minor: string;
  order_date: string;
  expected_delivery_date: string | null;
  version: number;
  lines: Array<{
    id: string;
    description: string;
    quantity_ordered: string;
    quantity_received: string;
    unit_price_minor: string;
    line_total_minor: string;
  }>;
}

export interface GoodsReceipt {
  id: string;
  grn_number: string;
  purchase_order_id: string;
  received_at: string;
  delivery_note_reference: string | null;
  lines: Array<{ id: string; purchase_order_line_id: string; quantity_received: string }>;
}

export interface ApprovalHistoryEntry {
  id: string;
  status: string;
  steps: Array<{
    id: string;
    status: string;
    decisions: Array<{
      decided_by: string;
      decision: string;
      comment: string | null;
      decided_at: string;
    }>;
  }>;
}

export interface Rfq {
  id: string;
  rfq_number: string;
  status: string;
  requisition_id: string | null;
  created_at: string;
}

export interface Quote {
  id: string;
  rfq_id: string;
  supplier_id: string;
  supplier_name: string;
  quote_reference: string | null;
  quote_date: string | null;
  expiry_date: string | null;
  currency: string;
  carriage_minor: string;
  total_minor: string;
  status: string;
  selection_reason: string | null;
  notes: string | null;
}

export interface RfqDetail extends Rfq {
  quotes: Quote[];
}

export interface QuoteLineInput {
  description: string;
  quantity: string;
  unitPriceMinor: string;
}

export const requisiteApi = {
  listSuppliers: () => request<Supplier[]>('/requisite/suppliers'),
  createSupplier: (input: { name: string; email?: string; phone?: string }) =>
    request<Supplier>('/requisite/suppliers', { method: 'POST', body: JSON.stringify(input) }),

  listRequisitions: () => request<Requisition[]>('/requisite/requisitions'),
  getRequisition: (id: string) => request<Requisition>(`/requisite/requisitions/${id}`),
  createRequisition: (input: {
    reason: string;
    category?: string;
    requiredByDate?: string;
    costObjectReference?: string;
    lines: RequisitionLineInput[];
  }) =>
    request<Requisition>('/requisite/requisitions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  submitRequisition: (id: string, version: number) =>
    request<{ requisition: Requisition; approval: { requestId: string; status: string } }>(
      `/requisite/requisitions/${id}/submit`,
      { method: 'POST', body: JSON.stringify({ version }) },
    ),
  decideRequisition: (
    id: string,
    stepId: string,
    decision: 'approve' | 'reject',
    reason?: string,
  ) =>
    request<{ requestStatus: string; stepStatus: string }>(
      `/requisite/requisitions/${id}/decisions`,
      { method: 'POST', body: JSON.stringify({ stepId, decision, reason }) },
    ),
  cancelRequisition: (id: string) =>
    request<Requisition>(`/requisite/requisitions/${id}/cancel`, { method: 'POST' }),
  getApprovalHistory: (id: string) =>
    request<ApprovalHistoryEntry[]>(`/requisite/requisitions/${id}/approval-history`),
  listAttachments: (id: string) =>
    request<
      Array<{ id: string; original_filename: string; mime_type: string; size_bytes: string }>
    >(`/requisite/requisitions/${id}/attachments`),
  attachFile: (id: string, file: File) =>
    uploadFile(`/requisite/requisitions/${id}/attachments`, file),

  generatePurchaseOrder: (
    requisitionId: string,
    input: {
      supplierId: string;
      lines: Array<{ description: string; quantityOrdered: string; unitPriceMinor: string }>;
    },
  ) =>
    request<PurchaseOrder>(`/requisite/requisitions/${requisitionId}/purchase-orders`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listPurchaseOrders: () => request<PurchaseOrder[]>('/requisite/purchase-orders'),
  getPurchaseOrder: (id: string) => request<PurchaseOrder>(`/requisite/purchase-orders/${id}`),
  issuePurchaseOrder: (id: string, version: number) =>
    request<PurchaseOrder>(`/requisite/purchase-orders/${id}/issue`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    }),

  getGoodsReceipt: (id: string) => request<GoodsReceipt>(`/requisite/goods-receipts/${id}`),
  listGoodsReceiptsForPo: (purchaseOrderId: string) =>
    request<GoodsReceipt[]>(`/requisite/purchase-orders/${purchaseOrderId}/goods-receipts`),
  recordGoodsReceipt: (
    purchaseOrderId: string,
    input: {
      lines: Array<{ purchaseOrderLineId: string; quantityReceived: string }>;
      deliveryNoteReference?: string;
    },
  ) =>
    request<GoodsReceipt>(`/requisite/purchase-orders/${purchaseOrderId}/goods-receipts`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listRfqs: () => request<Rfq[]>('/requisite/rfqs'),
  getRfq: (id: string) => request<RfqDetail>(`/requisite/rfqs/${id}`),
  createRfq: () => request<Rfq>('/requisite/rfqs', { method: 'POST', body: JSON.stringify({}) }),
  recordQuote: (
    rfqId: string,
    input: {
      supplierId: string;
      quoteReference?: string;
      expiryDate?: string;
      carriageMinor?: string;
      lines: QuoteLineInput[];
    },
  ) =>
    request<Quote>(`/requisite/rfqs/${rfqId}/quotes`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  selectQuote: (rfqId: string, quoteId: string, reason?: string) =>
    request<Quote>(`/requisite/rfqs/${rfqId}/quotes/${quoteId}/select`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  rejectQuote: (rfqId: string, quoteId: string) =>
    request<Quote>(`/requisite/rfqs/${rfqId}/quotes/${quoteId}/reject`, { method: 'POST' }),
};
