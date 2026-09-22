import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { withOrgContext } from '../../db/org-context';
import { RequirePermission } from '../../rbac/permission.guard';
import { BelongsToApp } from '../../platform/app-registry/application-active.guard';
import { AppContextFactory } from '../../platform/app-context.factory';
import { SupplierService } from './supplier.service';
import { RequisitionService } from './requisition.service';
import { PurchaseOrderService } from './purchase-order.service';
import { GoodsReceiptService } from './goods-receipt.service';
import { REQUISITE_APP_MANIFEST } from './requisite.manifest';

const APP_ID = REQUISITE_APP_MANIFEST.appId;

/**
 * Public REST API (item 30/31) - deliberate, scoped resources, never
 * direct internal-repository exposure. Reachable identically by a human
 * session cookie or a service-account API key (P2 item 11's unified
 * SessionAuthGuard), with the SAME @RequirePermission checks either way -
 * "no second authorisation universe" applied to Requisite exactly as it
 * was to Core.
 */
@Controller('api/v1/requisite')
@BelongsToApp(APP_ID)
export class RequisiteController {
  constructor(
    private readonly suppliers: SupplierService,
    private readonly requisitions: RequisitionService,
    private readonly purchaseOrders: PurchaseOrderService,
    private readonly goodsReceipts: GoodsReceiptService,
    private readonly contextFactory: AppContextFactory,
  ) {}

  private ctx(req: FastifyRequest) {
    const organisationId = (req as any).currentOrganisationId;
    const subject = (req as any).permissionSubject;
    return { organisationId, subject };
  }

  @RequirePermission('requisite.suppliers.view')
  @Get('suppliers')
  async listSuppliers(@Req() req: FastifyRequest) {
    const { organisationId } = this.ctx(req);
    return withOrgContext(organisationId, (db) => this.suppliers.listSuppliers(db, organisationId));
  }

  @RequirePermission('requisite.suppliers.manage')
  @Post('suppliers')
  async createSupplier(@Req() req: FastifyRequest, @Body() body: { name: string; email?: string; phone?: string }) {
    const { organisationId, subject } = this.ctx(req);
    return withOrgContext(organisationId, (db) => {
      const ctx = this.contextFactory.create(APP_ID, organisationId, subject.grantedPermissions, subject.userAccountId, db);
      return this.suppliers.createSupplier(ctx, db, subject.userAccountId, body);
    });
  }

  @RequirePermission('requisite.requisitions.view')
  @Get('requisitions')
  async listRequisitions(@Req() req: FastifyRequest) {
    const { organisationId } = this.ctx(req);
    return withOrgContext(organisationId, (db) => this.requisitions.listRequisitions(db, organisationId));
  }

  @RequirePermission('requisite.requisitions.view')
  @Get('requisitions/:id')
  async getRequisition(@Req() req: FastifyRequest, @Param('id') id: string) {
    const { organisationId } = this.ctx(req);
    return withOrgContext(organisationId, (db) => this.requisitions.getRequisition(db, organisationId, id));
  }

  @RequirePermission('requisite.requisitions.create')
  @Post('requisitions')
  async createRequisition(@Req() req: FastifyRequest, @Body() body: any) {
    const { organisationId, subject } = this.ctx(req);
    return withOrgContext(organisationId, (db) => {
      const ctx = this.contextFactory.create(APP_ID, organisationId, subject.grantedPermissions, subject.userAccountId, db);
      return this.requisitions.createRequisition(ctx, db, subject.userAccountId, body);
    });
  }

  @RequirePermission('requisite.purchase-orders.view')
  @Get('purchase-orders')
  async listPurchaseOrders(@Req() req: FastifyRequest) {
    const { organisationId } = this.ctx(req);
    return withOrgContext(organisationId, (db) => this.purchaseOrders.listPurchaseOrders(db, organisationId));
  }

  @RequirePermission('requisite.purchase-orders.view')
  @Get('purchase-orders/:id')
  async getPurchaseOrder(@Req() req: FastifyRequest, @Param('id') id: string) {
    const { organisationId } = this.ctx(req);
    return withOrgContext(organisationId, (db) => this.purchaseOrders.getPurchaseOrder(db, organisationId, id));
  }

  @RequirePermission('requisite.goods-receipts.view')
  @Get('goods-receipts/:id')
  async getGoodsReceipt(@Req() req: FastifyRequest, @Param('id') id: string) {
    const { organisationId } = this.ctx(req);
    return withOrgContext(organisationId, (db) => this.goodsReceipts.getGoodsReceipt(db, organisationId, id));
  }

  @RequirePermission('requisite.goods-receipts.create')
  @Post('purchase-orders/:id/goods-receipts')
  async recordGoodsReceipt(@Req() req: FastifyRequest, @Param('id') purchaseOrderId: string, @Body() body: any) {
    const { organisationId, subject } = this.ctx(req);
    return withOrgContext(organisationId, (db) => {
      const ctx = this.contextFactory.create(APP_ID, organisationId, subject.grantedPermissions, subject.userAccountId, db);
      return this.goodsReceipts.recordReceipt(ctx, db, subject.userAccountId, purchaseOrderId, body);
    });
  }
}
