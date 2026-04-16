// Minimal structural JSON pattern matcher, vendored.
//
// Used by the contract DSL's `.when(lookslike({ model: 'gpt-4' }))` to
// decide which policy applies to an incoming request. Supports IS,
// IS_TYPE, EXISTS, and IS_IN operators, recursive object matching, and
// AND/OR composition.
//
// Why vendored: per the extraction playbook, cross-boundary deps get
// copied locally rather than turned into shared packages. Guardrail
// needs ~100 lines of pattern matching; the upstream assessable library
// is ~800 lines of pluggable operators, reporters, and a classifier
// registry. Vendoring keeps guardrail standalone-publishable and
// independent of upstream changes.

export type AssessableJSON = {
  condition: 'AND' | 'OR';
  requirements: Requirement[];
  alias?: string;
};

export type Requirement = [string, string, any] | AssessableJSON;

const SCHEMA_TYPES = new Set(['number', 'string', 'object', 'boolean', 'function', 'array', 'error']);

function recursivelyBuild(obj: any, path: string, requirements: Requirement[]): void {
  if (obj === null || obj === undefined) {
    requirements.push([path, 'IS', obj]);
    return;
  }
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    for (const key of Object.keys(obj)) {
      recursivelyBuild(obj[key], `${path}.${key}`, requirements);
    }
    return;
  }
  if (typeof obj === 'string' && SCHEMA_TYPES.has(obj)) {
    requirements.push([path, 'IS_TYPE', obj]);
    return;
  }
  requirements.push([path, 'IS', obj]);
}

export function lookslike(obj: any): AssessableJSON {
  const requirements: Requirement[] = [];
  recursivelyBuild(obj, '@', requirements);
  return { condition: 'AND', requirements };
}

export function and(...items: AssessableJSON[]): AssessableJSON {
  return { condition: 'AND', requirements: items };
}

export function or(...items: AssessableJSON[]): AssessableJSON {
  return { condition: 'OR', requirements: items };
}

function resolvePath(subject: any, path: string): any {
  const parts = path.replace(/^@\.?/, '').split('.').filter(Boolean);
  let cur = subject;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function isTripleRequirement(r: Requirement): r is [string, string, any] {
  return Array.isArray(r) && r.length === 3 && typeof r[0] === 'string' && typeof r[1] === 'string';
}

function evalTriple(r: [string, string, any], subject: any): boolean {
  const [path, op, expected] = r;
  const actual = resolvePath(subject, path);
  switch (op) {
    case 'IS':
      return actual === expected;
    case 'IS_TYPE':
      if (expected === 'array') return Array.isArray(actual);
      return typeof actual === expected;
    case 'EXISTS':
      return actual !== undefined && actual !== null;
    case 'IS_IN':
      return Array.isArray(expected) && expected.includes(actual);
    default:
      return false;
  }
}

function evalAssessable(a: AssessableJSON, subject: any): boolean {
  const results: boolean[] = [];
  for (const r of a.requirements) {
    if (isTripleRequirement(r)) {
      results.push(evalTriple(r, subject));
    } else {
      results.push(evalAssessable(r, subject));
    }
  }
  if (a.condition === 'OR') return results.some(Boolean);
  return results.every(Boolean);
}

// Compiles an AssessableJSON into a request-tester function. Each
// policy in a contract gets one at compile time; at request time the
// authorizer runs the testers in order and picks the first match.
export class StandardRapidTestGenerator {
  test(requirement: AssessableJSON): (subject: any) => Promise<boolean> {
    return async (subject: any) => {
      try {
        return evalAssessable(requirement, subject);
      } catch {
        return false;
      }
    };
  }
}
