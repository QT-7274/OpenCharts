export class DemoUnsupportedError extends Error {
  readonly code = "DEMO_UNSUPPORTED";

  constructor(readonly capability: string) {
    super(`Demo mode does not support ${capability}`);
    this.name = "DemoUnsupportedError";
  }
}

export function unsupported(capability: string): Promise<never> {
  return Promise.reject(new DemoUnsupportedError(capability));
}
