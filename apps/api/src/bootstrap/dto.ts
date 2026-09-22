import { IsEmail, IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Real class-validator DTO (P1 item 15 - fixes a confirmed gap: NestJS's
 * ValidationPipe silently skips validation for plain TypeScript interfaces,
 * since they erase to `Object` at runtime and have no decorator metadata
 * for class-validator to read - found while reviewing the global pipe
 * added earlier in P1, which turned out to do nothing for any P0 endpoint
 * still using a plain `interface` body type). This class replaces the old
 * `CompleteBootstrapInput` interface with identical field names/shape.
 */
export class CompleteBootstrapDto {
  @IsString()
  @MinLength(20)
  token!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  organisationName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  organisationDisplayName!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(3)
  defaultCurrency!: string;

  @IsString()
  @MaxLength(100)
  timezone!: string;

  @IsString()
  @MaxLength(35)
  locale!: string;

  @IsInt()
  @Min(1)
  @Max(12)
  financialYearStartMonth!: number;

  @IsEmail()
  ownerEmail!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(200)
  ownerPassword!: string;
}
