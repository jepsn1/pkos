import { Module } from '@nestjs/common';
import { WEB_SEARCH_FETCH, WebSearchToolService } from './web-search-tools.service';

@Module({
  providers: [
    WebSearchToolService,
    // bind: undici's fetch throws "Illegal invocation" when called detached
    { provide: WEB_SEARCH_FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
  exports: [WebSearchToolService],
})
export class WebSearchModule {}
