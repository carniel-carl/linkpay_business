import { config } from "zod/v4/core"

// Runs before any page code. The Content-Security-Policy has no 'unsafe-eval' (src/proxy.ts), and zod would
// otherwise probe for eval with `new Function` when it builds its first object schema: the probe is caught, but
// the browser still reports it as a CSP violation. Without eval zod uses its ordinary parser, plenty for forms.
config({ jitless: true })
