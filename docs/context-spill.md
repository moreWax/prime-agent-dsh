# Durable context spill and generic attachments

`src/durable-file-attachments.ts` uses the verbatim file primitives added in `@deepseek-ai/dsh-attachment` and `@deepseek-ai/dsh-attachment-local` **0.1.6** (this package currently pins `0.1.6-alpha.2`). It needs those versions or a later compatible release. Files are provider-neutral, content-addressed, atomically published with private modes, and verified during every read.

`spillContextText()` stores an oversized UTF-8 value and returns a bounded preview plus a serializable locator. If storage or quota enforcement fails it returns the exact value inline. Keep locators in durable session data. A later process can reconstruct `DurableFileAttachments` with the same absolute `dshHome` and call `resolveContextSpill()`.

Set `maxObjectBytes`, `maxTotalBytes`, and `maxObjects` at construction. Call `cleanup(liveReferences)` only with a complete set of live generic-file references. Cleanup does not touch images.
