import { useCallback, useRef } from 'react'

/**
 * Keeps a callback's identity stable while always invoking its latest implementation.
 * This lets memoized list rows skip renders when the parent updates unrelated state.
 */
export function useStableCallback<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
): (...args: TArgs) => TReturn {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...args: TArgs) => ref.current(...args), [])
}
