import { useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useAsyncState<T>(initialData: T | null = null) {
  const [state, setState] = useState<AsyncState<T>>({
    data: initialData,
    loading: false,
    error: null,
  });

  const start = (data: T | null = initialData) => {
    setState({ data, loading: true, error: null });
  };

  const succeed = (data: T) => {
    setState({ data, loading: false, error: null });
  };

  const fail = (error: unknown) => {
    setState({
      data: null,
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const reset = (data: T | null = initialData) => {
    setState({ data, loading: false, error: null });
  };

  const run = async (task: () => Promise<T>) => {
    start();
    try {
      const data = await task();
      succeed(data);
      return data;
    } catch (error) {
      fail(error);
      throw error;
    }
  };

  return { ...state, start, succeed, fail, reset, run };
}
