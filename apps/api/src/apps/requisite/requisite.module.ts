import { Module } from '@nestjs/common';
import { PlatformModule } from '../../platform/platform.module';
import { RequisiteOnboardingService } from './requisite-onboarding.service';
import { SupplierService } from './supplier.service';
import { RequisitionService } from './requisition.service';

@Module({
  imports: [PlatformModule],
  providers: [RequisiteOnboardingService, SupplierService, RequisitionService],
  exports: [RequisiteOnboardingService, SupplierService, RequisitionService],
})
export class RequisiteAppModule {}
