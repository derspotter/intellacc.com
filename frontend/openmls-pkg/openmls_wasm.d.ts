/* tslint:disable */
/* eslint-disable */
export function init_logging(): void;
export class MlsClient {
  free(): void;
  [Symbol.dispose](): void;
  add_member(group_id_bytes: Uint8Array, key_package_bytes: Uint8Array): Array<any>;
  create_group(group_id_bytes: Uint8Array): Uint8Array;
  process_commit(group_id_bytes: Uint8Array, commit_bytes: Uint8Array): void;
  create_identity(identity_name: string): string;
  decrypt_message(group_id_bytes: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  encrypt_message(group_id_bytes: Uint8Array, message: Uint8Array): Uint8Array;
  process_welcome(welcome_bytes: Uint8Array, ratchet_tree_bytes?: Uint8Array | null): Uint8Array;
  restore_identity(credential_bytes: Uint8Array, bundle_bytes: Uint8Array, signature_key_bytes: Uint8Array): void;
  static derive_key_argon2id(password: string, salt: Uint8Array): Uint8Array;
  get_credential_bytes(): Uint8Array;
  get_key_package_bytes(): Uint8Array;
  /**
   * Regenerate a new KeyPackage using the existing credential and signature key
   * Per OpenMLS Book: KeyPackages are single-use and must be regenerated after being consumed
   */
  regenerate_key_package(): void;
  get_identity_fingerprint(): string;
  get_signature_keypair_bytes(): Uint8Array;
  get_key_package_bundle_bytes(): Uint8Array;
  constructor();
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_mlsclient_free: (a: number, b: number) => void;
  readonly mlsclient_add_member: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly mlsclient_create_group: (a: number, b: number, c: number) => [number, number, number, number];
  readonly mlsclient_create_identity: (a: number, b: number, c: number) => [number, number, number, number];
  readonly mlsclient_decrypt_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly mlsclient_derive_key_argon2id: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly mlsclient_encrypt_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly mlsclient_get_credential_bytes: (a: number) => [number, number, number, number];
  readonly mlsclient_get_identity_fingerprint: (a: number) => [number, number, number, number];
  readonly mlsclient_get_key_package_bundle_bytes: (a: number) => [number, number, number, number];
  readonly mlsclient_get_key_package_bytes: (a: number) => [number, number, number, number];
  readonly mlsclient_get_signature_keypair_bytes: (a: number) => [number, number, number, number];
  readonly mlsclient_new: () => number;
  readonly mlsclient_process_commit: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly mlsclient_process_welcome: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly mlsclient_regenerate_key_package: (a: number) => [number, number];
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
