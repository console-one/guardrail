import { AssessableJSON } from '../vendor/assessable/index.js';
import { ContractPolicyType } from '../constraints/contracttype.js';
import { SelectorSet } from '../selectors/selectorset.js';
import { LimitBuilder } from './limit.js';

// Entry point for the fluent contract DSL.
//
//   new ContractBuilder('openai/gpt')
//     .define(GPTModel)
//     .when(lookslike({ model: 'gpt-4.0' }), 'GPT-4-Used')
//       .set('[translation:tokens]')
//       .toLessThan(1000)
//       .per('[request:user]', '[request:day]')
//       .as('gpt4-daily')
//       .andSet('[translation:tokens]')
//       .toLessThan(100)
//       .per('[request:user]', '[request:hour]')
//       .as('gpt4-hourly')
//     .elseWhen(lookslike({ model: 'gpt-3.5' }), 'GPT-35-Used')
//       .set('[translation:tokens]')
//       .toLessThan(5000)
//       .per('[request:user]', '[request:day]')
//       .as('gpt35-daily')
//     .create();
//
// The output is a plain data structure — `policies` and `selectors` —
// that can be JSON-serialized, versioned, stored, and hot-reloaded.
export class ContractBuilder {
  name: string;
  version: number;
  policies: ContractPolicyType[];
  selectors: SelectorSet;

  constructor(name: string, version?: number) {
    this.name = name;
    this.version = version ?? new Date().getTime();
    this.policies = [];
    this.selectors = new SelectorSet();
  }

  define(selector: any): this {
    this.selectors.set(selector);
    return this;
  }

  when(assessableJSON: AssessableJSON, name?: string): LimitBuilder {
    const limitBuilder = new LimitBuilder(assessableJSON, this);
    if (name !== undefined && name !== null) limitBuilder.name = name;
    else if (assessableJSON.alias !== undefined) limitBuilder.name = assessableJSON.alias;
    else limitBuilder.name = JSON.stringify(assessableJSON);
    return limitBuilder;
  }

  build() {
    return {
      name: this.name,
      version: this.version,
      policies: this.policies.map(i => i),
      selectors: this.selectors.byIndex.map(i => i)
    };
  }
}
