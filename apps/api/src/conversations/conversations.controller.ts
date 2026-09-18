import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import { ConversationsService } from './conversations.service';
import { AddGroupMembersDto } from './dto/add-group-members.dto';
import { ConversationParamsDto } from './dto/conversation-params.dto';
import {
  ConversationListResponseDto,
  DirectConversationResponseDto,
  GroupConversationResponseDto,
  conversationResponseSchema,
} from './dto/conversation-response.dto';
import type { ConversationResponseDto } from './dto/conversation-response.dto';
import { CreateDirectConversationDto } from './dto/create-direct-conversation.dto';
import { CreateGroupConversationDto } from './dto/create-group-conversation.dto';
import { DeleteDirectChatResponseDto } from './dto/delete-direct-chat-response.dto';
import { GroupMemberParamsDto } from './dto/group-member-params.dto';
import { ListArchivedConversationsQueryDto } from './dto/list-archived-conversations-query.dto';
import { ListConversationsQueryDto } from './dto/list-conversations-query.dto';
import { ListFavoriteConversationsQueryDto } from './dto/list-favorite-conversations-query.dto';
import { SetGroupAvatarDto } from './dto/set-group-avatar.dto';
import { TransferGroupOwnershipDto } from './dto/transfer-group-ownership.dto';
import { UpdateGroupConversationDto } from './dto/update-group-conversation.dto';
import { UpdateGroupMemberRoleDto } from './dto/update-group-member-role.dto';

const PARTICIPANT_ID_EXAMPLE = '7d444840-9dc0-11d1-b245-5ffdce74fad2';

@ApiTags('conversations')
@ApiBearerAuth()
@ApiExtraModels(
  CreateDirectConversationDto,
  CreateGroupConversationDto,
  UpdateGroupConversationDto,
  SetGroupAvatarDto,
  AddGroupMembersDto,
  UpdateGroupMemberRoleDto,
  TransferGroupOwnershipDto,
  DirectConversationResponseDto,
  GroupConversationResponseDto,
)
@Controller('conversations')
@UseInterceptors(NoStoreInterceptor)
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post('direct')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create or return an existing direct conversation',
  })
  @ApiBody({
    schema: { $ref: getSchemaPath(CreateDirectConversationDto) },
    examples: {
      default: {
        summary: 'Start a direct conversation with a registered user',
        value: { participantId: PARTICIPANT_ID_EXAMPLE },
      },
    },
  })
  @ApiOkResponse({ type: DirectConversationResponseDto })
  createDirect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateDirectConversationDto,
  ): Promise<DirectConversationResponseDto> {
    return this.conversationsService.createDirect(
      user.sub,
      input.participantId,
    );
  }

  @Post('group')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a group conversation' })
  @ApiBody({
    schema: { $ref: getSchemaPath(CreateGroupConversationDto) },
    examples: {
      default: {
        summary: 'Start a named group with registered users',
        value: {
          name: 'Study Group',
          participantIds: [
            '7d444840-9dc0-41d1-b245-5ffdce74fad2',
            '8e555951-aed1-42e2-8346-6aadece85be3',
          ],
        },
      },
    },
  })
  @ApiCreatedResponse({ type: GroupConversationResponseDto })
  @ApiConflictResponse({
    description:
      'GROUP_AVATAR_UNAVAILABLE: the media is not an owned, verified group photo.',
  })
  @ApiBadRequestResponse({
    description:
      'The group name or participant list is invalid, duplicated, or includes the creator.',
  })
  @ApiNotFoundResponse({
    description: 'One or more selected users do not exist.',
  })
  createGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateGroupConversationDto,
  ): Promise<GroupConversationResponseDto> {
    return this.conversationsService.createGroup(user.sub, input);
  }

  @Patch(':conversationId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update group conversation metadata' })
  @ApiBody({
    schema: {
      minProperties: 1,
      allOf: [{ $ref: getSchemaPath(UpdateGroupConversationDto) }],
    },
    examples: {
      default: {
        summary: 'Rename a group and remove its avatar',
        value: { name: 'Project Team', avatarMediaId: null },
      },
    },
  })
  @ApiOkResponse({ type: GroupConversationResponseDto })
  @ApiBadRequestResponse({
    description: 'No supported field was provided or the metadata is invalid.',
  })
  @ApiForbiddenResponse({
    description: 'The member is not allowed to edit group metadata.',
  })
  @ApiNotFoundResponse({
    description:
      'The group conversation is missing or the user is not a member.',
  })
  @ApiConflictResponse({
    description:
      'GROUP_AVATAR_UNAVAILABLE: the media is not an owned, verified group photo.',
  })
  updateGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationParamsDto,
    @Body() input: UpdateGroupConversationDto,
  ): Promise<GroupConversationResponseDto> {
    return this.conversationsService.updateGroup(
      user.sub,
      params.conversationId,
      input,
    );
  }

  @Put(':conversationId/avatar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a verified group photo (owner or admin)',
    description:
      'First create a group_avatar upload and complete verification. Repeating the same assignment is idempotent.',
  })
  @ApiBody({
    schema: { $ref: getSchemaPath(SetGroupAvatarDto) },
    examples: {
      default: {
        summary: 'Select your verified group photo',
        value: { mediaId: '550e8400-e29b-41d4-a716-446655440000' },
      },
    },
  })
  @ApiOkResponse({ type: GroupConversationResponseDto })
  @ApiBadRequestResponse({
    description: 'The media or conversation ID is invalid.',
  })
  @ApiForbiddenResponse({
    description: 'Only group owners and admins can change the photo.',
  })
  @ApiNotFoundResponse({
    description: 'The group is missing or the user is not a member.',
  })
  @ApiConflictResponse({
    description:
      'GROUP_AVATAR_UNAVAILABLE: missing, foreign, incomplete, deleted, or wrong-purpose media.',
  })
  setGroupAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationParamsDto,
    @Body() input: SetGroupAvatarDto,
  ): Promise<GroupConversationResponseDto> {
    return this.conversationsService.setGroupAvatar(
      user.sub,
      params.conversationId,
      input.mediaId,
    );
  }

  @Delete(':conversationId/avatar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a group photo (owner or admin)',
    description:
      'Idempotently clears the group photo reference. Does not delete the uploaded asset or the group.',
  })
  @ApiOkResponse({ type: GroupConversationResponseDto })
  @ApiBadRequestResponse({ description: 'The conversation ID is invalid.' })
  @ApiForbiddenResponse({
    description: 'Only group owners and admins can remove the photo.',
  })
  @ApiNotFoundResponse({
    description: 'The group is missing or the user is not a member.',
  })
  clearGroupAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationParamsDto,
  ): Promise<GroupConversationResponseDto> {
    return this.conversationsService.clearGroupAvatar(
      user.sub,
      params.conversationId,
    );
  }

  @Post(':conversationId/members')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add members to a group conversation' })
  @ApiBody({
    schema: { $ref: getSchemaPath(AddGroupMembersDto) },
    examples: {
      default: {
        summary: 'Add registered users to a group',
        value: {
          participantIds: [
            '7d444840-9dc0-41d1-b245-5ffdce74fad2',
            '8e555951-aed1-42e2-8346-6aadece85be3',
          ],
        },
      },
    },
  })
  @ApiOkResponse({ type: GroupConversationResponseDto })
  @ApiBadRequestResponse({
    description:
      'The participant list is invalid, duplicated, or self-referential.',
  })
  @ApiForbiddenResponse({
    description: 'The member is not allowed to add group members.',
  })
  @ApiNotFoundResponse({
    description:
      'The group is inaccessible, or one or more selected users are unavailable.',
  })
  @ApiConflictResponse({
    description:
      'A selected user is already a member or the group member limit would be exceeded.',
  })
  addGroupMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationParamsDto,
    @Body() input: AddGroupMembersDto,
  ): Promise<GroupConversationResponseDto> {
    return this.conversationsService.addGroupMembers(
      user.sub,
      params.conversationId,
      input,
    );
  }

  @Delete(':conversationId/members/:memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member from a group conversation' })
  @ApiNoContentResponse({ description: 'The member was removed.' })
  @ApiBadRequestResponse({
    description: 'Use the leave endpoint to remove yourself.',
  })
  @ApiForbiddenResponse({
    description: 'The member is not allowed to remove the selected member.',
  })
  @ApiNotFoundResponse({
    description:
      'The group is inaccessible or the selected membership does not exist.',
  })
  @ApiConflictResponse({
    description: 'The group owner cannot be removed.',
  })
  removeGroupMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: GroupMemberParamsDto,
  ): Promise<void> {
    return this.conversationsService.removeGroupMember(
      user.sub,
      params.conversationId,
      params.memberId,
    );
  }

  @Patch(':conversationId/members/:memberId/role')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Promote or demote a group member' })
  @ApiBody({
    schema: { $ref: getSchemaPath(UpdateGroupMemberRoleDto) },
    examples: {
      default: {
        summary: 'Promote a member to admin',
        value: { role: 'admin' },
      },
    },
  })
  @ApiOkResponse({ type: GroupConversationResponseDto })
  @ApiBadRequestResponse({
    description: 'The requested role is invalid.',
  })
  @ApiForbiddenResponse({
    description: 'Only the group owner can change member roles.',
  })
  @ApiNotFoundResponse({
    description:
      'The group is inaccessible or the selected membership does not exist.',
  })
  @ApiConflictResponse({
    description: 'The owner role can only change through ownership transfer.',
  })
  updateGroupMemberRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: GroupMemberParamsDto,
    @Body() input: UpdateGroupMemberRoleDto,
  ): Promise<GroupConversationResponseDto> {
    return this.conversationsService.updateGroupMemberRole(
      user.sub,
      params.conversationId,
      params.memberId,
      input,
    );
  }

  @Post(':conversationId/transfer-ownership')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transfer ownership of a group conversation' })
  @ApiBody({
    schema: { $ref: getSchemaPath(TransferGroupOwnershipDto) },
    examples: {
      default: {
        summary: 'Choose an existing member as the new owner',
        value: { newOwnerId: PARTICIPANT_ID_EXAMPLE },
      },
    },
  })
  @ApiOkResponse({ type: GroupConversationResponseDto })
  @ApiBadRequestResponse({
    description: 'The owner must select another member.',
  })
  @ApiForbiddenResponse({
    description: 'Only the current group owner can transfer ownership.',
  })
  @ApiNotFoundResponse({
    description:
      'The group is inaccessible or the selected membership does not exist.',
  })
  transferGroupOwnership(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationParamsDto,
    @Body() input: TransferGroupOwnershipDto,
  ): Promise<GroupConversationResponseDto> {
    return this.conversationsService.transferGroupOwnership(
      user.sub,
      params.conversationId,
      input,
    );
  }

  @Post(':conversationId/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Leave a group conversation' })
  @ApiNoContentResponse({ description: 'The member left the group.' })
  @ApiNotFoundResponse({
    description:
      'The group conversation is missing or the user is not a member.',
  })
  @ApiConflictResponse({
    description: 'The owner must transfer ownership or delete the group.',
  })
  leaveGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationParamsDto,
  ): Promise<void> {
    return this.conversationsService.leaveGroup(
      user.sub,
      params.conversationId,
    );
  }

  @Delete(':conversationId/for-me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a direct chat for the signed-in user only',
    description:
      'Hides the chat from all your lists and clears your current history. The other participant is unaffected. Clears archive/pin/favorite, preserves mute. A new message from either participant restores the chat without restoring cleared history. Repeating while hidden is a no-op. No request body.',
  })
  @ApiOkResponse({ type: DeleteDirectChatResponseDto })
  @ApiBadRequestResponse({
    description:
      'Invalid ID or a group conversation (CONVERSATION_DIRECT_REQUIRED).',
  })
  @ApiNotFoundResponse({
    description: 'Conversation missing or caller is not a member.',
  })
  deleteForMe(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationParamsDto,
  ): Promise<DeleteDirectChatResponseDto> {
    return this.conversationsService.deleteForMe(
      user.sub,
      params.conversationId,
    );
  }

  @Delete(':conversationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a group conversation' })
  @ApiNoContentResponse({ description: 'The group was deleted.' })
  @ApiForbiddenResponse({
    description: 'Only the group owner can delete the group.',
  })
  @ApiNotFoundResponse({
    description:
      'The group conversation is missing or the user is not a member.',
  })
  deleteGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationParamsDto,
  ): Promise<void> {
    return this.conversationsService.deleteGroup(
      user.sub,
      params.conversationId,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List the signed-in user conversations' })
  @ApiOkResponse({ type: ConversationListResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListConversationsQueryDto,
  ): Promise<ConversationListResponseDto> {
    return this.conversationsService.list(
      user.sub,
      query.limit,
      query.cursor,
      query.archived,
    );
  }

  @Get('archived')
  @ApiOperation({ summary: "List the signed-in user's archived conversations" })
  @ApiOkResponse({ type: ConversationListResponseDto })
  @ApiBadRequestResponse({
    description: 'The archived-conversation cursor or limit is invalid.',
  })
  listArchived(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListArchivedConversationsQueryDto,
  ): Promise<ConversationListResponseDto> {
    return this.conversationsService.listArchived(
      user.sub,
      query.limit,
      query.cursor,
    );
  }

  @Get('favorites')
  @ApiOperation({ summary: "List the signed-in user's favorite conversations" })
  @ApiOkResponse({ type: ConversationListResponseDto })
  @ApiBadRequestResponse({
    description: 'The favorites cursor, archive filter, or limit is invalid.',
  })
  listFavorites(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListFavoriteConversationsQueryDto,
  ): Promise<ConversationListResponseDto> {
    return this.conversationsService.listFavorites(
      user.sub,
      query.limit,
      query.cursor,
      query.archived,
    );
  }

  @Get(':conversationId')
  @ApiOperation({ summary: 'Get a conversation by ID' })
  @ApiOkResponse({ schema: conversationResponseSchema })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationParamsDto,
  ): Promise<ConversationResponseDto> {
    return this.conversationsService.get(user.sub, params.conversationId);
  }
}
