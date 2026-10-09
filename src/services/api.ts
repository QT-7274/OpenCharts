/**
 * Demo API facade.
 *
 * OpenCharts runs without a backend: all real data the terminal needs is served
 * by the in-browser demo layer (services/demo). The facade has an explicit
 * contract so unsupported capabilities fail loudly instead of becoming null.
 */
import { demoApi, unsupportedDemoApi } from "./demo/api.ts";
import type { OpenChartsApi, UnsupportedDemoApi } from "./api/contract.ts";

export const API_BASE = "";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// api-type-contract-repair.API_CONTRACT.1 api-type-contract-repair.API_CONTRACT.2
export const api: OpenChartsApi = demoApi;
export const unsupportedApi: UnsupportedDemoApi = unsupportedDemoApi;
