import { AssessableJSON } from '../vendor/assessable';
import { Constrainable } from './constraint';
import { SelectorSet } from '../selectors/selectorset';

// A named bundle of Constrainables plus the AssessableJSON that decides
// which requests the policy applies to. Multiple policies can coexist
// in a contract and are dispatched by order — the first matching
// `when` / `elseWhen` wins.
export class ContractPolicyType {
  constructor(
    public name: string,
    public version: number,
    public assessable: AssessableJSON,
    public constrainables: Constrainable[],
    public selectors: SelectorSet
  ) {}
}
