// Re-derive all knowledge_items rows + embeddings from the canonical vault.
// Run: pnpm --filter @pkos/api rebuild-index (wipes derived table first).
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { db } from '../db';
import { GraphService } from '../graph/graph.service';
import { KnowledgeService } from '../knowledge/knowledge.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const { indexed } = await app.get(KnowledgeService).rebuild();
  // Wipe nulled conversations.saved_item_id (FK on delete set null); restore the
  // pointers from the items' canonical `source: conversation:<id>` frontmatter.
  // Force-resaved conversations have several items with the same source — take newest.
  const relinked = await db.execute(sql`
    UPDATE conversations c SET saved_item_id = k.id
    FROM (
      SELECT DISTINCT ON (source) source, id
      FROM knowledge_items
      WHERE source LIKE 'conversation:%'
      ORDER BY source, created DESC, updated DESC, path DESC
    ) k
    WHERE k.source = 'conversation:' || c.id
  `);
  console.log(
    `rebuild-index: ${indexed} notes indexed from vault, ${relinked.rowCount ?? 0} conversations re-linked`,
  );
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
