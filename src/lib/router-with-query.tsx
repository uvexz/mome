import { Fragment } from 'react'
import {
  QueryClientProvider,
  dehydrate as queryDehydrate,
  hydrate as queryHydrate,
} from '@tanstack/react-query'
import { isRedirect } from '@tanstack/router-core'
import type { AnyRouter } from '@tanstack/react-router'
import type {
  DehydratedState as QueryDehydratedState,
  QueryClient,
} from '@tanstack/react-query'

type DehydratedRouterQueryState = {
  dehydratedQueryClient: QueryDehydratedState
  queryStream: ReadableStream<QueryDehydratedState>
}

type AdditionalOptions = {
  WrapProvider?: (props: { children: React.ReactNode }) => React.JSX.Element
  handleRedirects?: boolean
}

export function routerWithQueryClient<TRouter extends AnyRouter>(
  router: TRouter,
  queryClient: QueryClient,
  additionalOpts?: AdditionalOptions,
): TRouter {
  const originalOptions = router.options

  router.options = {
    ...originalOptions,
    context: {
      ...originalOptions.context,
      queryClient,
    },
    Wrap: ({ children }) => {
      const OriginalWrap = originalOptions.Wrap ?? Fragment
      const content = (
        <QueryClientProvider client={queryClient}>
          <OriginalWrap>{children}</OriginalWrap>
        </QueryClientProvider>
      )

      if (additionalOpts?.WrapProvider) {
        const OuterWrapper = additionalOpts.WrapProvider
        return <OuterWrapper>{content}</OuterWrapper>
      }

      return content
    },
  }

  if (router.isServer) {
    const queryStream = createPushableStream<QueryDehydratedState>()
    let isDehydrated = false

    router.options.dehydrate = async () => {
      const originalData = await originalOptions.dehydrate?.()
      const dehydratedQueryClient = queryDehydrate(queryClient)
      isDehydrated = true
      router.serverSsr!.onRenderFinished(() => queryStream.close())

      return {
        ...originalData,
        dehydratedQueryClient,
        queryStream: queryStream.stream,
      }
    }

    const originalClientOptions = queryClient.getDefaultOptions()
    queryClient.setDefaultOptions({
      ...originalClientOptions,
      dehydrate: {
        shouldDehydrateQuery: () => true,
        ...originalClientOptions.dehydrate,
      },
    })

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'added' || !isDehydrated || queryStream.isClosed()) {
        return
      }

      queryStream.enqueue(
        queryDehydrate(queryClient, {
          shouldDehydrateQuery: (query) =>
            query.queryHash === event.query.queryHash &&
            (originalClientOptions.dehydrate?.shouldDehydrateQuery?.(query) ??
              true),
        }),
      )
    })

    router.serverSsrLifecycle ??= {}
    router.serverSsrLifecycle.onServerSsrAttach ??= []
    router.serverSsrLifecycle.onServerSsrAttach.push((serverSsr) => {
      serverSsr.onCleanup(() => unsubscribe())
    })
  } else {
    router.options.hydrate = async (
      dehydrated: DehydratedRouterQueryState,
    ) => {
      await originalOptions.hydrate?.(dehydrated)
      queryHydrate(queryClient, dehydrated.dehydratedQueryClient)

      const reader = dehydrated.queryStream.getReader()
      let result = await reader.read()
      while (!result.done) {
        queryHydrate(queryClient, result.value)
        result = await reader.read()
      }
    }

    if (additionalOpts?.handleRedirects ?? true) {
      const originalMutationCacheOptions = queryClient.getMutationCache().config
      queryClient.getMutationCache().config = {
        ...originalMutationCacheOptions,
        onError: (error, variables, onMutateResult, mutation, context) => {
          if (isRedirect(error)) {
            error.options._fromLocation = router.state.location
            return router.navigate(router.resolveRedirect(error).options)
          }
          return originalMutationCacheOptions.onError?.(
            error,
            variables,
            onMutateResult,
            mutation,
            context,
          )
        },
      }

      const originalQueryCacheOptions = queryClient.getQueryCache().config
      queryClient.getQueryCache().config = {
        ...originalQueryCacheOptions,
        onError: (error, query) => {
          if (isRedirect(error)) {
            error.options._fromLocation = router.state.location
            return router.navigate(router.resolveRedirect(error).options)
          }
          return originalQueryCacheOptions.onError?.(error, query)
        },
      }
    }
  }

  return router
}

function createPushableStream<T>() {
  let controller: ReadableStreamDefaultController<T>
  let closed = false
  const stream = new ReadableStream<T>({
    start(nextController) {
      controller = nextController
    },
  })

  return {
    stream,
    enqueue(value: T) {
      controller.enqueue(value)
    },
    close() {
      if (closed) return
      closed = true
      controller.close()
    },
    isClosed: () => closed,
  }
}
