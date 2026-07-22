import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  // Raise the JSON limit: Open WebUI inlines attached IMAGES as base64 in the
  // chat request, which blows past Express's ~100kb default (HTTP 413). Multipart
  // uploads are unaffected (multer keeps its own per-route fileSize limit).
  app.useBodyParser('json', { limit: '50mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '50mb' });
  // OpenAI-compatible surface lives at /v1 (clients hardcode it), not /api/v1
  app.setGlobalPrefix('api', { exclude: ['v1/models', 'v1/chat/completions'] });
  await app.listen(process.env.PORT ?? 3002);
}
void bootstrap();
