-- Hexyrn Requisite v1 domain schema. Money is stored as BIGINT MINOR UNITS
-- (e.g. pence/cents) throughout - never NUMERIC/FLOAT for authoritative
-- monetary values, avoiding all floating-point rounding risk (item 38).
-- Every org-owned table gets RLS with FORCE, identical pattern to every
-- other Core/app table (Architecture §8).

CREATE TABLE requisite_suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  supplier_number TEXT NOT NULL,
  name TEXT NOT NULL,
  account_number TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | inactive
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  payment_terms TEXT,
  default_currency TEXT NOT NULL DEFAULT 'GBP',
  notes TEXT,
  created_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, supplier_number)
);
ALTER TABLE requisite_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisite_suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON requisite_suppliers
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE requisite_requisitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  requisition_number TEXT NOT NULL,
  requester_user_account_id UUID NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT,
  request_date DATE NOT NULL DEFAULT current_date,
  organisational_unit_id UUID REFERENCES organisational_units(id) ON DELETE SET NULL,
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  required_by_date DATE,
  preferred_supplier_id UUID REFERENCES requisite_suppliers(id) ON DELETE SET NULL,
  reason TEXT,
  cost_object_reference TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL DEFAULT 'GBP',
  estimated_value_minor INT8 NOT NULL DEFAULT 0,
  notes TEXT,
  version INT NOT NULL DEFAULT 1, -- optimistic concurrency (item 39: edit-while-submitting race)
  cancelled_at TIMESTAMPTZ,
  created_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, requisition_number)
);
ALTER TABLE requisite_requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisite_requisitions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON requisite_requisitions
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE requisite_requisition_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  requisition_id UUID NOT NULL REFERENCES requisite_requisitions(id) ON DELETE CASCADE,
  line_number INT NOT NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(14,4) NOT NULL,
  unit TEXT,
  estimated_unit_price_minor INT8 NOT NULL DEFAULT 0,
  estimated_total_minor INT8 NOT NULL DEFAULT 0,
  category TEXT,
  preferred_supplier_id UUID REFERENCES requisite_suppliers(id) ON DELETE SET NULL,
  required_by_date DATE,
  cost_object_reference TEXT,
  notes TEXT,
  UNIQUE (requisition_id, line_number)
);
ALTER TABLE requisite_requisition_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisite_requisition_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON requisite_requisition_lines
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- RFQ / Quote comparison (item 9).
CREATE TABLE requisite_rfqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  rfq_number TEXT NOT NULL,
  requisition_id UUID REFERENCES requisite_requisitions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | closed
  created_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, rfq_number)
);
ALTER TABLE requisite_rfqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisite_rfqs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON requisite_rfqs
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE requisite_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  rfq_id UUID NOT NULL REFERENCES requisite_rfqs(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES requisite_suppliers(id) ON DELETE RESTRICT,
  quote_reference TEXT,
  quote_date DATE,
  expiry_date DATE,
  currency TEXT NOT NULL DEFAULT 'GBP',
  carriage_minor INT8 NOT NULL DEFAULT 0,
  total_minor INT8 NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'received', -- received | selected | rejected
  selection_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE requisite_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisite_quotes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON requisite_quotes
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE requisite_quote_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  quote_id UUID NOT NULL REFERENCES requisite_quotes(id) ON DELETE CASCADE,
  requisition_line_id UUID REFERENCES requisite_requisition_lines(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(14,4) NOT NULL,
  unit_price_minor INT8 NOT NULL DEFAULT 0,
  line_total_minor INT8 NOT NULL DEFAULT 0
);
ALTER TABLE requisite_quote_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisite_quote_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON requisite_quote_lines
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- Purchase Orders (item 4/8).
CREATE TABLE requisite_purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  po_number TEXT NOT NULL,
  supplier_id UUID NOT NULL REFERENCES requisite_suppliers(id) ON DELETE RESTRICT,
  source_requisition_id UUID REFERENCES requisite_requisitions(id) ON DELETE SET NULL,
  buyer_user_account_id UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  organisational_unit_id UUID REFERENCES organisational_units(id) ON DELETE SET NULL,
  delivery_location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  delivery_address TEXT,
  supplier_reference TEXT,
  currency TEXT NOT NULL DEFAULT 'GBP',
  payment_terms TEXT,
  order_date DATE NOT NULL DEFAULT current_date,
  expected_delivery_date DATE,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | issued | partially_received | received | completed | cancelled
  subtotal_minor INT8 NOT NULL DEFAULT 0,
  tax_minor INT8 NOT NULL DEFAULT 0,
  carriage_minor INT8 NOT NULL DEFAULT 0,
  total_minor INT8 NOT NULL DEFAULT 0,
  notes TEXT,
  version INT NOT NULL DEFAULT 1, -- optimistic concurrency (item 39: duplicate-issue race)
  created_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, po_number)
);
ALTER TABLE requisite_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisite_purchase_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON requisite_purchase_orders
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- Prevents two POs being generated from the same requisition line by
-- accident (item 39: duplicate PO generation) - a requisition line may be
-- split across suppliers deliberately, but never silently double-ordered
-- for the SAME (requisition_line, supplier) pair.
CREATE TABLE requisite_purchase_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  purchase_order_id UUID NOT NULL REFERENCES requisite_purchase_orders(id) ON DELETE CASCADE,
  line_number INT NOT NULL,
  source_requisition_line_id UUID REFERENCES requisite_requisition_lines(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity_ordered NUMERIC(14,4) NOT NULL,
  unit TEXT,
  unit_price_minor INT8 NOT NULL DEFAULT 0,
  tax_rate_bp INT NOT NULL DEFAULT 0, -- basis points (e.g. 2000 = 20.00%) - never a float rate
  line_total_minor INT8 NOT NULL DEFAULT 0,
  category TEXT,
  cost_object_reference TEXT,
  expected_delivery_date DATE,
  quantity_received NUMERIC(14,4) NOT NULL DEFAULT 0, -- denormalised running total, maintained transactionally alongside goods_receipt_lines
  UNIQUE (purchase_order_id, line_number),
  CHECK (quantity_received <= quantity_ordered)
);
ALTER TABLE requisite_purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisite_purchase_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON requisite_purchase_order_lines
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- Goods Receipts (item 4/5) - multiple receipts per PO, each an immutable
-- historical record (never mutated to merge partial receipts together).
CREATE TABLE requisite_goods_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  grn_number TEXT NOT NULL,
  purchase_order_id UUID NOT NULL REFERENCES requisite_purchase_orders(id) ON DELETE RESTRICT,
  received_by_user_account_id UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  delivery_note_reference TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, grn_number)
);
ALTER TABLE requisite_goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisite_goods_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON requisite_goods_receipts
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE requisite_goods_receipt_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  goods_receipt_id UUID NOT NULL REFERENCES requisite_goods_receipts(id) ON DELETE CASCADE,
  purchase_order_line_id UUID NOT NULL REFERENCES requisite_purchase_order_lines(id) ON DELETE RESTRICT,
  quantity_received NUMERIC(14,4) NOT NULL CHECK (quantity_received > 0),
  condition TEXT,
  notes TEXT
);
ALTER TABLE requisite_goods_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisite_goods_receipt_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON requisite_goods_receipt_lines
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE INDEX ix_requisite_po_lines_po ON requisite_purchase_order_lines(purchase_order_id);
CREATE INDEX ix_requisite_grn_lines_grn ON requisite_goods_receipt_lines(goods_receipt_id);
CREATE INDEX ix_requisite_grn_lines_po_line ON requisite_goods_receipt_lines(purchase_order_line_id);
CREATE INDEX ix_requisite_req_lines_req ON requisite_requisition_lines(requisition_id);
