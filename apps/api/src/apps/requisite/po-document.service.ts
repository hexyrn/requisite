import { Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import PDFDocument from 'pdfkit';
import { Database } from '../../db/types';
import { minorToDecimalString } from './money';

/**
 * Purchase Order document generation, item 37 - a professional printable
 * PO via Core's PDF infrastructure (pdfkit, the same library P2's
 * ExportService uses), with organisation branding. Deliberately a
 * dedicated builder rather than reusing ExportService.toPdfBuffer()
 * directly: a PO document is a structured business document (header
 * fields + a line table + totals), not a flat tabular export - but it
 * still goes through the SAME PDF library/approach Core already
 * standardised on in P2, never a second PDF engine.
 */
@Injectable()
export class PoDocumentService {
  async generatePdf(
    db: Kysely<Database>,
    organisationId: string,
    purchaseOrderId: string,
    organisationName: string,
  ): Promise<Buffer> {
    const po = await db
      .selectFrom('requisite_purchase_orders')
      .selectAll()
      .where('id', '=', purchaseOrderId)
      .where('organisation_id', '=', organisationId)
      .executeTakeFirst();
    if (!po) throw new NotFoundException('Purchase order not found.');
    const supplier = await db
      .selectFrom('requisite_suppliers')
      .selectAll()
      .where('id', '=', po.supplier_id)
      .executeTakeFirstOrThrow();
    const lines = await db
      .selectFrom('requisite_purchase_order_lines')
      .selectAll()
      .where('purchase_order_id', '=', purchaseOrderId)
      .orderBy('line_number', 'asc')
      .execute();

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).text('PURCHASE ORDER', { align: 'right' });
      doc.fontSize(11).text(po.po_number, { align: 'right' });
      doc.moveDown();

      doc.fontSize(12).text(organisationName);
      doc.fontSize(9).fillColor('#555');
      if (po.delivery_address) doc.text(`Deliver to: ${po.delivery_address}`);
      doc.fillColor('#000');
      doc.moveDown();

      doc.fontSize(10).text(`Supplier: ${supplier.name}`);
      if (supplier.address) doc.text(supplier.address);
      doc.text(`Order date: ${po.order_date}`);
      if (po.expected_delivery_date) doc.text(`Expected delivery: ${po.expected_delivery_date}`);
      if (po.payment_terms) doc.text(`Payment terms: ${po.payment_terms}`);
      if (po.supplier_reference) doc.text(`Supplier reference: ${po.supplier_reference}`);
      doc.moveDown();

      doc.fontSize(10).text('Description', 40, doc.y, { continued: true, width: 250 });
      doc.text('Qty', 290, doc.y, { continued: true, width: 60 });
      doc.text('Unit Price', 350, doc.y, { continued: true, width: 80 });
      doc.text('Line Total', 440, doc.y);
      doc.moveDown(0.5);
      doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.3);

      for (const line of lines) {
        doc.fontSize(9).text(line.description, 40, doc.y, { continued: true, width: 250 });
        doc.text(String(line.quantity_ordered), 290, doc.y, { continued: true, width: 60 });
        doc.text(minorToDecimalString(BigInt(line.unit_price_minor)), 350, doc.y, {
          continued: true,
          width: 80,
        });
        doc.text(minorToDecimalString(BigInt(line.line_total_minor)), 440, doc.y);
      }

      doc.moveDown();
      doc.moveTo(350, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.3);
      doc
        .fontSize(9)
        .text(`Subtotal: ${minorToDecimalString(BigInt(po.subtotal_minor))} ${po.currency}`, {
          align: 'right',
        });
      doc.text(`Tax: ${minorToDecimalString(BigInt(po.tax_minor))} ${po.currency}`, {
        align: 'right',
      });
      if (BigInt(po.carriage_minor) > 0n)
        doc.text(`Carriage: ${minorToDecimalString(BigInt(po.carriage_minor))} ${po.currency}`, {
          align: 'right',
        });
      doc
        .fontSize(11)
        .text(`Total: ${minorToDecimalString(BigInt(po.total_minor))} ${po.currency}`, {
          align: 'right',
        });

      if (po.notes) {
        doc.moveDown();
        doc.fontSize(9).text(`Notes: ${po.notes}`);
      }

      doc.end();
    });
  }
}
