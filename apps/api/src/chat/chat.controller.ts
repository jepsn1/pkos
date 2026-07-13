import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ChatService } from './chat.service';
import { SaveService } from './save.service';

interface ChatBody {
  message?: unknown;
  conversationId?: unknown;
}

interface SaveBody {
  folder?: unknown;
  force?: unknown;
}

@Controller()
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly saver: SaveService,
  ) {}

  @Post('chat')
  async post(@Body() body: ChatBody) {
    const { message, conversationId } = body ?? {};
    if (typeof message !== 'string' || !message.trim()) {
      throw new BadRequestException('message required');
    }
    if (conversationId !== undefined && typeof conversationId !== 'string') {
      throw new BadRequestException('conversationId must be a string');
    }
    return this.chat.chat(message, conversationId);
  }

  @Get('conversations')
  async list() {
    return this.chat.listConversations();
  }

  @Get('conversations/:id')
  async get(@Param('id') id: string) {
    return this.chat.getConversation(id);
  }

  @Post('conversations/:id/save')
  async save(@Param('id') id: string, @Body() body: SaveBody) {
    const { folder, force } = body ?? {};
    if (folder !== undefined && typeof folder !== 'string') {
      throw new BadRequestException('folder must be a string');
    }
    if (force !== undefined && typeof force !== 'boolean') {
      throw new BadRequestException('force must be a boolean');
    }
    return this.saver.save(id, { folder, force });
  }
}
