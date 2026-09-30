/**
 * ts-ext-resolve.mjs — a `node:module` resolve hook for the test suite.
 *
 * The backend's own modules import each other WITHOUT a file extension
 * (`import { verifyEmbedToken } from './user-store'`), which is correct for the
 * compiled CommonJS output but unresolvable by Node's ESM loader — including the
 * type-stripping loader `node --test` uses for the .ts test files themselves.
 * That is exactly why every existing offline suite targets a deliberately
 * import-free module (`*-core.ts`, and the few leaf services): it is the only
 * thing `node --test` can load on the host.
 *
 * This hook removes that restriction so a test can load the real WIRING module
 * (embed-proxy + user-store) and exercise it offline, without a Docker daemon and
 * without depending on a `dist/` build that could silently be stale.
 *
 * Deliberately minimal: only RELATIVE specifiers that failed to resolve are
 * retried with a `.ts` (then `/index.ts`) suffix. Nothing else is rewritten, a
 * genuinely missing module still fails, and no bare/absolute specifier is
 * touched.
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    const code = err && err.code;
    if (code !== 'ERR_MODULE_NOT_FOUND') throw err;
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw err;
    try {
      return await next(`${specifier}.ts`, context);
    } catch (tsErr) {
      if (tsErr && tsErr.code === 'ERR_MODULE_NOT_FOUND') {
        return await next(`${specifier}/index.ts`, context);
      }
      throw tsErr;
    }
  }
}
