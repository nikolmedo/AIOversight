/**
 * Compile-time guard against the renderer's ambient quota types
 * (`src/renderer/quota-types.d.ts`) drifting from the main-process source of
 * truth (`./types.ts`). Both files are hand-maintained duplicates — this
 * module has no runtime behavior, it exists purely so a shape mismatch is a
 * `tsc` error instead of a silent gap hidden by `skipLibCheck: true`.
 *
 * Checked in both directions so a required field added to only one side, or a
 * field whose type narrows/widens incompatibly on only one side, fails to
 * compile (verified empirically: making `QuotaBucket.used` non-nullable in
 * only the ambient copy breaks `tsc --noEmit` and names this file).
 *
 * Known limitation: this is a structural `extends` check, so it does NOT
 * catch an *optional* field going missing on one side, or optional-vs-optional
 * drift generally — a missing/extra optional property doesn't affect
 * assignability in either direction (verified empirically: dropping
 * `needsLogin?` from the ambient copy produced zero errors here). That
 * specific historical bug (`tray-popup-global.d.ts` silently missing
 * `needsLogin`) would have to surface some other way, e.g. a real call site
 * using the field, as it did.
 *
 * `tsconfig.json`'s `include: ["src/**\/*.ts"]` compiles every `.d.ts` under
 * `src/renderer/` into the same program as `src/main/**`, so the ambient
 * globals declared in `quota-types.d.ts` (`QuotaBucket`, `QuotaSnapshot`,
 * `SpendTile`, `BucketPref`, `ConnectorMetadata`, ...) are visible here
 * without any import or triple-slash directive.
 */
import {
  QuotaSnapshot as MainQuotaSnapshot,
  QuotaBucket as MainQuotaBucket,
  SpendTile as MainSpendTile,
  BucketPref as MainBucketPref,
  ConnectorMetadata as MainConnectorMetadata,
  MAX_STARRED_PER_CONNECTOR as MAIN_MAX_STARRED_PER_CONNECTOR,
} from './types';

type AssertAssignable<Target, Source extends Target> = Source;

/**
 * `MAX_STARRED_PER_CONNECTOR` is duplicated in `src/renderer/quota-view.ts`
 * (a non-module renderer script — renderer code can't `import` from
 * `main/**`) with only a "keep in sync" comment. Ambient globals declared by
 * a non-module script are visible to every file in the same `tsc` program,
 * module or not, so the same `AssertAssignable` constraint trick used for
 * every other cross-boundary type above catches the two `const`s drifting —
 * a `const` without a wider type annotation keeps its literal type (`2`, not
 * `number`) even when read from another file, so this only compiles when
 * both sides are the exact same literal. Verified empirically: changing
 * either side's `2` to a different literal breaks both lines below.
 */
export type _MaxStarredPerConnectorParityAB = AssertAssignable<
  typeof MAX_STARRED_PER_CONNECTOR,
  typeof MAIN_MAX_STARRED_PER_CONNECTOR
>;
export type _MaxStarredPerConnectorParityBA = AssertAssignable<
  typeof MAIN_MAX_STARRED_PER_CONNECTOR,
  typeof MAX_STARRED_PER_CONNECTOR
>;

// Renderer ambient type -> main type, and back.
export type _SnapshotParityAB = AssertAssignable<QuotaSnapshot, MainQuotaSnapshot>;
export type _SnapshotParityBA = AssertAssignable<MainQuotaSnapshot, QuotaSnapshot>;

export type _BucketParityAB = AssertAssignable<QuotaBucket, MainQuotaBucket>;
export type _BucketParityBA = AssertAssignable<MainQuotaBucket, QuotaBucket>;

export type _SpendTileParityAB = AssertAssignable<SpendTile, MainSpendTile>;
export type _SpendTileParityBA = AssertAssignable<MainSpendTile, SpendTile>;

export type _BucketPrefParityAB = AssertAssignable<BucketPref, MainBucketPref>;
export type _BucketPrefParityBA = AssertAssignable<MainBucketPref, BucketPref>;

export type _ConnectorMetadataParityAB = AssertAssignable<ConnectorMetadata, MainConnectorMetadata>;
export type _ConnectorMetadataParityBA = AssertAssignable<MainConnectorMetadata, ConnectorMetadata>;
