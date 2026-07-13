import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { GraphService, MAX_DEPTH, type CreateEdgeRequest } from './graph.service';

@Controller()
export class GraphController {
  constructor(private readonly graph: GraphService) {}

  @Post('relationships')
  async create(@Body() body: CreateEdgeRequest) {
    return this.graph.createEdge(body ?? {});
  }

  @Delete('relationships/:id')
  async delete(@Param('id') id: string) {
    await this.graph.deleteEdge(id);
    return { deleted: id };
  }

  @Get('knowledge/:id/graph')
  async get(@Param('id') id: string, @Query('depth') depth?: string) {
    let n: number | undefined;
    if (depth !== undefined) {
      n = Number(depth);
      if (!Number.isInteger(n) || n < 1) {
        throw new BadRequestException(`depth must be a positive integer (capped at ${MAX_DEPTH})`);
      }
    }
    return this.graph.graph(id, n);
  }
}
