import { createAuthClient } from 'better-auth/react'
import {
  emailOTPClient,
  inferAdditionalFields,
  oneTimeTokenClient,
  usernameClient,
} from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  plugins: [
    usernameClient(),
    emailOTPClient(),
    oneTimeTokenClient(),
    inferAdditionalFields({
      user: {
        bio: { type: 'string', required: false, input: true, returned: true },
      },
    }),
  ],
})
