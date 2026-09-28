import { Module } from '@nestjs/common';
import { PlatformModule } from '../../platform/platform.module';
import { RequisiteOnboardingService } from './requisite-onboarding.service';
import { SupplierService } from './supplier.service';
import { RequisitionService } from './requisition.service';
import { PurchaseOrderService } from './purchase-order.service';
import { GoodsReceiptService } from './goods-receipt.service';
import { RfqService } from './rfq.service';
import { RequisiteController } from './requisite.controller';
import { DeliveryMonitoringService } from './delivery-monitoring.service';
import { PoDocumentService } from './po-document.service';

@Module({
  imports: [PlatformModule],
  controllers: [RequisiteController],
  providers: [
    RequisiteOnboardingService,
    SupplierService,
    RequisitionService,
    PurchaseOrderService,
    GoodsReceiptService,
    RfqService,
    DeliveryMonitoringService,
    PoDocumentService,
  ],
  exports: [
    RequisiteOnboardingService,
    SupplierService,
    RequisitionService,
    PurchaseOrderService,
    GoodsReceiptService,
    RfqService,
    DeliveryMonitoringService,
    PoDocumentService,
  ],
})
export class RequisiteAppModule {}
