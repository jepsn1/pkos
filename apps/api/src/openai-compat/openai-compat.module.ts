import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { WebuiImportModule } from '../webui-import/webui-import.module';
import { OpenAiCompatController } from './openai-compat.controller';
import { OpenAiCompatService } from './openai-compat.service';

@Module({
  imports: [ChatModule, WebuiImportModule],
  controllers: [OpenAiCompatController],
  providers: [OpenAiCompatService],
})
export class OpenAiCompatModule {}
