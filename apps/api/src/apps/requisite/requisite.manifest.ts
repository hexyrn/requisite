import { HexyrnAppManifest } from '@hexyrn/app-sdk';
import { ApplicationRegistryService } from '../../platform/app-registry/application-registry.service';

/**
 * com.hexyrn.requisite - Hexyrn's first real commercial application,
 * Requisite v1 (procurement/purchasing). Built entirely through the
 * supported App SDK against Core P0-P2, exactly the "no second
 * substitute mechanism" rule the reference app demonstrated in P1/P2 -
 * see docs/decisions/REQUISITE-V1-DEVIATIONS.md for the running record of
 * places this build genuinely tested Core's limits.
 */
export const REQUISITE_APP_MANIFEST: HexyrnAppManifest = {
  appId: 'com.hexyrn.requisite',
  displayName: 'Hexyrn Requisite',
  version: '1.0.0',
  majorVersion: 1,
  requiresCoreVersion: '^0.1.0',
  description:
    'Purchasing and procurement control: requisitions, approvals, purchase orders, and goods receipt.',
  brand: { color: '#0f766e', icon: 'cart' },

  roleTemplates: [
    {
      name: 'Requisite - Requester',
      permissions: [
        'requisite.suppliers.view',
        'requisite.requisitions.view',
        'requisite.requisitions.create',
        'requisite.requisitions.edit',
        'requisite.requisitions.submit',
        'requisite.requisitions.cancel',
        'requisite.purchase-orders.view',
      ],
    },
    {
      name: 'Requisite - Approver',
      permissions: [
        'requisite.requisitions.view',
        'requisite.requisitions.approve',
        'requisite.purchase-orders.view',
        'requisite.reports.view',
      ],
    },
    {
      name: 'Requisite - Buyer',
      permissions: [
        'requisite.suppliers.view',
        'requisite.suppliers.manage',
        'requisite.requisitions.view',
        'requisite.purchase-orders.view',
        'requisite.purchase-orders.create',
        'requisite.purchase-orders.issue',
        'requisite.goods-receipts.view',
        'requisite.goods-receipts.create',
        'requisite.rfqs.manage',
        'requisite.reports.view',
      ],
    },
  ],
  permissions: [
    { key: 'requisite.suppliers.view', label: 'View suppliers' },
    { key: 'requisite.suppliers.manage', label: 'Create/edit/deactivate suppliers' },
    { key: 'requisite.requisitions.view', label: 'View requisitions' },
    { key: 'requisite.requisitions.create', label: 'Create requisitions' },
    { key: 'requisite.requisitions.edit', label: 'Edit requisitions' },
    { key: 'requisite.requisitions.submit', label: 'Submit requisitions for approval' },
    { key: 'requisite.requisitions.approve', label: 'Approve/reject requisitions' },
    { key: 'requisite.requisitions.cancel', label: 'Cancel requisitions' },
    { key: 'requisite.purchase-orders.view', label: 'View purchase orders' },
    { key: 'requisite.purchase-orders.create', label: 'Generate purchase orders' },
    { key: 'requisite.purchase-orders.issue', label: 'Issue purchase orders to suppliers' },
    { key: 'requisite.goods-receipts.view', label: 'View goods receipts' },
    { key: 'requisite.goods-receipts.create', label: 'Record goods receipts' },
    { key: 'requisite.rfqs.manage', label: 'Manage RFQs and quotations' },
    { key: 'requisite.reports.view', label: 'View purchasing reports' },
  ],

  navigation: [
    {
      key: 'requisite-home',
      label: 'Home',
      path: '/requisite',
      permission: 'requisite.requisitions.view',
      order: 900,
    },
    {
      key: 'requisite-requisitions',
      label: 'Requisitions',
      path: '/requisite/requisitions',
      permission: 'requisite.requisitions.view',
      order: 901,
    },
    {
      key: 'requisite-purchase-orders',
      label: 'Purchase Orders',
      path: '/requisite/purchase-orders',
      permission: 'requisite.purchase-orders.view',
      order: 902,
    },
    {
      key: 'requisite-goods-receipts',
      label: 'Goods Receipts',
      path: '/requisite/goods-receipts',
      permission: 'requisite.goods-receipts.view',
      order: 903,
    },
    {
      key: 'requisite-suppliers',
      label: 'Suppliers',
      path: '/requisite/suppliers',
      permission: 'requisite.suppliers.view',
      order: 904,
    },
    {
      key: 'requisite-rfqs',
      label: 'Quotes/RFQs',
      path: '/requisite/rfqs',
      permission: 'requisite.rfqs.manage',
      order: 905,
    },
    {
      key: 'requisite-reports',
      label: 'Reports',
      path: '/requisite/reports',
      permission: 'requisite.reports.view',
      order: 906,
    },
  ],

  capabilities: [
    { capability: 'purchasing.procurement.v1', provides: { serviceRef: 'RequisitionService' } },
    { capability: 'purchasing.cost-source.v1', provides: { serviceRef: 'PurchaseOrderService' } },
    { capability: 'purchasing.supplier-registry.v1', provides: { serviceRef: 'SupplierService' } },
    { capability: 'purchasing.goods-receipt.v1', provides: { serviceRef: 'GoodsReceiptService' } },
  ],

  eventsPublished: [
    {
      eventType: 'requisite.requisition.created.v1',
      version: 1,
      description: 'A requisition was created.',
    },
    {
      eventType: 'requisite.requisition.submitted.v1',
      version: 1,
      description: 'A requisition was submitted for approval.',
    },
    {
      eventType: 'requisite.requisition.approved.v1',
      version: 1,
      description: 'A requisition completed approval.',
    },
    {
      eventType: 'requisite.requisition.rejected.v1',
      version: 1,
      description: 'A requisition was rejected.',
    },
    {
      eventType: 'requisite.purchase-order.created.v1',
      version: 1,
      description: 'A purchase order was generated from an approved requisition.',
    },
    {
      eventType: 'requisite.purchase-order.issued.v1',
      version: 1,
      description: 'A purchase order was issued to its supplier.',
    },
    {
      eventType: 'requisite.goods-receipt.created.v1',
      version: 1,
      description: 'A goods receipt was recorded against a purchase order.',
    },
    {
      eventType: 'requisite.goods-received.v1',
      version: 1,
      description: 'A purchase order line received goods (partial or full).',
    },
    {
      eventType: 'requisite.purchase-order.completed.v1',
      version: 1,
      description: 'A purchase order reached fully-received completion.',
    },
  ],

  numberingSequences: [
    { sequenceKey: 'requisition', prefix: 'REQ-', padLength: 6 },
    { sequenceKey: 'purchase-order', prefix: 'PO-', padLength: 6 },
    { sequenceKey: 'goods-receipt', prefix: 'GRN-', padLength: 6 },
    { sequenceKey: 'rfq', prefix: 'RFQ-', padLength: 6 },
    { sequenceKey: 'supplier', prefix: 'SUP-', padLength: 5 },
  ],

  defaultForms: [
    {
      formKey: 'requisition.create',
      label: 'New Requisition',
      definition: {
        sections: [
          {
            key: 'main',
            label: 'Purpose',
            fields: [
              {
                key: 'reason',
                label: 'Reason / business justification',
                type: 'text',
                required: true,
              },
              { key: 'required_by_date', label: 'Required by', type: 'date' },
              { key: 'cost_object_reference', label: 'Project / cost reference', type: 'text' },
              { key: 'category', label: 'Category', type: 'text' },
            ],
          },
        ],
      },
    },
    {
      formKey: 'supplier.create',
      label: 'New Supplier',
      definition: {
        sections: [
          {
            key: 'main',
            label: 'Supplier Details',
            fields: [
              { key: 'name', label: 'Supplier Name', type: 'text', required: true },
              { key: 'contact_name', label: 'Contact Name', type: 'text' },
              { key: 'email', label: 'Email', type: 'text' },
              { key: 'phone', label: 'Phone', type: 'text' },
              { key: 'payment_terms', label: 'Payment Terms', type: 'text' },
            ],
          },
        ],
      },
    },
  ],

  // Default requisition lifecycle - item 6. Application owns the semantic
  // meaning of each state; Core Workflow owns the state-machine mechanism
  // itself (optimistic-concurrency transitions, permission-gated edges).
  // Configurable through Core's normal supported workflow mechanisms -
  // nothing here is hardcoded into Requisite's own code.
  defaultWorkflows: [
    {
      workflowKey: 'requisition-lifecycle',
      definition: {
        states: [
          'draft',
          'submitted',
          'awaiting_approval',
          'approved',
          'rejected',
          'ordered',
          'partially_received',
          'received',
          'closed',
          'cancelled',
        ],
        initialState: 'draft',
        transitions: [
          { from: 'draft', to: 'submitted', permission: 'requisite.requisitions.submit' },
          {
            from: 'submitted',
            to: 'awaiting_approval',
            permission: 'requisite.requisitions.submit',
          },
          {
            from: 'awaiting_approval',
            to: 'approved',
            permission: 'requisite.requisitions.approve',
          },
          {
            from: 'awaiting_approval',
            to: 'rejected',
            permission: 'requisite.requisitions.approve',
          },
          { from: 'approved', to: 'ordered', permission: 'requisite.purchase-orders.create' },
          {
            from: 'ordered',
            to: 'partially_received',
            permission: 'requisite.goods-receipts.create',
          },
          {
            from: 'partially_received',
            to: 'received',
            permission: 'requisite.goods-receipts.create',
          },
          { from: 'ordered', to: 'received', permission: 'requisite.goods-receipts.create' },
          { from: 'received', to: 'closed', permission: 'requisite.requisitions.edit' },
          { from: 'draft', to: 'cancelled', permission: 'requisite.requisitions.cancel' },
          { from: 'submitted', to: 'cancelled', permission: 'requisite.requisitions.cancel' },
          {
            from: 'awaiting_approval',
            to: 'cancelled',
            permission: 'requisite.requisitions.cancel',
          },
        ],
      },
    },
  ],
};

export async function registerRequisiteApp(registry: ApplicationRegistryService): Promise<void> {
  await registry.registerApp(REQUISITE_APP_MANIFEST);
}
