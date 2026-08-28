import { createStart } from '@tanstack/react-start'

import { errorShield } from './server/error-shield'

export const startInstance = createStart(() => ({
  functionMiddleware: [errorShield],
}))
