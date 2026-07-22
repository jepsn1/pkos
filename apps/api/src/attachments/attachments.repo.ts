import { desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { attachments } from '../db/schema';

export const ATTACHMENTS_REPO = 'ATTACHMENTS_REPO';

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  diskPath: string;
  itemId: string | null;
  created: Date;
}

export type NewAttachment = Omit<Attachment, 'id' | 'created'>;

/** Metadata store for uploaded originals. Faked in tests, Drizzle in prod. */
export interface AttachmentRepo {
  insert(a: NewAttachment): Promise<Attachment>;
  getById(id: string): Promise<Attachment | null>;
  findBySha(sha256: string): Promise<Attachment | null>;
  listByItem(itemId: string): Promise<Attachment[]>;
}

const COLUMNS = {
  id: attachments.id,
  filename: attachments.filename,
  mime: attachments.mime,
  size: attachments.size,
  sha256: attachments.sha256,
  diskPath: attachments.diskPath,
  itemId: attachments.itemId,
  created: attachments.created,
};

export class DrizzleAttachmentRepo implements AttachmentRepo {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async insert(a: NewAttachment): Promise<Attachment> {
    const [row] = await this.db.insert(attachments).values(a).returning(COLUMNS);
    return row;
  }

  async getById(id: string): Promise<Attachment | null> {
    const [row] = await this.db.select(COLUMNS).from(attachments).where(eq(attachments.id, id));
    return row ?? null;
  }

  async findBySha(sha256: string): Promise<Attachment | null> {
    const [row] = await this.db
      .select(COLUMNS)
      .from(attachments)
      .where(eq(attachments.sha256, sha256));
    return row ?? null;
  }

  async listByItem(itemId: string): Promise<Attachment[]> {
    return this.db
      .select(COLUMNS)
      .from(attachments)
      .where(eq(attachments.itemId, itemId))
      .orderBy(desc(attachments.created));
  }
}
