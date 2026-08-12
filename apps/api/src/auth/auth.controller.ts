import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import { AuthService } from './auth.service';
import {
  AuthResponseDto,
  OtpChallengeResponseDto,
} from './dto/auth-response.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@ApiTags('auth')
@Controller('auth')
@UseInterceptors(NoStoreInterceptor)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('otp/request')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request a phone verification code' })
  @ApiAcceptedResponse({ type: OtpChallengeResponseDto })
  requestOtp(@Body() input: RequestOtpDto): Promise<OtpChallengeResponseDto> {
    return this.authService.requestOtp(input.phoneNumber);
  }

  @Post('otp/resend')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Resend a phone verification code' })
  @ApiAcceptedResponse({ type: OtpChallengeResponseDto })
  resendOtp(@Body() input: ResendOtpDto): Promise<OtpChallengeResponseDto> {
    return this.authService.resendOtp(input.challengeId);
  }

  @Post('otp/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify the code and create a persistent session' })
  @ApiOkResponse({ type: AuthResponseDto })
  verifyOtp(
    @Body() input: VerifyOtpDto,
    @Req() request: Request,
  ): Promise<AuthResponseDto> {
    return this.authService.verifyOtp(input, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    });
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Rotate a refresh token and issue a new token pair',
  })
  @ApiOkResponse({ type: AuthResponseDto })
  refresh(@Body() input: RefreshTokenDto): Promise<AuthResponseDto> {
    return this.authService.refresh(input.refreshToken);
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Revoke a refresh session' })
  @ApiNoContentResponse()
  logout(@Body() input: RefreshTokenDto): Promise<void> {
    return this.authService.logout(input.refreshToken);
  }
}
