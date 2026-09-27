// The few Node APIs the tests and fixture script use. @types/node isn't installed (the plugin
// must not use Node), so these are declared by hand; keep them to what's actually called.

declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
  export default test;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, regexp: RegExp, message?: string): void;
    throws(fn: () => unknown, error?: RegExp, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function readdirSync(path: string): string[];
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}
