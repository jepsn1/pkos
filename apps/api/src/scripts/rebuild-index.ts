// Re-derive all knowledge_items rows + embeddings from the canonical vault.
// Run: pnpm --filter @pkos/api rebuild-index (wipes derived table first).
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { db } from '../db';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../knowledge/embedding.provider';
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
  // Same for sermon articles: restore sermon_jobs.article_item_id from
  // `source: sermon:<jobId>` frontmatter (article_path is primary, survives).
  const sermonsRelinked = await db.execute(sql`
    UPDATE sermon_jobs s SET article_item_id = k.id
    FROM (
      SELECT DISTINCT ON (source) source, id
      FROM knowledge_items
      WHERE source LIKE 'sermon:%'
      ORDER BY source, created DESC, updated DESC, path DESC
    ) k
    WHERE k.source = 'sermon:' || s.id
  `);
  console.log(`rebuild-index: ${sermonsRelinked.rowCount ?? 0} sermon articles re-linked`);
  // Second pass: knowledge_items wipe cascaded relationships away; restore from frontmatter.
  const { restored, skipped } = await app.get(GraphService).restoreFromVault();
  console.log(`rebuild-index: ${restored} relationships restored from frontmatter`);
  for (const s of skipped) console.warn(`rebuild-index: skipped edge ${s}`);

  // Re-embed transcript chunks in place — rebuild() only re-derives knowledge_items
  // from the vault, but transcript_chunks are derived from audio (not re-derivable
  // here). They must share the CURRENT embedding model's vector space, so on an
  // embedding-model swap (nomic → bge-m3) we re-embed each chunk from its stored
  // text. Picks up rows whose embedding was nulled by the dimension migration.
  const embedder = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
  const chunks = await db.execute(
    sql`SELECT id, text FROM transcript_chunks WHERE embedding IS NULL`,
  );
  let reembedded = 0;
  for (const row of chunks.rows as Array<{ id: string; text: string }>) {
    const vec = await embedder.embed(row.text);
    await db.execute(
      sql`UPDATE transcript_chunks SET embedding = ${`[${vec.join(',')}]`}::vector WHERE id = ${row.id}`,
    );
    reembedded++;
  }
  console.log(`rebuild-index: ${reembedded} transcript chunks re-embedded`);
  await app.close();
}

main().catch((err) => {
  console.error('rebuild-index failed:', err);
  process.exit(1);
});
