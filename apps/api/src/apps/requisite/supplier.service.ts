import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { HexyrnAppContext } from '@hexyrn/app-sdk';
import { Database } from '../../db/types';
import { RequisiteOnboardingService } from './requisite-onboarding.service';


export interface CreateSupplierInput {
  name: string;
  accountNumber?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  paymentTerms?: string;
  defaultCurrency?: string;
  notes?: string;
}

/**
 * Supplier register, item 10 - deliberately NOT a CRM. Every write goes
 * through `ctx` (Core Numbering for supplier_number, Core Custom Fields
 * for extension attributes like "Account Manager"/"Framework Agreement
 * Number" per item 14) - this service never substitutes its own numbering
 * or attribute-storage mechanism.
 */
@Injectable()
export class SupplierService {
  constructor(private readonly onboarding: RequisiteOnboardingService) {}

  async createSupplier(ctx: HexyrnAppContext<Kysely<Database>>, db: Kysely<Database>, actorUserAccountId: string, input: CreateSupplierInput) {
    await this.onboarding.onboardOrganisation(db, ctx.organisationId); // idempotent - suppliers can be the first thing set up, before any requisition
    if (!input.name?.trim()) throw new BadRequestException('Supplier name is required.');

    const supplierNumber = await ctx.numbering.next(db, 'supplier');
    return db
      .insertInto('requisite_suppliers')
      .values({
        organisation_id: ctx.organisationId,
        supplier_number: supplierNumber,
        name: input.name.trim(),
        account_number: input.accountNumber ?? null,
        contact_name: input.contactName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        payment_terms: input.paymentTerms ?? null,
        default_currency: input.defaultCurrency ?? 'GBP',
        notes: input.notes ?? null,
        created_by: actorUserAccountId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async updateSupplier(db: Kysely<Database>, organisationId: string, supplierId: string, updates: Partial<CreateSupplierInput>) {
    const supplier = await this.getSupplier(db, organisationId, supplierId);
    if (supplier.status === 'inactive') {
      throw new ForbiddenException('Cannot edit an inactive supplier - reactivate it first.');
    }
    return db
      .updateTable('requisite_suppliers')
      .set({
        name: updates.name?.trim() ?? supplier.name,
        contact_name: updates.contactName ?? supplier.contact_name,
        email: updates.email ?? supplier.email,
        phone: updates.phone ?? supplier.phone,
        payment_terms: updates.paymentTerms ?? supplier.payment_terms,
        notes: updates.notes ?? supplier.notes,
        updated_at: new Date() as any,
      })
      .where('id', '=', supplierId)
      .where('organisation_id', '=', organisationId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async deactivateSupplier(db: Kysely<Database>, organisationId: string, supplierId: string) {
    await this.getSupplier(db, organisationId, supplierId);
    return db.updateTable('requisite_suppliers').set({ status: 'inactive', updated_at: new Date() as any }).where('id', '=', supplierId).where('organisation_id', '=', organisationId).returningAll().executeTakeFirstOrThrow();
  }

  async reactivateSupplier(db: Kysely<Database>, organisationId: string, supplierId: string) {
    await this.getSupplier(db, organisationId, supplierId);
    return db.updateTable('requisite_suppliers').set({ status: 'active', updated_at: new Date() as any }).where('id', '=', supplierId).where('organisation_id', '=', organisationId).returningAll().executeTakeFirstOrThrow();
  }

  async getSupplier(db: Kysely<Database>, organisationId: string, supplierId: string) {
    const supplier = await db.selectFrom('requisite_suppliers').selectAll().where('id', '=', supplierId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!supplier) throw new NotFoundException('Supplier not found.');
    return supplier;
  }

  async listSuppliers(db: Kysely<Database>, organisationId: string, includeInactive = false) {
    let query = db.selectFrom('requisite_suppliers').selectAll().where('organisation_id', '=', organisationId);
    if (!includeInactive) query = query.where('status', '=', 'active');
    return query.orderBy('name', 'asc').execute();
  }
}
