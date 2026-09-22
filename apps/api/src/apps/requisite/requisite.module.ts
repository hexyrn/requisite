import { Module } from '@nestjs/common';
import { PlatformModule } from '../../platform/platform.module';
import { RequisiteOnboardingService } from './requisite-onboarding.service';
import { SupplierService } from './supplier.service';
import { RequisitionService } from './requisition.service';
import { PurchaseOrderService } from './purchase-order.service';
import { GoodsReceiptService } from './goods-receipt.service';
import { RfqService } from './rfq.service';
import { RequisiteController } from './requisite.controller';

@Module({
  imports: [PlatformModule],
  controllers: [RequisiteController],
  providers: [RequisiteOnboardingService, SupplierService, RequisitionService, PurchaseOrderService, GoodsReceiptService, RfqService],
  exports: [RequisiteOnboardingService, SupplierService, RequisitionService, PurchaseOrderService, GoodsReceiptService, RfqService],
})
export class RequisiteAppModule {}
