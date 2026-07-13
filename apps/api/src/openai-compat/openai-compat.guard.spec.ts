import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAiCompatGuard } from './openai-compat.guard';

function contextWith(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: authorization ? { authorization } : {} }),
    }),
  } as unknown as ExecutionContext;
}

const guard = new OpenAiCompatGuard();
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.OPENAI_COMPAT_API_KEY;
  process.env.OPENAI_COMPAT_API_KEY = 'test-key-123';
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_COMPAT_API_KEY;
  else process.env.OPENAI_COMPAT_API_KEY = savedKey;
});

describe('OpenAiCompatGuard', () => {
  it('passes with the correct bearer key', () => {
    expect(guard.canActivate(contextWith('Bearer test-key-123'))).toBe(true);
  });

  it('401s with a wrong key', () => {
    expect(() => guard.canActivate(contextWith('Bearer nope'))).toThrow(
      UnauthorizedException,
    );
  });

  it('401s with no authorization header', () => {
    expect(() => guard.canActivate(contextWith(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('fails closed when OPENAI_COMPAT_API_KEY is unset', () => {
    delete process.env.OPENAI_COMPAT_API_KEY;
    expect(() => guard.canActivate(contextWith('Bearer test-key-123'))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(contextWith('Bearer undefined'))).toThrow(
      UnauthorizedException,
    );
  });
});
