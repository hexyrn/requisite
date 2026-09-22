import { Module } from '@nestjs/common';
import { PlatformModule } from '../../platform/platform.module';
import { RequisiteOnboardingService } from './requisite-onboarding.service';
import { SupplierService } from './supplier.service';
import { RequisitionService } from './requisition.service';
import { PurchaseOrderService } from './purchase-order.service';
import { GoodsReceiptService } from './goods-receipt.service';

@Module({
  imports: [PlatformModule],
  providers: [RequisiteOnboardingService, SupplierService, RequisitionService, PurchaseOrderService, GoodsReceiptService],
  exports: [RequisiteOnboardingService, SupplierService, RequisitionService, PurchaseOrderService, GoodsReceiptService],
})
export class RequisiteAppModule {}
