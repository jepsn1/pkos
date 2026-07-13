import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { OpenAiCompatController } from './openai-compat.controller';
import { OpenAiCompatService } from './openai-compat.service';

@Module({
  imports: [ChatModule],
  controllers: [OpenAiCompatController],
  providers: [OpenAiCompatService],
})
export class OpenAiCompatModule {}
