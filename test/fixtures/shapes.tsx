/**
 * Every function shape Ichor has to be able to see.
 *
 * This file is not run. It is read by `test/shapes.test.ts`, which asserts each
 * declaration below turns into a node with the right name and the right
 * reachability. Every shape here was invisible to the extractor at some point,
 * and each one that goes missing again is a function an agent can edit without
 * Ichor being able to say anything about it.
 */

export interface Options {
  id: string;
}

export class Base {}

// --- plain declarations ----------------------------------------------------

export function topLevel(): void {}

// An overload SIGNATURE has no body and must not take the implementation's key.
export function overloaded(value: string): string;
export function overloaded(value: number): string;
export function overloaded(value: unknown): string {
  return String(value);
}

export const arrow = (): void => {};

// --- functions inside functions --------------------------------------------

export function outer(): void {
  function inner(): void {}
  const innerArrow = (): void => {
    function deeper(): void {}
    deeper();
  };
  inner();
  innerArrow();
}

// --- object literals as namespaces -----------------------------------------

export const api = {
  create(): void {},
  list: (): void => {},
  notAFunction: 42,
};

// --- classes ---------------------------------------------------------------

export class Service extends Base {
  private secret = 'x';

  constructor(private readonly options: Options) {
    super();
  }

  get name(): string {
    return this.secret;
  }

  set name(value: string) {
    this.secret = value;
  }

  method(): void {}

  private hidden(): void {}

  handle = (): void => {};
}

// --- wrapped functions ------------------------------------------------------

const memo = <T,>(component: T): T => component;

export const Wrapped = memo(() => null);

// --- construction -----------------------------------------------------------

export function makesOne(): Service {
  return new Service({ id: '1' });
}

// --- anonymous default export -----------------------------------------------

export default function (): void {}
