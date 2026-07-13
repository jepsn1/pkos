import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Bearer-key auth for the OpenAI-compatible surface. Key lives in
 * OPENAI_COMPAT_API_KEY; unset env fails closed (everything 401s).
 */
@Injectable()
export class OpenAiCompatGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const key = process.env.OPENAI_COMPAT_API_KEY;
    const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const auth = req.headers['authorization'];
    if (!key || auth !== `Bearer ${key}`) {
      throw new UnauthorizedException('invalid api key');
    }
    return true;
  }
}
