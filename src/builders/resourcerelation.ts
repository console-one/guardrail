import {
  ResourceRelation,
  ResourceRelationType,
  ResourceRelations
} from '../constraints/resourcerelation';
import { GranularitySpecifier } from './granularity';
import { LimitBuilder } from './limit';

export class ResourceRelationBuilder {
  limit: number = 0;
  relation!: ResourceRelation;

  constructor(public limitBuilder: LimitBuilder) {}

  toLessThan(num: number): GranularitySpecifier {
    this.relation = ResourceRelations[ResourceRelationType.LESS_THAN];
    this.limit = num;
    return new GranularitySpecifier(this);
  }

  toLessThanOrEqualTo(num: number): GranularitySpecifier {
    this.relation = ResourceRelations[ResourceRelationType.LESS_THAN_OR_EQUAL_TO];
    this.limit = num;
    return new GranularitySpecifier(this);
  }
}
