import { Module } from '@nestjs/common';
import path from 'node:path';
import { db } from '../db';
import { AttachmentsController } from './attachments.controller';
import { ATTACHMENTS_REPO, DrizzleAttachmentRepo } from './attachments.repo';
import { ATTACHMENTS_PATH, AttachmentsService } from './attachments.service';

// Prod: /uploads/attachments (compose mounts /srv/data/uploads/pkos -> /uploads).
// Dev: gitignored dir inside the repo. Override via ATTACHMENTS_PATH.
const attachmentsPath =
  process.env.ATTACHMENTS_PATH ??
  path.join(process.env.UPLOADS_PATH ?? path.resolve(__dirname, '../../../../.uploads'), 'attachments');

@Module({
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    { provide: ATTACHMENTS_PATH, useValue: attachmentsPath },
    { provide: ATTACHMENTS_REPO, useValue: new DrizzleAttachmentRepo(db) },
  ],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
