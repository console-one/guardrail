import { Constrainable } from '../constraints/constraint';
import { Unit } from '../constraints/unit';
import { LimitBuilderExtension } from './limit';
import { ResourceRelationBuilder } from './resourcerelation';

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
