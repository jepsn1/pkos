import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { EmptyReadingError, VisionJobsService } from './vision-jobs.service';

/**
 * HTTP surface for the host-side Claude vision runner (#29). The runner lives on
 * the host (Claude Code isn't in the api container), so it talks to the api over
 * localhost: claim a job, then post the reading back. Routes live under /api.
 */
@Controller('vision/jobs')
export class VisionController {
  constructor(private readonly jobs: VisionJobsService) {}

  /** Claim the oldest pending job (→running). {} when the queue is empty. */
  @Get('next')
  async next() {
    const job = await this.jobs.claimNext();
    if (!job) return {};
    return {
      id: job.id,
      attachment_id: job.attachmentId,
      instructions: job.instructions,
      folder: job.folder,
    };
  }

  @Get(':id')
  async status(@Param('id') id: string) {
    const job = await this.jobs.get(id);
    if (!job) throw new NotFoundException(`no vision job ${id}`);
    return job;
  }

  /** Runner posts the reading → we ingest a note. Empty reading = job failed, no note. */
  @Post(':id/complete')
  @HttpCode(200)
  async complete(@Param('id') id: string, @Body() body: { text?: string }) {
    try {
      const { itemPath, title } = await this.jobs.complete(id, body?.text ?? '');
      return { ok: true, item_path: itemPath, title };
    } catch (err) {
      if (err instanceof EmptyReadingError) {
        return { ok: false, failed: true, reason: err.message };
      }
      throw err;
    }
  }

  @Post(':id/fail')
  @HttpCode(200)
  async fail(@Param('id') id: string, @Body() body: { error?: string }) {
    await this.jobs.fail(id, body?.error ?? 'unknown error');
    return { ok: true };
  }
}
