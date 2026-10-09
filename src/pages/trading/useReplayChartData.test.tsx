// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountsApi } from "../../services/api/accounts.ts";
import { api } from "../../services/api.ts";
import { queryKeys } from "../../services/queries.ts";
import { useTradingStore } from "../../services/store.tsx";
import { toast } from "../../services/toast.ts";
import { useReplayChartData } from "./useReplayChartData.ts";

const initialStoreState = useTradingStore.getState();

function ReplayProbe({ accountId }: { accountId: string }) {
  useReplayChartData(accountId);
  return null;
}

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  useTradingStore.setState(initialStoreState, true);
});

describe("useReplayChartData", () => {
  it("api-type-contract-repair.QUERY_LAYER.2-1 keeps replay active while the session is loading", () => {
    vi.spyOn(api, "replayGetSession").mockReturnValue(
      new Promise<Awaited<ReturnType<typeof api.replayGetSession>>>(() => {}),
    );
    const stopReplay = vi.spyOn(accountsApi, "replayStop").mockResolvedValue(undefined);
    const warn = vi.spyOn(toast, "warning").mockImplementation(() => undefined);
    useTradingStore.setState({
      isReplaying: true,
      replaySessionDate: "2026-01-01",
      replayCursorTimestamp: Date.UTC(2026, 0, 1),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { unmount } = render(
      <ReplayProbe accountId="demo-account" />,
      { wrapper: createWrapper(client) },
    );

    expect(useTradingStore.getState().isReplaying).toBe(true);
    expect(stopReplay).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    unmount();
    client.clear();
  });

  it("api-type-contract-repair.QUERY_LAYER.2-1 stops and clears replay when no session exists", async () => {
    vi.spyOn(api, "replayGetSession").mockResolvedValue(null);
    const stopReplay = vi.spyOn(accountsApi, "replayStop").mockResolvedValue(undefined);
    const warn = vi.spyOn(toast, "warning").mockImplementation(() => undefined);
    useTradingStore.setState({
      isReplaying: true,
      replaySessionDate: "2026-01-01",
      replayCursorTimestamp: Date.UTC(2026, 0, 1),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let unsubscribe: () => void = () => {};
    const replayStopped = new Promise<void>((resolve) => {
      unsubscribe = useTradingStore.subscribe((state) => {
        if (!state.isReplaying) {
          unsubscribe();
          resolve();
        }
      });
    });
    let unmount: () => void = () => undefined;

    await act(async () => {
      ({ unmount } = render(
        <ReplayProbe accountId="demo-account" />,
        { wrapper: createWrapper(client) },
      ));
    });
    await act(async () => {
      await replayStopped;
    });
    unsubscribe();

    expect(useTradingStore.getState().isReplaying).toBe(false);
    expect(useTradingStore.getState().replaySessionDate).toBeNull();
    expect(useTradingStore.getState().replayCursorTimestamp).toBeNull();
    expect(stopReplay).toHaveBeenCalledWith("demo-account", "2026-01-01");
    expect(warn).toHaveBeenCalledWith(
      "Replay unavailable",
      "No replay session found for 2026-01-01",
    );

    unmount();
    client.clear();
  });

  it("api-type-contract-repair.QUERY_LAYER.2-1 stops a cached empty replay only once in StrictMode", () => {
    const stopReplay = vi.spyOn(accountsApi, "replayStop").mockResolvedValue(undefined);
    const warn = vi.spyOn(toast, "warning").mockImplementation(() => undefined);
    useTradingStore.setState({
      isReplaying: true,
      replaySessionDate: "2026-01-01",
      replayCursorTimestamp: Date.UTC(2026, 0, 1),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.replay.session("demo-account", "2026-01-01"), null);

    const { unmount } = render(
      <StrictMode>
        <ReplayProbe accountId="demo-account" />
      </StrictMode>,
      { wrapper: createWrapper(client) },
    );

    expect(useTradingStore.getState().isReplaying).toBe(false);
    expect(stopReplay).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    unmount();
    client.clear();
  });
});
