import { Body, Controller, Post } from '@nestjs/common';
import { SermonsService } from './sermons.service';

/** Media→notes: enqueue a transcription job from a URL (yt-dlp in the worker). */
@Controller('media')
export class MediaController {
  constructor(private readonly sermons: SermonsService) {}

  @Post('transcribe')
  async transcribe(
    @Body()
    body?: { url?: unknown; style?: unknown; speaker?: string; date?: string; title?: string },
  ) {
    const job = await this.sermons.transcribeUrl(body ?? {});
    return { id: job.id, status: job.status, style: job.style, sourceUrl: job.sourceUrl };
  }
}
