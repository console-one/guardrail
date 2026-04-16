import { Constrainable } from '../constraints/constraint.js';
import { Unit } from '../constraints/unit.js';
import { LimitBuilderExtension } from './limit.js';
import { ResourceRelationBuilder } from './resourcerelation.js';

export class GranularitySpecifier {
  terms: string[];

  constructor(public resourceRelationBuilder: ResourceRelationBuilder) {
    this.terms = [];
  }

  per(...terms: string[]): this {
    this.terms = this.terms.concat(terms);
    return this;
  }

  as(name: string): LimitBuilderExtension {
    const constrainable = new Constrainable(
      new Unit(this.terms, this.resourceRelationBuilder.limitBuilder.constrainedTerm, name),
      this.resourceRelationBuilder.relation,
      this.resourceRelationBuilder.limit,
      `${name}:${this.resourceRelationBuilder.relation.name}:${this.resourceRelationBuilder.limit}`
    );
    this.resourceRelationBuilder.limitBuilder.constraints.push(constrainable);
    return new LimitBuilderExtension(this.resourceRelationBuilder.limitBuilder);
  }

  build(
    name: string = this.resourceRelationBuilder.limitBuilder.constrainedTerm +
      'per' +
      this.terms.join(',')
  ): LimitBuilderExtension {
    return this.as(name);
  }
}
