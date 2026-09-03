import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, ValidateIf } from 'class-validator';

export class UpdateConversationSettingsDto {
  @ApiPropertyOptional({
    type: Boolean,
    description: 'Archive or restore the conversation for the signed-in user.',
  })
  @ValidateIf(
    (_object: UpdateConversationSettingsDto, value: unknown) =>
      value !== undefined,
  )
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Mute or unmute the conversation for the signed-in user.',
  })
  @ValidateIf(
    (_object: UpdateConversationSettingsDto, value: unknown) =>
      value !== undefined,
  )
  @IsBoolean()
  muted?: boolean;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Pin or unpin the conversation for the signed-in user.',
  })
  @ValidateIf(
    (_object: UpdateConversationSettingsDto, value: unknown) =>
      value !== undefined,
  )
  @IsBoolean()
  pinned?: boolean;
}
