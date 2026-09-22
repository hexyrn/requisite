import { IsEmail, IsString, Length, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}

export class MfaVerifyDto {
  @IsString()
  @Length(6, 10) // 6-digit TOTP code or a 10-digit recovery code
  code!: string;
}

export class MfaEnrollConfirmDto {
  @IsString()
  @MinLength(10)
  secret!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}
