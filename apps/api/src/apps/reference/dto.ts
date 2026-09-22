import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Input validation DTOs - P1 item 15. Every field is explicitly declared
 * and typed; class-validator decorators enforce shape BEFORE the handler
 * runs (see the global ValidationPipe in main.ts, which also strips any
 * property not declared here). This is the pattern documented in
 * docs/APP_SDK.md as the standard future apps should follow.
 */
export class CreateWidgetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsIn(['active', 'expired'])
  warrantyStatus?: string;
}

export class DecideDto {
  @IsUUID()
  stepId!: string;

  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
