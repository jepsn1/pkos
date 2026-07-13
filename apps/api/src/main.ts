import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // OpenAI-compatible surface lives at /v1 (clients hardcode it), not /api/v1
  app.setGlobalPrefix('api', { exclude: ['v1/models', 'v1/chat/completions'] });
  await app.listen(process.env.PORT ?? 3002);
}
void bootstrap();
