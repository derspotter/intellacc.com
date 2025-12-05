/* tslint:disable */
/* eslint-disable */
export function init_logging(): void;
export class MlsClient {
  free(): void;
  [Symbol.dispose](): void;
  create_group(group_id_bytes: Uint8Array): Uint8Array;
  create_identity(identity_name: string): string;
  restore_identity(credential_bytes: Uint8Array, bundle_bytes: Uint8Array, signature_key_bytes: Uint8Array): void;
  get_credential_bytes(): Uint8Array;
  get_key_package_bytes(): Uint8Array;
  get_signature_keypair_bytes(): Uint8Array;
  get_key_package_bundle_bytes(): Uint8Array;
  constructor();
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_mlsclient_free: (a: number, b: number) => void;
  readonly mlsclient_create_group: (a: number, b: number, c: number) => [number, number, number, number];
  readonly mlsclient_create_identity: (a: number, b: number, c: number) => [number, number, number, number];
  readonly mlsclient_get_credential_bytes: (a: number) => [number, number, number, number];
  readonly mlsclient_get_key_package_bundle_bytes: (a: number) => [number, number, number, number];
  readonly mlsclient_get_key_package_bytes: (a: number) => [number, number, number, number];
  readonly mlsclient_get_signature_keypair_bytes: (a: number) => [number, number, number, number];
  readonly mlsclient_new: () => number;
  readonly mlsclient_restore_identity: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
  readonly init_logging: () => void;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
