import { Module } from '@nestjs/common';
import { db } from '../db';
import { BibleService } from './bible.service';
import { BibleToolsService } from './bible-tools.service';
import { BIBLE_REPO, DrizzleBibleRepo } from './bible.repo';
import { BIBLE_SOURCE, BibelselskabetSource } from './bible-source';

/**
 * Verbatim scripture lookup (get_verse tool). Reads the authorized Danish 1992
 * text from bibelselskabet.dk and caches chapters locally so quotes are exact and
 * deterministic. See bible-source.ts for the source; bible.service.ts for caching.
 */
@Module({
  providers: [
    BibleService,
    BibleToolsService,
    { provide: BIBLE_REPO, useValue: new DrizzleBibleRepo(db) },
    // bind: undici's fetch throws "Illegal invocation" when called detached
    {
      provide: BIBLE_SOURCE,
      useValue: new BibelselskabetSource(globalThis.fetch.bind(globalThis)),
    },
  ],
  exports: [BibleToolsService],
})
export class BibleModule {}
