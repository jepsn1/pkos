import { Module } from '@nestjs/common';
import { db } from '../db';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { GraphController } from './graph.controller';
import { GRAPH_RETRIEVAL } from './graph.retrieval';
import { GraphService } from './graph.service';
import { DrizzleRelationshipRepo, RELATIONSHIP_REPO } from './relationship.repo';

@Module({
  imports: [KnowledgeModule],
  controllers: [GraphController],
  providers: [
    GraphService,
    { provide: RELATIONSHIP_REPO, useValue: new DrizzleRelationshipRepo(db) },
    { provide: GRAPH_RETRIEVAL, useExisting: GraphService },
  ],
  exports: [GRAPH_RETRIEVAL, RELATIONSHIP_REPO, GraphService],
})
export class GraphModule {}
