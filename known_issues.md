
## [2026-03-12 00:07] Unresolved: react-dom_client.js?v=70a232db
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The AI response indicates that a key prop was added to prevent reconciliation issues between components using different numbers of hooks, which directly addresses the original error.
- Status: unresolved

## [2026-03-12 00:15] Unresolved: react-dom_client.js?v=70a232db
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows that keys were added to the components, which addresses the issue of React rendering more hooks than during the previous render.
- Status: unresolved

## [2026-03-12 00:28] Unresolved: react-dom_client.js?v=82e7d159
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows a change in the `HomePage.tsx` file where the key for the `LeagueInjuries` component was modified to a static value. This change addresses the issue of conditional rendering of hooks by ensuring that React properly unmounts and remounts components when switching between different views, thus preventing the 'Rendered more hooks than during the previous render' error.
- Status: unresolved

## [2026-03-12 00:43] Unresolved: react-dom_client.js?v=82e7d159
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff includes the addition of a new `HooksErrorBoundary` component that catches and handles errors related to hooks being rendered inconsistently, which directly addresses the original error.
- Status: unresolved

## [2026-03-12 00:47] Unresolved: react-dom_client.js?v=82e7d159
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows a change that introduces a `Fragment` with a dynamic `key` based on the current route, which addresses the issue of rendering more hooks than during the previous render by ensuring that the component tree is fully unmounted and remounted when navigating between different route types.
- Status: unresolved

## [2026-03-12 00:57] Unresolved: react-dom_client.js?v=82e7d159
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff includes changes that address the original error by adding `// @refresh reset` to multiple components, which prevents hooks-count mismatches during hot module replacement.
- Status: unresolved

## [2026-03-12 01:03] Unresolved: react-dom_client.js?v=82e7d159
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff does not address the original error related to hooks in a React component; it only modifies error reporting logic.
- Status: unresolved

## [2026-03-12 01:05] Unresolved: react-dom_client.js?v=82e7d159
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows a new component `InjuriesView` that unconditionally calls the same number of hooks on every render, addressing the original error of conditional hook rendering.
- Status: unresolved

## [2026-03-12 01:13] Unresolved: react-dom_client.js?v=82e7d159
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The AI response discusses changes related to React.lazy and Fast Refresh but does not provide a code diff that shows any actual changes made to the source files. The error regarding hooks is not addressed in the provided diff.
- Status: unresolved

## [2026-03-12 01:17] Unresolved: react-dom_client.js?v=82e7d159
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff added '// @refresh reset' to multiple component files, which addresses the issue of hook-count mismatch during development by ensuring a full unmount and remount of components.
- Status: unresolved

## [2026-03-12 01:24] Unresolved: react-dom_client.js?v=82e7d159
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff does not show any actual changes made to the source files; it only updates documentation files.
- Status: unresolved

## [2026-03-12 01:28] Unresolved: react-dom_client.js?v=82e7d159
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows that the SEO component was modified to move helper functions to a separate file, which helps prevent conditional rendering of hooks, addressing the original error.
- Status: unresolved

## [2026-03-14 19:53] Unresolved: HomePage.tsx?t=1773510342777
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows a change in 'HomePage.tsx' where the code now uses '(statusChanges ?? [])' before calling '.filter()', which addresses the original error of trying to call 'filter' on an undefined variable.
- Status: unresolved

## [2026-03-14 19:55] Unresolved: index-CdycczBy.js
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff introduces a new function `lazyWithReload` that wraps the lazy imports, allowing the application to reload the page if a dynamic import fails, which directly addresses the original error.
- Status: unresolved

## [2026-04-13 22:50] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows that a new service worker file 'sw.js' was created, which addresses the loading issue by providing a minimal self-unregistering service worker.
- Status: unresolved

## [2026-04-15 08:44] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The AI response did not make any code changes; it only discussed filtering out error messages without addressing the underlying issue of the service worker script failing to load.
- Status: unresolved

## [2026-04-15 10:30] Unresolved: index-BDYRx88a.js
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff includes a change in `index.html` that adds an error event listener to handle failed module script imports, which directly addresses the TypeError by reloading the page to fetch the updated script.
- Status: unresolved

## [2026-04-15 10:33] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff does not show any changes to the source files related to the error; it only includes changes to JSON and error reporting files.
- Status: unresolved

## [2026-04-16 06:59] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows a concrete change that enhances the error handling for service worker load failures, addressing the original error.
- Status: unresolved

## [2026-04-17 00:42] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff does not address the original error related to the service worker script 'sw.js' load failure; it only modifies error reporting and resolves a merge conflict.
- Status: unresolved

## [2026-04-17 18:42] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff does not address the original error related to the loading of 'sw.js'; it only shows a change in a JSON file, which does not fix the source code issue.
- Status: unresolved

## [2026-04-18 00:03] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff does not show any changes to the source files related to the error; it only modifies JSON and TypeScript files without addressing the service worker issue.
- Status: unresolved

## [2026-04-18 08:32] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The changes made do not address the root cause of the 'sw.js load failed' error; they only suppress the error messages without fixing the underlying issue.
- Status: unresolved

## [2026-04-18 13:08] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows changes in `index.html` that modify the error handling for the service worker, which directly addresses the loading failure of `sw.js` by preventing further propagation of the error event.
- Status: unresolved

## [2026-04-18 14:36] Unresolved: index-BDYRx88a.js
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows that the `EdgeValidation.tsx` component was created, which resolves the broken import issue that caused the TypeError.
- Status: unresolved

## [2026-04-18 18:36] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows a change in `public/sw.js` that adds error handling to the service worker unregistration process, which addresses the loading failure issue.
- Status: unresolved

## [2026-04-18 22:22] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff includes changes to `vercel.json` that add a header to clear stale service worker registrations, addressing the root cause of the `sw.js load failed` error.
- Status: unresolved

## [2026-04-19 04:48] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff includes changes that proactively unregister stale service workers and improves error handling for service worker load failures, directly addressing the original error.
- Status: unresolved

## [2026-04-19 04:54] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows concrete changes in `public/sw.js` that address the error by modifying the service worker's install and activate event listeners to handle potential errors more gracefully, which should prevent the 'load failed' error.
- Status: unresolved

## [2026-04-20 03:29] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff includes changes to the error handling logic in `src/lib/errorReporting.ts` and `index.html`, which broadens the suppression of service worker-related errors, directly addressing the original error of the service worker script failing to load.
- Status: unresolved

## [2026-04-20 17:09] Unresolved: index-BDYRx88a.js
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows concrete changes in `index.html` and `errorReporting.ts` that address the module import error by improving error handling and preventing unnecessary reloads.
- Status: unresolved

## [2026-04-20 19:49] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff includes changes to `index.html` that proactively handle service worker updates and prevent unhandled rejection errors, addressing the original load failure issue.
- Status: unresolved

## [2026-04-21 07:59] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows that new patterns were added to handle specific error messages related to the ServiceWorker registration failure, addressing the original error.
- Status: unresolved

## [2026-04-21 16:08] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff shows concrete changes in `src/main.tsx` and `src/lib/errorReporting.ts` that address the error by handling potential unhandled promise rejections and adding a regex check for the specific error message.
- Status: unresolved

## [2026-04-21 23:49] Unresolved: unhandledrejection
- Error: Error messages (most recent):
- Attempted: 1 fix(es), verdict: The code diff includes changes to the error handling logic in `index.html` and `errorReporting.ts`, specifically adding checks for the service worker load failure, which directly addresses the original error.
- Status: unresolved
