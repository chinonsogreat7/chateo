import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @Public()
  @SkipThrottle()
  @ApiOkResponse({
    schema: {
      example: { status: 'ok', service: 'chateo-api' },
    },
  })
  getHealth(): { status: 'ok'; service: 'chateo-api' } {
    return { status: 'ok', service: 'chateo-api' };
  }
}
