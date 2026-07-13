import { Module } from '@nestjs/common';
import { db } from '../db';
import {
  EMBED_FETCH,
  EMBEDDING_PROVIDER,
  OllamaEmbeddingProvider,
} from './embedding.provider';
import { KnowledgeController } from './knowledge.controller';
import { DrizzleKnowledgeRepo, KNOWLEDGE_REPO } from './knowledge.repo';
import { KnowledgeService } from './knowledge.service';
import { GIT, realGitRunner, VAULT_PATH, VaultService } from './vault.service';

const vaultPath = process.env.VAULT_PATH ?? '/srv/data/knowledge';

@Module({
  controllers: [KnowledgeController],
  providers: [
    KnowledgeService,
    VaultService,
    { provide: VAULT_PATH, useValue: vaultPath },
    { provide: GIT, useValue: realGitRunner(vaultPath) },
    { provide: KNOWLEDGE_REPO, useValue: new DrizzleKnowledgeRepo(db) },
    { provide: EMBEDDING_PROVIDER, useClass: OllamaEmbeddingProvider },
    // bind: undici's fetch throws "Illegal invocation" when called detached
    { provide: EMBED_FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
  exports: [EMBEDDING_PROVIDER, KNOWLEDGE_REPO, VaultService, KnowledgeService],
})
export class KnowledgeModule {}
