import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { WEBUI_IMPORT_FETCH, WebuiImportService } from './webui-import.service';

@Module({
  imports: [AttachmentsModule],
  providers: [
    WebuiImportService,
    // bind: undici's fetch throws "Illegal invocation" when called detached
    { provide: WEBUI_IMPORT_FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
  exports: [WebuiImportService],
})
export class WebuiImportModule {}
