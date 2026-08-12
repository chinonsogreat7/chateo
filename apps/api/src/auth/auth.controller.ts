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
  ApiBody,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
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

const OTP_CHALLENGE_ID_EXAMPLE = '550e8400-e29b-41d4-a716-446655440000';
const REFRESH_TOKEN_EXAMPLE =
  '550e8400-e29b-41d4-a716-446655440000.3fQ8xZ7uV2nK5mP9rT4wY6aB1cD0eF8gH2jL7sN5qRk';

@ApiTags('auth')
@ApiExtraModels(RequestOtpDto, ResendOtpDto, VerifyOtpDto, RefreshTokenDto)
@Controller('auth')
@UseInterceptors(NoStoreInterceptor)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('otp/request')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request a phone verification code' })
  @ApiBody({
    schema: { $ref: getSchemaPath(RequestOtpDto) },
    examples: {
      default: {
        summary: 'Request a code for a Nigerian phone number',
        value: { phoneNumber: '+2348012345678' },
      },
    },
  })
  @ApiAcceptedResponse({ type: OtpChallengeResponseDto })
  requestOtp(@Body() input: RequestOtpDto): Promise<OtpChallengeResponseDto> {
    return this.authService.requestOtp(input.phoneNumber);
  }

  @Post('otp/resend')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Resend a phone verification code' })
  @ApiBody({
    schema: { $ref: getSchemaPath(ResendOtpDto) },
    examples: {
      default: {
        summary: 'Resend the code for an existing challenge',
        value: { challengeId: OTP_CHALLENGE_ID_EXAMPLE },
      },
    },
  })
  @ApiAcceptedResponse({ type: OtpChallengeResponseDto })
  resendOtp(@Body() input: ResendOtpDto): Promise<OtpChallengeResponseDto> {
    return this.authService.resendOtp(input.challengeId);
  }

  @Post('otp/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify the code and create a persistent session' })
  @ApiBody({
    schema: { $ref: getSchemaPath(VerifyOtpDto) },
    examples: {
      default: {
        summary: 'Verify a code from a mobile device',
        value: {
          challengeId: OTP_CHALLENGE_ID_EXAMPLE,
          code: '1234',
          device: {
            name: "Student's iPhone",
            platform: 'ios',
          },
        },
      },
    },
  })
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
  @ApiBody({
    schema: { $ref: getSchemaPath(RefreshTokenDto) },
    examples: {
      default: {
        summary: 'Exchange the current refresh token',
        value: { refreshToken: REFRESH_TOKEN_EXAMPLE },
      },
    },
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
  @ApiBody({
    schema: { $ref: getSchemaPath(RefreshTokenDto) },
    examples: {
      default: {
        summary: 'Log out the session represented by a refresh token',
        value: { refreshToken: REFRESH_TOKEN_EXAMPLE },
      },
    },
  })
  @ApiNoContentResponse()
  logout(@Body() input: RefreshTokenDto): Promise<void> {
    return this.authService.logout(input.refreshToken);
  }
}
