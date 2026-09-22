import { Module } from '@nestjs/common';
import { ReferenceController } from './reference.controller';
import { ReferenceService } from './reference.service';
import { PlatformModule } from '../../platform/platform.module';

@Module({
  imports: [PlatformModule],
  controllers: [ReferenceController],
  providers: [ReferenceService],
})
export class ReferenceAppModule {}
