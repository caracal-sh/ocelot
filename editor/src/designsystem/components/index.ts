// The components runtime: generate layers from the bundled shadcn parts, insert and refresh them, expand `<ds-*>` markup, count instances.
// The page builder lives next to it (`../page.ts`).

export { catalogRoot, componentNames, componentOfPart, getComponent, listComponents, prebuiltComponents, titleOf } from './catalog';
export { ComponentError, nearest, type ComponentErrorCode } from './errors';
export { createDsHtmlHook, DS_TAG_PREFIX, type DsHtmlHook } from './expand';
export { DS_ATTR, DS_PROPS_ATTR, generate, resolvePart, resolveProps, type GenerateRecord } from './generate';
export { ancestorParts, BLOCK_ATTR, blocksIn, countInstances, findInstances, insertComponents, readProps, schemeOf, SCHEME_ATTR, type InsertComponentsInput } from './instances';
export { flattenSpec, mergeNode, refreshInstances, type RefreshEnv, type RefreshOptions, type RefreshSide } from './refresh';
export { setArtboardScheme, type SchemeResult } from './scheme';
export { createComponentSet, loadComponentSet, type ComponentSet } from './set';
export { designSystemSpecimens, type Specimen } from './specimens';
export * from './types';
export { buildDesignSystemPage, fitDesignSystemPage, generatedArtboards, PAGE_NAME, SPECIMEN_ATTR, type PageEnv, type PageOptions } from '../page';
