// Re-derive all knowledge_items rows + embeddings from the canonical vault.
// Run: pnpm --filter @pkos/api rebuild-index (wipes derived table first).
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { GraphService } from '../graph/graph.service';
import { KnowledgeService } from '../knowledge/knowledge.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const { indexed } = await app.get(KnowledgeService).rebuild();
  console.log(`rebuild-index: ${indexed} notes indexed from vault`);
  // Second pass: knowledge_items wipe cascaded relationships away; restore from frontmatter.
  const { restored, skipped } = await app.get(GraphService).restoreFromVault();
  console.log(`rebuild-index: ${restored} relationships restored from frontmatter`);
  for (const s of skipped) console.warn(`rebuild-index: skipped edge ${s}`);
  await app.close();
}

main().catch((err) => {
  console.error('rebuild-index failed:', err);
  process.exit(1);
});
