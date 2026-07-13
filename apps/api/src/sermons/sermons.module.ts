import { Module } from '@nestjs/common';
import path from 'node:path';
import { db } from '../db';
import {
  DrizzleSermonRepo,
  DrizzleTranscriptSearch,
  SERMON_REPO,
  TRANSCRIPT_SEARCH,
} from './sermons.repo';
import { SermonsController } from './sermons.controller';
import { SermonsService, UPLOADS_PATH } from './sermons.service';

// Dev default: gitignored dir inside the repo. Prod: /uploads (compose mounts
// /srv/data/uploads/pkos), set via UPLOADS_PATH in root .env.
const uploadsPath =
  process.env.UPLOADS_PATH ?? path.resolve(__dirname, '../../../../.uploads');

@Module({
  controllers: [SermonsController],
  providers: [
    SermonsService,
    { provide: UPLOADS_PATH, useValue: uploadsPath },
    { provide: SERMON_REPO, useValue: new DrizzleSermonRepo(db) },
    { provide: TRANSCRIPT_SEARCH, useValue: new DrizzleTranscriptSearch(db) },
  ],
  exports: [TRANSCRIPT_SEARCH],
})
export class SermonsModule {}
