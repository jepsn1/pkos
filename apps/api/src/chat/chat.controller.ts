import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ChatService } from './chat.service';

interface ChatBody {
  message?: unknown;
  conversationId?: unknown;
}

@Controller()
export class ChatController {
  constructor(private readonly chat: ChatService) {}

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
}
