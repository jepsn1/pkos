import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { ChatModule } from '../chat/chat.module';
import { WebuiImportModule } from '../webui-import/webui-import.module';
import { OpenAiCompatController } from './openai-compat.controller';
import { OpenAiCompatService } from './openai-compat.service';

@Module({
  imports: [ChatModule, WebuiImportModule, AttachmentsModule],
  controllers: [OpenAiCompatController],
  providers: [OpenAiCompatService],
})
export class OpenAiCompatModule {}
