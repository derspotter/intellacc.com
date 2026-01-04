/* tslint:disable */
/* eslint-disable */
export function init_logging(): void;
export class MlsClient {
  free(): void;
  [Symbol.dispose](): void;
  add_member(group_id_bytes: Uint8Array, key_package_bytes: Uint8Array): Array<any>;
  /**
   * Leave the group voluntarily (creates a self-remove proposal)
   * Returns the proposal message bytes (NOT a commit - another member must commit it)
   */
  leave_group(group_id_bytes: Uint8Array): Uint8Array;
  /**
   * Update own leaf node (key rotation for Post-Compromise Security)
   * Returns [commit_bytes, optional_welcome_bytes, optional_group_info_bytes]
   */
  self_update(group_id_bytes: Uint8Array): Array<any>;
  /**
   * Clear all groups from memory (used when locking vault)
   */
  clear_groups(): void;
  create_group(group_id_bytes: Uint8Array): Uint8Array;
  reboot_group(group_id_bytes: Uint8Array, new_group_id_bytes: Uint8Array, key_packages: Array<any>, aad_bytes: Uint8Array): any;
  remove_group(group_id_bytes: Uint8Array): void;
  /**
   * Get list of all group IDs currently in memory
   * Returns array of group ID byte arrays
   */
  get_group_ids(): Array<any>;
  /**
   * Remove a member from the group by their leaf index
   * Returns [commit_bytes, optional_welcome_bytes, optional_group_info_bytes]
   */
  remove_member(group_id_bytes: Uint8Array, leaf_index: number): Array<any>;
  set_group_aad(group_id_bytes: Uint8Array, aad_bytes: Uint8Array): void;
  /**
   * Stage a welcome for inspection before joining (two-phase join)
   * Returns a staging_id that can be used with inspect/accept/reject functions
   */
  stage_welcome(welcome_bytes: Uint8Array, ratchet_tree_bytes?: Uint8Array | null): string;
  process_commit(group_id_bytes: Uint8Array, commit_bytes: Uint8Array): any;
  create_identity(identity_name: string): string;
  decrypt_message(group_id_bytes: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  encrypt_message(group_id_bytes: Uint8Array, message: Uint8Array): Uint8Array;
  get_group_epoch(group_id_bytes: Uint8Array): bigint;
  process_welcome(welcome_bytes: Uint8Array, ratchet_tree_bytes?: Uint8Array | null): Uint8Array;
  /**
   * Retrieve a sent message plaintext by group_id and msg_id
   */
  get_sent_message(group_id: Uint8Array, msg_id: string): string | undefined;
  process_proposal(group_id_bytes: Uint8Array, proposal_bytes: Uint8Array): any;
  restore_identity(credential_bytes: Uint8Array, bundle_bytes: Uint8Array, signature_key_bytes: Uint8Array): void;
  export_group_info(group_id_bytes: Uint8Array, with_ratchet_tree: boolean): Uint8Array;
  get_group_members(group_id_bytes: Uint8Array): any;
  /**
   * Get own leaf index in a group (needed for remove_member calls)
   */
  get_own_leaf_index(group_id_bytes: Uint8Array): number;
  inspect_group_info(group_info_bytes: Uint8Array): any;
  store_external_psk(psk_id_serialized: Uint8Array, secret: Uint8Array): void;
  /**
   * Store a sent message plaintext for later retrieval (own message history)
   * Key format: group_id || msg_id bytes
   */
  store_sent_message(group_id: Uint8Array, msg_id: string, plaintext: string): void;
  static derive_key_argon2id(password: string, salt: Uint8Array): Uint8Array;
  merge_staged_commit(group_id_bytes: Uint8Array): void;
  clear_pending_commit(group_id_bytes: Uint8Array): void;
  drain_storage_events(): any;
  /**
   * Export the entire storage state for vault persistence
   * Returns a serialized blob that can be stored encrypted
   */
  export_storage_state(): Uint8Array;
  get_credential_bytes(): Uint8Array;
  import_storage_state(data: Uint8Array): void;
  /**
   * List all pending staged welcomes
   */
  list_staged_welcomes(): Array<any>;
  merge_pending_commit(group_id_bytes: Uint8Array): void;
  propose_external_psk(group_id_bytes: Uint8Array, psk_id_serialized: Uint8Array): Uint8Array;
  /**
   * Accept a staged welcome and join the group
   * Returns the group_id bytes
   */
  accept_staged_welcome(staging_id: string): Uint8Array;
  discard_staged_commit(group_id_bytes: Uint8Array): void;
  generate_external_psk(psk_id_bytes: Uint8Array): any;
  get_key_package_bytes(): Uint8Array;
  /**
   * Reject a staged welcome (discard without joining)
   */
  reject_staged_welcome(staging_id: string): void;
  import_granular_events(events_value: any): void;
  /**
   * Regenerate a new KeyPackage using the existing credential and signature key
   * Per OpenMLS Book: KeyPackages are single-use and must be regenerated after being consumed
   */
  regenerate_key_package(): void;
  clear_pending_proposals(group_id_bytes: Uint8Array): void;
  /**
   * Get info about a staged welcome for inspection
   * Returns JSON with group_id, ciphersuite, epoch, sender, and members
   */
  get_staged_welcome_info(staging_id: string): any;
  join_by_external_commit(group_info_bytes: Uint8Array, ratchet_tree_bytes: Uint8Array | null | undefined, psk_ids: Array<any>, aad_bytes: Uint8Array): any;
  commit_pending_proposals(group_id_bytes: Uint8Array): Array<any>;
  decrypt_message_with_aad(group_id_bytes: Uint8Array, ciphertext: Uint8Array): any;
  get_identity_fingerprint(): string;
  get_key_package_lifetime(): any;
  recover_fork_by_readding(group_id_bytes: Uint8Array, own_leaf_indices: Array<any>, key_packages: Array<any>): any;
  get_group_confirmation_tag(group_id_bytes: Uint8Array): Uint8Array;
  get_group_member_identities(group_id_bytes: Uint8Array): Array<any>;
  get_signature_keypair_bytes(): Uint8Array;
  get_key_package_bundle_bytes(): Uint8Array;
  key_package_lifetime_from_bytes(key_package_bytes: Uint8Array): any;
  generate_last_resort_key_package(): Uint8Array;
  create_group_with_external_senders(group_id_bytes: Uint8Array, sender_identities: Array<any>, sender_signature_keys: Array<any>): Uint8Array;
  constructor();
  /**
   * Check if a specific group exists in memory
   */
  has_group(group_id_bytes: Uint8Array): boolean;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_mlsclient_free: (a: number, b: number) => void;
  readonly mlsclient_accept_staged_welcome: (a: number, b: number, c: number) => [number, number, number, number];
  readonly mlsclient_add_member: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly mlsclient_clear_groups: (a: number) => void;
  readonly mlsclient_clear_pending_commit: (a: number, b: number, c: number) => [number, number];
  readonly mlsclient_clear_pending_proposals: (a: number, b: number, c: number) => [number, number];
  readonly mlsclient_commit_pending_proposals: (a: number, b: number, c: number) => [number, number, number];
  readonly mlsclient_create_group: (a: number, b: number, c: number) => [number, number, number, number];
  readonly mlsclient_create_group_with_external_senders: (a: number, b: number, c: number, d: any, e: any) => [number, number, number, number];
  readonly mlsclient_create_identity: (a: number, b: number, c: number) => [number, number, number, number];
  readonly mlsclient_decrypt_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly mlsclient_decrypt_message_with_aad: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly mlsclient_derive_key_argon2id: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly mlsclient_discard_staged_commit: (a: number, b: number, c: number) => [number, number];
  readonly mlsclient_drain_storage_events: (a: number) => [number, number, number];
  readonly mlsclient_encrypt_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly mlsclient_export_group_info: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly mlsclient_export_storage_state: (a: number) => [number, number, number, number];
  readonly mlsclient_generate_external_psk: (a: number, b: number, c: number) => [number, number, number];
  readonly mlsclient_generate_last_resort_key_package: (a: number) => [number, number, number, number];
  readonly mlsclient_get_credential_bytes: (a: number) => [number, number, number, number];
  readonly mlsclient_get_group_confirmation_tag: (a: number, b: number, c: number) => [number, number, number, number];
  readonly mlsclient_get_group_epoch: (a: number, b: number, c: number) => [bigint, number, number];
  readonly mlsclient_get_group_ids: (a: number) => any;
  readonly mlsclient_get_group_member_identities: (a: number, b: number, c: number) => [number, number, number];
  readonly mlsclient_get_group_members: (a: number, b: number, c: number) => [number, number, number];
  readonly mlsclient_get_identity_fingerprint: (a: number) => [number, number, number, number];
  readonly mlsclient_get_key_package_bundle_bytes: (a: number) => [number, number, number, number];
  readonly mlsclient_get_key_package_bytes: (a: number) => [number, number, number, number];
  readonly mlsclient_get_key_package_lifetime: (a: number) => [number, number, number];
  readonly mlsclient_get_own_leaf_index: (a: number, b: number, c: number) => [number, number, number];
  readonly mlsclient_get_sent_message: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly mlsclient_get_signature_keypair_bytes: (a: number) => [number, number, number, number];
  readonly mlsclient_get_staged_welcome_info: (a: number, b: number, c: number) => [number, number, number];
  readonly mlsclient_has_group: (a: number, b: number, c: number) => number;
  readonly mlsclient_import_granular_events: (a: number, b: any) => [number, number];
  readonly mlsclient_import_storage_state: (a: number, b: number, c: number) => [number, number];
  readonly mlsclient_inspect_group_info: (a: number, b: number, c: number) => [number, number, number];
  readonly mlsclient_join_by_external_commit: (a: number, b: number, c: number, d: number, e: number, f: any, g: number, h: number) => [number, number, number];
  readonly mlsclient_key_package_lifetime_from_bytes: (a: number, b: number, c: number) => [number, number, number];
  readonly mlsclient_leave_group: (a: number, b: number, c: number) => [number, number, number, number];
  readonly mlsclient_list_staged_welcomes: (a: number) => any;
  readonly mlsclient_merge_pending_commit: (a: number, b: number, c: number) => [number, number];
  readonly mlsclient_merge_staged_commit: (a: number, b: number, c: number) => [number, number];
  readonly mlsclient_new: () => number;
  readonly mlsclient_process_commit: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly mlsclient_process_proposal: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly mlsclient_process_welcome: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly mlsclient_propose_external_psk: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly mlsclient_reboot_group: (a: number, b: number, c: number, d: number, e: number, f: any, g: number, h: number) => [number, number, number];
  readonly mlsclient_recover_fork_by_readding: (a: number, b: number, c: number, d: any, e: any) => [number, number, number];
  readonly mlsclient_regenerate_key_package: (a: number) => [number, number];
  readonly mlsclient_reject_staged_welcome: (a: number, b: number, c: number) => [number, number];
  readonly mlsclient_remove_group: (a: number, b: number, c: number) => [number, number];
  readonly mlsclient_remove_member: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly mlsclient_restore_identity: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
  readonly mlsclient_self_update: (a: number, b: number, c: number) => [number, number, number];
  readonly mlsclient_set_group_aad: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly mlsclient_stage_welcome: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly mlsclient_store_external_psk: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly mlsclient_store_sent_message: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
  readonly init_logging: () => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
