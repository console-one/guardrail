import { AssessableJSON, and, or } from '../vendor/assessable/index.js';
import { Constrainable } from '../constraints/constraint.js';
import { ContractPolicyType } from '../constraints/contracttype.js';
import { ContractBuilder } from './contract.js';
import { ResourceRelationBuilder } from './resourcerelation.js';

// Returned after `.as(name)` — lets you chain more constraints onto the
// same policy via `.andSet(...)`, start an alternative policy via
// `.elseWhen(...)`, or finalize the contract via `.create()`.
export class LimitBuilderExtension {
  constructor(public limitBuilder: LimitBuilder) {}

  andSet(name: string): ResourceRelationBuilder {
    this.limitBuilder.constrainedTerm = name;
    return new ResourceRelationBuilder(this.limitBuilder);
  }

  elseWhen(assessable: AssessableJSON, name?: string): LimitBuilder {
    const policy = new ContractPolicyType(
      this.limitBuilder.name,
      new Date().getTime(),
      this.limitBuilder.assessable,
      this.limitBuilder.constraints.map(i => i),
      this.limitBuilder.contractBuilder.selectors
    );

    this.limitBuilder.contractBuilder.policies.push(policy);
    this.limitBuilder.constraints = [];
    this.limitBuilder.assessable = assessable;

    if (name !== undefined && name !== null) this.limitBuilder.name = name;
    else if (assessable.alias !== undefined) this.limitBuilder.name = assessable.alias;
    else this.limitBuilder.name = JSON.stringify(assessable);

    return this.limitBuilder;
  }

  create() {
    const policy = new ContractPolicyType(
      this.limitBuilder.name,
      new Date().getTime(),
      this.limitBuilder.assessable,
      this.limitBuilder.constraints.map(i => i),
      this.limitBuilder.contractBuilder.selectors
    );
    this.limitBuilder.contractBuilder.policies.push(policy);
    return this.limitBuilder.contractBuilder.build();
  }
}

export class LimitBuilder {
  constrainedTerm: string = '';
  private _name: string = '';

  constructor(
    public assessable: AssessableJSON,
    public contractBuilder: ContractBuilder,
    public constraints: Constrainable[] = []
  ) {}

  set name(val: string) {
    this._name = val;
  }
  get name(): string {
    if (!this._name) this._name = JSON.stringify(this.assessable);
    return this._name;
  }

  and(assessable: AssessableJSON): this {
    this.assessable = and(this.assessable, assessable);
    return this;
  }

  or(assessable: AssessableJSON): this {
    this.assessable = or(this.assessable, assessable);
    return this;
  }

  set(name: string): ResourceRelationBuilder {
    this.constrainedTerm = name;
    return new ResourceRelationBuilder(this);
  }
}
