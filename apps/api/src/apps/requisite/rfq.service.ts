import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { HexyrnAppContext } from '@hexyrn/app-sdk';
import { Database } from '../../db/types';
import { RequisiteOnboardingService } from './requisite-onboarding.service';
import { multiplyMinor, sumMinor } from './money';

export interface QuoteLineInput {
  description: string;
  quantity: string;
  unitPriceMinor: string;
  requisitionLineId?: string;
}

export interface RecordQuoteInput {
  supplierId: string;
  quoteReference?: string;
  quoteDate?: string;
  expiryDate?: string;
  currency?: string;
  carriageMinor?: string;
  notes?: string;
  lines: QuoteLineInput[];
}

/**
 * RFQ/Quote comparison, item 9. No supplier portal in v1 - a purchasing
 * user manually records each supplier's quotation. Comparison is a plain
 * read (listQuotesForRfq, sorted by total) - the SYSTEM never auto-selects
 * a winner; `selectQuote` is always an explicit human action, and the
 * previously-selected quote (if any) is demoted back to 'received' so
 * there is only ever at most one 'selected' quote per RFQ at a time.
 */
@Injectable()
export class RfqService {
  constructor(private readonly onboarding: RequisiteOnboardingService) {}

  async createRfq(ctx: HexyrnAppContext<Kysely<Database>>, db: Kysely<Database>, actorUserAccountId: string, requisitionId?: string) {
    await this.onboarding.onboardOrganisation(db, ctx.organisationId);
    const rfqNumber = await ctx.numbering.next(db, 'rfq');
    return db.insertInto('requisite_rfqs').values({ organisation_id: ctx.organisationId, rfq_number: rfqNumber, requisition_id: requisitionId ?? null, created_by: actorUserAccountId }).returningAll().executeTakeFirstOrThrow();
  }

  async listRfqs(db: Kysely<Database>, organisationId: string) {
    return db.selectFrom('requisite_rfqs').selectAll().where('organisation_id', '=', organisationId).orderBy('created_at', 'desc').execute();
  }

  async getRfq(db: Kysely<Database>, organisationId: string, rfqId: string) {
    const rfq = await db.selectFrom('requisite_rfqs').selectAll().where('id', '=', rfqId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!rfq) throw new NotFoundException('RFQ not found.');
    const quotes = await this.listQuotesForRfq(db, organisationId, rfqId);
    return { ...rfq, quotes };
  }

  async recordQuote(db: Kysely<Database>, organisationId: string, rfqId: string, input: RecordQuoteInput) {
    if (input.lines.length === 0) throw new BadRequestException('A quotation must have at least one line.');
    const rfq = await db.selectFrom('requisite_rfqs').selectAll().where('id', '=', rfqId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!rfq) throw new NotFoundException('RFQ not found.');
    if (rfq.status !== 'open') throw new ForbiddenException(`Cannot record a quote against a "${rfq.status}" RFQ.`);

    const supplier = await db.selectFrom('requisite_suppliers').selectAll().where('id', '=', input.supplierId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!supplier) throw new NotFoundException('Supplier not found.');

    const carriageMinor = BigInt(input.carriageMinor || '0');
    const lineTotals = input.lines.map((l) => multiplyMinor(BigInt(l.unitPriceMinor || '0'), l.quantity));
    const totalMinor = sumMinor(lineTotals) + carriageMinor;

    const quote = await db
      .insertInto('requisite_quotes')
      .values({
        organisation_id: organisationId,
        rfq_id: rfqId,
        supplier_id: input.supplierId,
        quote_reference: input.quoteReference ?? null,
        quote_date: input.quoteDate ?? null,
        expiry_date: input.expiryDate ?? null,
        currency: input.currency ?? 'GBP',
        carriage_minor: carriageMinor.toString() as any,
        total_minor: totalMinor.toString() as any,
        notes: input.notes ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i];
      await db
        .insertInto('requisite_quote_lines')
        .values({
          organisation_id: organisationId,
          quote_id: quote.id,
          requisition_line_id: line.requisitionLineId ?? null,
          description: line.description,
          quantity: line.quantity,
          unit_price_minor: line.unitPriceMinor,
          line_total_minor: lineTotals[i].toString() as any,
        })
        .execute();
    }

    return quote;
  }

  /** Comparison view (item 9) - a plain sorted read, never an auto-decision. Includes the supplier name so the comparison screen doesn't need a second lookup per row. */
  async listQuotesForRfq(db: Kysely<Database>, organisationId: string, rfqId: string) {
    return db
      .selectFrom('requisite_quotes')
      .innerJoin('requisite_suppliers', 'requisite_suppliers.id', 'requisite_quotes.supplier_id')
      .select([
        'requisite_quotes.id',
        'requisite_quotes.rfq_id',
        'requisite_quotes.supplier_id',
        'requisite_suppliers.name as supplier_name',
        'requisite_quotes.quote_reference',
        'requisite_quotes.quote_date',
        'requisite_quotes.expiry_date',
        'requisite_quotes.currency',
        'requisite_quotes.carriage_minor',
        'requisite_quotes.total_minor',
        'requisite_quotes.status',
        'requisite_quotes.selection_reason',
        'requisite_quotes.notes',
      ])
      .where('requisite_quotes.organisation_id', '=', organisationId)
      .where('requisite_quotes.rfq_id', '=', rfqId)
      .orderBy('requisite_quotes.total_minor', 'asc')
      .execute();
  }

  /** Explicit human selection - demotes any previously-selected quote on this RFQ back to 'received' so at most one quote is ever 'selected'. */
  async selectQuote(db: Kysely<Database>, organisationId: string, rfqId: string, quoteId: string, reason?: string) {
    const quote = await db.selectFrom('requisite_quotes').selectAll().where('id', '=', quoteId).where('rfq_id', '=', rfqId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!quote) throw new NotFoundException('Quote not found.');

    await db.updateTable('requisite_quotes').set({ status: 'received' }).where('rfq_id', '=', rfqId).where('status', '=', 'selected').execute();
    const selected = await db.updateTable('requisite_quotes').set({ status: 'selected', selection_reason: reason ?? null }).where('id', '=', quoteId).returningAll().executeTakeFirstOrThrow();
    await db.updateTable('requisite_rfqs').set({ status: 'closed' }).where('id', '=', rfqId).execute();
    return selected;
  }

  async rejectQuote(db: Kysely<Database>, organisationId: string, quoteId: string) {
    const quote = await db.selectFrom('requisite_quotes').selectAll().where('id', '=', quoteId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!quote) throw new NotFoundException('Quote not found.');
    return db.updateTable('requisite_quotes').set({ status: 'rejected' }).where('id', '=', quoteId).returningAll().executeTakeFirstOrThrow();
  }
}
