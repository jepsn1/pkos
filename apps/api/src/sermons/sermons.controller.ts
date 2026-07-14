import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { SermonMeta } from './sermons.repo';
import { SermonsService, type UploadedAudio } from './sermons.service';

/** Sermon audio can be long; whole-file buffer capped here. */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

@Controller('sermons')
export class SermonsController {
  constructor(private readonly sermons: SermonsService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  async upload(@UploadedFile() file?: UploadedAudio, @Body() meta?: SermonMeta) {
    // multipart text fields (speaker/date/title) arrive on the body
    return this.sermons.upload(file, meta ?? {});
  }

  @Get()
  async list() {
    return this.sermons.list();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.sermons.get(id);
  }
}
