import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'node:fs';
import { AttachmentsService, attachmentUrl, type StoredFile } from './attachments.service';
import { UPLOAD_PAGE_HTML } from './upload-page';

/** Slice of express.Response we use (avoids a @types/express dependency). */
type Response = NodeJS.WritableStream & {
  setHeader(name: string, value: string | number): void;
};

/** Whole-file buffer cap (docs/slides/images; big enough for a fat pptx). */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async upload(
    @UploadedFile() file?: StoredFile,
    @Body() body?: { item_id?: string },
  ) {
    if (!file?.originalname || !file.buffer?.length) {
      throw new BadRequestException('file required (multipart field "file")');
    }
    const a = await this.attachments.store(file, body?.item_id);
    return {
      id: a.id,
      filename: a.filename,
      mime: a.mime,
      size: a.size,
      item_id: a.itemId,
      url: attachmentUrl(a.id),
    };
  }

  // Declared before @Get(':id') so "upload" isn't captured as an :id param.
  @Get('upload')
  @Header('Content-Type', 'text/html; charset=utf-8')
  uploadPage(): string {
    return UPLOAD_PAGE_HTML;
  }

  @Get()
  async list(@Query('item') item?: string) {
    if (!item) throw new BadRequestException('query param "item" required');
    const rows = await this.attachments.listByItem(item);
    return {
      count: rows.length,
      attachments: rows.map((a) => ({
        id: a.id,
        filename: a.filename,
        mime: a.mime,
        size: a.size,
        url: attachmentUrl(a.id),
      })),
    };
  }

  @Get(':id')
  async download(@Param('id') id: string, @Res() res: Response) {
    const { attachment, absPath } = await this.attachments.get(id);
    res.setHeader('Content-Type', attachment.mime);
    res.setHeader('Content-Length', attachment.size);
    // inline so images/pdfs render in a browser/Obsidian; filename for downloads
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${attachment.filename.replace(/"/g, '')}"`,
    );
    createReadStream(absPath).pipe(res);
  }
}
