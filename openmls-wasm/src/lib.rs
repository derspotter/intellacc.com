use wasm_bindgen::prelude::*;
use openmls::prelude::*;
use openmls_rust_crypto::RustCrypto;
use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::storage::*;
use openmls_traits::types::Ciphersuite;
use openmls_traits::OpenMlsProvider;
use argon2::{
    Argon2
};
use sha2::{Sha256, Digest};
use hex;
use tls_codec::{Serialize, Deserialize};
use js_sys::Uint8Array;
use std::collections::HashMap;
use std::sync::RwLock;

// Explicit imports
use openmls::group::{MlsGroupCreateConfig, MlsGroupJoinConfig, StagedWelcome, GroupId, StagedCommit};
use openmls::credentials::{Credential, CredentialType, BasicCredential};
use openmls::extensions::{Extension, ExtensionType, Extensions, ExternalSender};
use openmls::prelude::Capabilities;
use openmls::key_packages::{KeyPackage, KeyPackageIn, KeyPackageBundle, Lifetime};
use openmls::treesync::LeafNodeParameters;
use openmls::treesync::LeafNodeSource;
use openmls::treesync::RatchetTreeIn;
use openmls::schedule::{ExternalPsk, PreSharedKeyId, Psk};
use openmls::messages::group_info::VerifiableGroupInfo;
use openmls::messages::proposals::{PreSharedKeyProposal, Proposal};
// For writing KeyPackageBundle

use openmls::framing::{ProcessedMessageContent, MlsMessageIn, MlsMessageBodyIn, MlsMessageBodyOut, ProtocolMessage, Sender};

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[cfg(not(target_arch = "wasm32"))]
fn log(s: &str) {
    println!("{}", s);
}

const KEY_PACKAGE_LIFETIME_SECONDS: u64 = 60 * 60 * 24 * 28 * 3;
const MESSAGE_PADDING_SIZE: usize = 32;
const RESUMPTION_PSK_WINDOW: usize = 32;
const DEFAULT_EXTERNAL_PSK_ID_LEN: usize = 16;

#[wasm_bindgen]
pub fn init_logging() {
    console_error_panic_hook::set_once();
    log("OpenMLS WASM initialized");
}

#[derive(serde::Serialize, Clone)]
struct LifetimeInfo {
    not_before: u64,
    not_after: u64,
    range_seconds: u64,
    has_acceptable_range: bool,
}

#[derive(serde::Serialize, Clone)]
struct CommitIdentitySummary {
    identity: String,
    is_basic: bool,
    lifetime: Option<LifetimeInfo>,
}

/// Member info extracted from a staged welcome for inspection
#[derive(serde::Serialize, Clone)]
struct WelcomeMemberInfo {
    leaf_index: u32,
    identity: String,
    is_basic_credential: bool,
    signature_key_hex: String,
    encryption_key_hex: String,
}

/// Sender info extracted from a staged welcome
#[derive(serde::Serialize, Clone)]
struct WelcomeSenderInfo {
    identity: String,
    is_basic_credential: bool,
    signature_key_hex: String,
    lifetime: Option<LifetimeInfo>,
}

/// Full inspection result for a staged welcome
#[derive(serde::Serialize)]
struct StagedWelcomeInfo {
    group_id_hex: String,
    ciphersuite: String,
    epoch: u64,
    sender: Option<WelcomeSenderInfo>,
    members: Vec<WelcomeMemberInfo>,
}

/// Data stored for a pending welcome (for two-phase join)
struct PendingStagedWelcome {
    staged_welcome: StagedWelcome,
    info: StagedWelcomeInfo,
}

#[derive(serde::Serialize)]
struct CommitRemoveSummary {
    leaf_index: u32,
    identity: Option<CommitIdentitySummary>,
}

#[derive(serde::Serialize)]
struct StagedCommitSummary {
    adds: Vec<CommitIdentitySummary>,
    removes: Vec<CommitRemoveSummary>,
    updates: Vec<CommitIdentitySummary>,
    self_removed: bool,
    epoch: u64,
    aad_hex: String,
}

#[derive(serde::Serialize)]
struct DecryptedMessageInfo {
    plaintext: Vec<u8>,
    aad_hex: String,
    epoch: u64,
    group_id_hex: String,
}

#[derive(serde::Serialize)]
struct CommitBundleResult {
    group_id_hex: String,
    commit: Vec<u8>,
    welcome: Option<Vec<u8>>,
    group_info: Option<Vec<u8>>,
    epoch: u64,
}

#[derive(serde::Serialize)]
struct GroupInfoSummary {
    group_id_hex: String,
    epoch: u64,
    ciphersuite: String,
    has_ratchet_tree: bool,
    has_external_pub: bool,
}

#[derive(serde::Serialize)]
struct ExternalPskBundle {
    psk_id: Vec<u8>,
    psk_nonce: Vec<u8>,
    psk_id_serialized: Vec<u8>,
    secret: Vec<u8>,
}

#[derive(serde::Serialize)]
struct ProposalSummary {
    adds: Vec<CommitIdentitySummary>,
    removes: Vec<CommitRemoveSummary>,
    updates: Vec<CommitIdentitySummary>,
    epoch: u64,
    aad_hex: String,
    proposal_type: String,
    sender_type: String,
}

/// Single key package with its metadata - used for batch generation
#[derive(serde::Serialize)]
struct KeyPackageInfo {
    key_package_bytes: Vec<u8>,
    hash: String,
    lifetime: LifetimeInfo,
    is_last_resort: bool,
}

/// Result from generating multiple key packages
#[derive(serde::Serialize)]
struct GeneratedKeyPackages {
    key_packages: Vec<KeyPackageInfo>,
}

fn lifetime_info_from(lifetime: &Lifetime) -> LifetimeInfo {
    let not_before = lifetime.not_before();
    let not_after = lifetime.not_after();
    LifetimeInfo {
        not_before,
        not_after,
        range_seconds: not_after.saturating_sub(not_before),
        has_acceptable_range: lifetime.has_acceptable_range(),
    }
}

fn lifetime_info_value(lifetime: &Lifetime) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&lifetime_info_from(lifetime))
        .map_err(|e| JsValue::from_str(&format!("Error serializing lifetime info: {:?}", e)))
}

fn commit_identity_summary(
    credential: &Credential,
    lifetime: Option<&Lifetime>,
) -> CommitIdentitySummary {
    let (identity, is_basic) = if let Ok(basic) = BasicCredential::try_from(credential.clone()) {
        let identity_bytes = basic.identity();
        let identity = match String::from_utf8(identity_bytes.to_vec()) {
            Ok(text) => text,
            Err(_) => hex::encode(identity_bytes),
        };
        (identity, true)
    } else {
        (hex::encode(credential.serialized_content()), false)
    };

    CommitIdentitySummary {
        identity,
        is_basic,
        lifetime: lifetime.map(lifetime_info_from),
    }
}

fn credential_identity_summary(credential: &Credential) -> CommitIdentitySummary {
    commit_identity_summary(credential, None)
}

fn parse_leaf_indices(indices: &js_sys::Array) -> Result<Vec<LeafNodeIndex>, JsValue> {
    let mut parsed = Vec::new();
    for value in indices.iter() {
        let index = value
            .as_f64()
            .ok_or_else(|| JsValue::from_str("Leaf index must be a number"))? as u32;
        parsed.push(LeafNodeIndex::new(index));
    }
    Ok(parsed)
}

fn parse_key_packages(provider: &GranularProvider, key_packages: &js_sys::Array) -> Result<Vec<KeyPackage>, JsValue> {
    let mut parsed = Vec::new();
    for value in key_packages.iter() {
        let bytes = Uint8Array::new(&value).to_vec();
        let key_package_in = KeyPackageIn::tls_deserialize(&mut &bytes[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing key package: {:?}", e)))?;
        let key_package = key_package_in
            .validate(provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| JsValue::from_str(&format!("Error validating key package: {:?}", e)))?;
        if !key_package.life_time().has_acceptable_range() {
            return Err(JsValue::from_str("KeyPackage lifetime exceeds acceptable range"));
        }
        parsed.push(key_package);
    }
    Ok(parsed)
}

fn parse_psk_ids(psk_ids: &js_sys::Array) -> Result<Vec<PreSharedKeyId>, JsValue> {
    let mut parsed = Vec::new();
    for value in psk_ids.iter() {
        let bytes = Uint8Array::new(&value).to_vec();
        let psk_id = PreSharedKeyId::tls_deserialize(&mut &bytes[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing PSK ID: {:?}", e)))?;
        parsed.push(psk_id);
    }
    Ok(parsed)
}

// --- Granular Provider Wiring ---

#[derive(Debug)]
pub struct GranularProvider {
    crypto: RustCrypto,
    pub storage: GranularStorage,
}

impl Default for GranularProvider {
    fn default() -> Self {
        Self {
            crypto: RustCrypto::default(),
            storage: GranularStorage::default(),
        }
    }
}

impl openmls_traits::OpenMlsProvider for GranularProvider {
    type CryptoProvider = RustCrypto; // OpenMlsRustCrypto implements OpenMlsCryptoProvider
    type RandProvider = RustCrypto;   // OpenMlsRustCrypto implements OpenMlsRandProvider
    type StorageProvider = GranularStorage;

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }
}


#[wasm_bindgen]
pub struct MlsClient {
    #[wasm_bindgen(skip)]
    pub provider: GranularProvider,
    
    // We can remove the separate `storage` field since it's now inside the provider,
    // OR keep it for direct access if needed (but provider methods should suffice).
    // Accessing `self.provider.storage()` is the correct way.
    // However, for WASM exposed methods like `drain_events`, we might want direct access 
    // or expose it via provider. 
    // I'll remove the redundant top-level `storage` field to avoid confusion/sync issues.
    
    #[wasm_bindgen(skip)]
    pub credential: Option<Credential>,
    
    #[wasm_bindgen(skip)]
    pub signature_keypair: Option<SignatureKeyPair>,
    
    #[wasm_bindgen(skip)]
    pub key_package: Option<KeyPackage>,
    
    #[wasm_bindgen(skip)]
    pub groups: HashMap<Vec<u8>, MlsGroup>,

    #[wasm_bindgen(skip)]
    pub staged_commits: HashMap<Vec<u8>, StagedCommit>,

    #[wasm_bindgen(skip)]
    staged_welcomes: HashMap<String, PendingStagedWelcome>,
}

#[wasm_bindgen]
impl MlsClient {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MlsClient {
        MlsClient {
            provider: GranularProvider::default(),
            credential: None,
            signature_keypair: None,
            key_package: None,
            groups: HashMap::new(),
            staged_commits: HashMap::new(),
            staged_welcomes: HashMap::new(),
        }
    }

    pub fn drain_storage_events(&mut self) -> Result<JsValue, JsValue> {
        let mut events = self.provider.storage.dirty_events.write().map_err(|_| JsValue::from_str("Lock error"))?;
        let drained: Vec<StorageEvent> = events.drain(..).collect();
        serde_wasm_bindgen::to_value(&drained).map_err(|e| JsValue::from(e))
    }

    /// Store a sent message plaintext for later retrieval (own message history)
    /// Key format: group_id || msg_id bytes
    pub fn store_sent_message(&mut self, group_id: &[u8], msg_id: &str, plaintext: &str) -> Result<(), JsValue> {
        // Create composite key: group_id + msg_id bytes
        let msg_id_bytes = msg_id.as_bytes();
        let mut key = Vec::with_capacity(group_id.len() + msg_id_bytes.len());
        key.extend_from_slice(group_id);
        key.extend_from_slice(msg_id_bytes);

        let value = plaintext.as_bytes().to_vec();

        // Store in sent_messages map
        self.provider.storage.sent_messages.write()
            .map_err(|_| JsValue::from_str("Lock error"))?
            .insert(key.clone(), value.clone());

        // Log dirty event for persistence
        self.provider.storage.dirty_events.write()
            .map_err(|_| JsValue::from_str("Lock error"))?
            .push(StorageEvent {
                key: hex::encode(&key),
                value: Some(value),
                category: "sent_message".to_string(),
            });

        Ok(())
    }

    /// Retrieve a sent message plaintext by group_id and msg_id
    pub fn get_sent_message(&self, group_id: &[u8], msg_id: &str) -> Result<Option<String>, JsValue> {
        // Create composite key: group_id + msg_id bytes
        let msg_id_bytes = msg_id.as_bytes();
        let mut key = Vec::with_capacity(group_id.len() + msg_id_bytes.len());
        key.extend_from_slice(group_id);
        key.extend_from_slice(msg_id_bytes);

        let map = self.provider.storage.sent_messages.read()
            .map_err(|_| JsValue::from_str("Lock error"))?;

        match map.get(&key) {
            Some(bytes) => {
                let plaintext = String::from_utf8(bytes.clone())
                    .map_err(|e| JsValue::from_str(&format!("UTF-8 decode error: {:?}", e)))?;
                Ok(Some(plaintext))
            }
            None => Ok(None),
        }
    }

    // ... (rest of impl)




    pub fn create_group(&mut self, group_id_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        // Use self.provider instead of creating a new one
        let provider = &self.provider;
        
        let signature_keypair = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;

        let credential = self.credential.as_ref()
            .ok_or_else(|| JsValue::from_str("No credential available"))?;

        let credential_with_key = CredentialWithKey {
            credential: credential.clone(),
            signature_key: signature_keypair.to_public_vec().into(),
        };

        let group_config = MlsGroupCreateConfig::builder()
            .wire_format_policy(WireFormatPolicy::default())
            .padding_size(MESSAGE_PADDING_SIZE)
            .use_ratchet_tree_extension(true)
            .max_past_epochs(5)  // Allow decrypting messages from up to 5 previous epochs
            .sender_ratchet_configuration(SenderRatchetConfiguration::new(
                10,  // out_of_order_tolerance
                2000 // maximum_forward_distance
            ))
            .number_of_resumption_psks(RESUMPTION_PSK_WINDOW)
            .build();

        // Use new_with_group_id to ensure our external group ID matches MLS internal ID
        let group_id = GroupId::from_slice(group_id_bytes);

        let group = MlsGroup::new_with_group_id(
            provider,
            signature_keypair,
            &group_config,
            group_id,
            credential_with_key,
        ).map_err(|e| JsValue::from_str(&format!("Error creating group: {:?}", e)))?;

        // Store using the MLS group ID to ensure consistency
        let mls_group_id = group.group_id().as_slice().to_vec();
        log(&format!("[WASM] create_group: MLS group ID = {}", hex::encode(&mls_group_id)));

        self.groups.insert(mls_group_id.clone(), group);

        Ok(mls_group_id)
    }

    pub fn create_group_with_external_senders(
        &mut self,
        group_id_bytes: &[u8],
        sender_identities: js_sys::Array,
        sender_signature_keys: js_sys::Array,
    ) -> Result<Vec<u8>, JsValue> {
        if sender_identities.length() != sender_signature_keys.length() {
            return Err(JsValue::from_str("External sender arrays must have the same length"));
        }

        let provider = &self.provider;
        let signature_keypair = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;
        let credential = self.credential.as_ref()
            .ok_or_else(|| JsValue::from_str("No credential available"))?;

        let credential_with_key = CredentialWithKey {
            credential: credential.clone(),
            signature_key: signature_keypair.to_public_vec().into(),
        };

        let mut external_senders = Vec::new();
        for idx in 0..sender_identities.length() {
            let identity = sender_identities
                .get(idx)
                .as_string()
                .ok_or_else(|| JsValue::from_str("External sender identity must be a string"))?;
            let signature_key_bytes = Uint8Array::new(&sender_signature_keys.get(idx)).to_vec();
            let sender_credential = Credential::new(
                CredentialType::Basic,
                identity.as_bytes().to_vec(),
            );
            let signature_key = SignaturePublicKey::from(signature_key_bytes);
            external_senders.push(ExternalSender::new(signature_key, sender_credential));
        }

        let extensions = Extensions::single(Extension::ExternalSenders(external_senders));

        let group_config = MlsGroupCreateConfig::builder()
            .wire_format_policy(WireFormatPolicy::default())
            .padding_size(MESSAGE_PADDING_SIZE)
            .use_ratchet_tree_extension(true)
            .max_past_epochs(5)
            .sender_ratchet_configuration(SenderRatchetConfiguration::new(10, 2000))
            .number_of_resumption_psks(RESUMPTION_PSK_WINDOW)
            .with_group_context_extensions(extensions)
            .map_err(|e| JsValue::from_str(&format!("Error adding external senders: {:?}", e)))?
            .build();

        let group_id = GroupId::from_slice(group_id_bytes);
        let group = MlsGroup::new_with_group_id(
            provider,
            signature_keypair,
            &group_config,
            group_id,
            credential_with_key,
        )
        .map_err(|e| JsValue::from_str(&format!("Error creating group: {:?}", e)))?;

        let mls_group_id = group.group_id().as_slice().to_vec();
        log(&format!("[WASM] create_group_with_external_senders: MLS group ID = {}", hex::encode(&mls_group_id)));
        self.groups.insert(mls_group_id.clone(), group);

        Ok(mls_group_id)
    }

    pub fn export_group_info(&self, group_id_bytes: &[u8], with_ratchet_tree: bool) -> Result<Vec<u8>, JsValue> {
        let provider = &self.provider;
        let signer = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;
        let group = self.groups.get(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;

        let group_info_msg = group.export_group_info(provider.crypto(), signer, with_ratchet_tree)
            .map_err(|e| JsValue::from_str(&format!("Error exporting group info: {:?}", e)))?;

        let group_info = match group_info_msg.body() {
            MlsMessageBodyOut::GroupInfo(info) => info,
            _ => return Err(JsValue::from_str("Exported MLS message did not contain GroupInfo")),
        };

        group_info.tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing group info: {:?}", e)))
    }

    pub fn inspect_group_info(&self, group_info_bytes: &[u8]) -> Result<JsValue, JsValue> {
        let verifiable_group_info = VerifiableGroupInfo::tls_deserialize(&mut &group_info_bytes[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing group info: {:?}", e)))?;

        let summary = GroupInfoSummary {
            group_id_hex: hex::encode(verifiable_group_info.group_id().as_slice()),
            epoch: verifiable_group_info.epoch().as_u64(),
            ciphersuite: format!("{:?}", verifiable_group_info.ciphersuite()),
            has_ratchet_tree: verifiable_group_info.extensions().contains(ExtensionType::RatchetTree),
            has_external_pub: verifiable_group_info.extensions().contains(ExtensionType::ExternalPub),
        };

        serde_wasm_bindgen::to_value(&summary)
            .map_err(|e| JsValue::from_str(&format!("Error serializing group info summary: {:?}", e)))
    }

    pub fn join_by_external_commit(
        &mut self,
        group_info_bytes: &[u8],
        ratchet_tree_bytes: Option<Vec<u8>>,
        psk_ids: js_sys::Array,
        aad_bytes: Vec<u8>,
    ) -> Result<JsValue, JsValue> {
        let provider = &self.provider;
        let signer = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;
        let credential = self.credential.as_ref()
            .ok_or_else(|| JsValue::from_str("No credential available"))?;

        let credential_with_key = CredentialWithKey {
            credential: credential.clone(),
            signature_key: signer.to_public_vec().into(),
        };

        let verifiable_group_info = VerifiableGroupInfo::tls_deserialize(&mut &group_info_bytes[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing group info: {:?}", e)))?;
        let commit_epoch = verifiable_group_info.epoch().as_u64();

        let group_config = MlsGroupJoinConfig::builder()
            .wire_format_policy(WireFormatPolicy::default())
            .padding_size(MESSAGE_PADDING_SIZE)
            .max_past_epochs(5)
            .sender_ratchet_configuration(SenderRatchetConfiguration::new(10, 2000))
            .use_ratchet_tree_extension(true)
            .number_of_resumption_psks(RESUMPTION_PSK_WINDOW)
            .build();

        let mut builder = MlsGroup::external_commit_builder()
            .with_config(group_config)
            .with_aad(aad_bytes);

        if let Some(bytes) = ratchet_tree_bytes {
            let ratchet_tree = RatchetTreeIn::tls_deserialize(&mut &bytes[..])
                .map_err(|e| JsValue::from_str(&format!("Error deserializing ratchet tree: {:?}", e)))?;
            builder = builder.with_ratchet_tree(ratchet_tree);
        }

        let mut commit_builder = builder
            .build_group(provider, verifiable_group_info, credential_with_key)
            .map_err(|e| JsValue::from_str(&format!("Error building external commit group: {:?}", e)))?
            .leaf_node_parameters(LeafNodeParameters::default());

        let parsed_psk_ids = parse_psk_ids(&psk_ids)?;
        if !parsed_psk_ids.is_empty() {
            let proposals = parsed_psk_ids
                .into_iter()
                .map(PreSharedKeyProposal::new)
                .collect::<Vec<_>>();
            commit_builder = commit_builder.add_psk_proposals(proposals);
        }

        let (group, commit_bundle) = commit_builder
            .load_psks(provider.storage())
            .map_err(|e| JsValue::from_str(&format!("Error loading PSKs: {:?}", e)))?
            .build(provider.rand(), provider.crypto(), signer, |_| true)
            .map_err(|e| JsValue::from_str(&format!("Error building external commit: {:?}", e)))?
            .finalize(provider)
            .map_err(|e| JsValue::from_str(&format!("Error finalizing external commit: {:?}", e)))?;

        let group_id_bytes = group.group_id().as_slice().to_vec();
        let commit_bytes = commit_bundle
            .commit()
            .tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing external commit: {:?}", e)))?;
        let group_info_bytes = commit_bundle
            .group_info()
            .map(|info| info.tls_serialize_detached())
            .transpose()
            .map_err(|e| JsValue::from_str(&format!("Error serializing external group info: {:?}", e)))?;

        self.groups.insert(group_id_bytes.clone(), group);

        let result = CommitBundleResult {
            group_id_hex: hex::encode(group_id_bytes),
            commit: commit_bytes,
            welcome: None,
            group_info: group_info_bytes,
            epoch: commit_epoch,
        };

        serde_wasm_bindgen::to_value(&result)
            .map_err(|e| JsValue::from_str(&format!("Error serializing external commit result: {:?}", e)))
    }

    pub fn generate_external_psk(&mut self, psk_id_bytes: &[u8]) -> Result<JsValue, JsValue> {
        let provider = &self.provider;
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

        let psk_id = if psk_id_bytes.is_empty() {
            provider
                .rand()
                .random_vec(DEFAULT_EXTERNAL_PSK_ID_LEN)
                .map_err(|_| JsValue::from_str("Error generating PSK ID"))?
        } else {
            psk_id_bytes.to_vec()
        };

        let psk_id_struct = PreSharedKeyId::new(
            ciphersuite,
            provider.rand(),
            Psk::External(ExternalPsk::new(psk_id.clone())),
        )
        .map_err(|e| JsValue::from_str(&format!("Error creating PSK ID: {:?}", e)))?;

        let secret = provider
            .rand()
            .random_vec(ciphersuite.hash_length())
            .map_err(|_| JsValue::from_str("Error generating PSK secret"))?;

        psk_id_struct
            .store(provider, &secret)
            .map_err(|e| JsValue::from_str(&format!("Error storing PSK: {:?}", e)))?;

        let bundle = ExternalPskBundle {
            psk_id,
            psk_nonce: psk_id_struct.psk_nonce().to_vec(),
            psk_id_serialized: psk_id_struct
                .tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing PSK ID: {:?}", e)))?,
            secret,
        };

        serde_wasm_bindgen::to_value(&bundle)
            .map_err(|e| JsValue::from_str(&format!("Error serializing PSK bundle: {:?}", e)))
    }

    pub fn store_external_psk(&mut self, psk_id_serialized: &[u8], secret: &[u8]) -> Result<(), JsValue> {
        let provider = &self.provider;
        let psk_id = PreSharedKeyId::tls_deserialize(&mut &psk_id_serialized[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing PSK ID: {:?}", e)))?;

        psk_id
            .store(provider, secret)
            .map_err(|e| JsValue::from_str(&format!("Error storing PSK: {:?}", e)))
    }

    pub fn propose_external_psk(&mut self, group_id_bytes: &[u8], psk_id_serialized: &[u8]) -> Result<Vec<u8>, JsValue> {
        let provider = &self.provider;
        let signer = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;

        let psk_id = PreSharedKeyId::tls_deserialize(&mut &psk_id_serialized[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing PSK ID: {:?}", e)))?;

        let (proposal_msg, _proposal_ref) = group
            .propose_external_psk(provider, signer, psk_id)
            .map_err(|e| JsValue::from_str(&format!("Error creating PSK proposal: {:?}", e)))?;

        proposal_msg
            .tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing PSK proposal: {:?}", e)))
    }

    pub fn create_identity(&mut self, identity_name: &str) -> Result<String, JsValue> {
        let provider = &self.provider;
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
        
        let signature_keypair = SignatureKeyPair::new(ciphersuite.signature_algorithm())
            .map_err(|e| JsValue::from_str(&format!("Error creating signature keypair: {:?}", e)))?;

        // Create a basic credential (arguments: credential_type, identity)
        let credential = Credential::new(
            CredentialType::Basic,
            identity_name.as_bytes().to_vec(),
        );
        
        let credential_with_key = CredentialWithKey {
            credential: credential.clone(),
            signature_key: signature_keypair.to_public_vec().into(),
        };

        // Build the key package and store private part in storage
        let key_package_bundle = KeyPackage::builder()
            .key_package_lifetime(Lifetime::new(KEY_PACKAGE_LIFETIME_SECONDS))
            .key_package_extensions(Extensions::default())
            .build(
                openmls::prelude::Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
                provider,
                &signature_keypair,
                credential_with_key,
            )
            .map_err(|e| JsValue::from_str(&format!("Error creating key package: {:?}", e)))?;

        let key_package_ref = key_package_bundle.key_package();
        let hash = key_package_ref.hash_ref(provider.crypto())
             .map_err(|e| JsValue::from_str(&format!("Error hashing key package: {:?}", e)))?;
             
        log(&format!("[WASM] Writing KeyPackage Hash: {}", hex::encode(hash.as_slice())));
        
        provider.storage().write_key_package(&hash, &key_package_bundle)
            .map_err(|e| JsValue::from_str(&format!("Error saving key package bundle: {:?}", e)))?;

        let key_package = key_package_ref.clone();

        self.credential = Some(credential);
        self.signature_keypair = Some(signature_keypair);
        self.key_package = Some(key_package);
        
        log(&format!("Identity created for: {}", identity_name));
        
        Ok("Identity created".to_string())
    }

    pub fn get_key_package_bytes(&self) -> Result<Vec<u8>, JsValue> {
        if let Some(kp) = &self.key_package {
            kp.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing key package: {:?}", e)))
        } else {
            Err(JsValue::from_str("No identity created yet"))
        }
    }

    pub fn get_key_package_lifetime(&self) -> Result<JsValue, JsValue> {
        let key_package = self.key_package.as_ref()
            .ok_or_else(|| JsValue::from_str("No identity created yet"))?;
        lifetime_info_value(key_package.life_time())
    }

    pub fn get_credential_bytes(&self) -> Result<Vec<u8>, JsValue> {
        if let Some(c) = &self.credential {
            c.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing credential: {:?}", e)))
        } else {
            Err(JsValue::from_str("No credential available"))
        }
    }

    pub fn get_signature_keypair_bytes(&self) -> Result<Vec<u8>, JsValue> {
        if let Some(skp) = &self.signature_keypair {
            serde_json::to_vec(skp)
                .map_err(|e| JsValue::from_str(&format!("Error serializing signature keypair: {:?}", e)))
        } else {
            Err(JsValue::from_str("No signature keypair available"))
        }
    }

    pub fn get_key_package_bundle_bytes(&self) -> Result<Vec<u8>, JsValue> {
        let key_package = self.key_package.as_ref()
            .ok_or_else(|| JsValue::from_str("No identity created yet"))?;
            
        let hash = key_package.hash_ref(self.provider.crypto())
            .map_err(|e| JsValue::from_str(&format!("Error hashing key package: {:?}", e)))?;
            
        let bundle: Option<KeyPackageBundle> = self.provider.storage()
            .key_package(&hash)
            .map_err(|e| JsValue::from_str(&format!("Error reading key package bundle: {:?}", e)))?;
            
        if let Some(b) = bundle {
            serde_json::to_vec(&b)
                .map_err(|e| JsValue::from_str(&format!("Error serializing bundle: {:?}", e)))
        } else {
            Err(JsValue::from_str("Key package bundle not found in storage"))
        }
    }

    pub fn key_package_lifetime_from_bytes(&self, key_package_bytes: &[u8]) -> Result<JsValue, JsValue> {
        let key_package_in = KeyPackageIn::tls_deserialize(&mut &key_package_bytes[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing key package: {:?}", e)))?;

        let key_package = key_package_in
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| JsValue::from_str(&format!("Error validating key package: {:?}", e)))?;

        lifetime_info_value(key_package.life_time())
    }

    pub fn restore_identity(&mut self, credential_bytes: Vec<u8>, bundle_bytes: Vec<u8>, signature_key_bytes: Vec<u8>) -> Result<(), JsValue> {
        let mut slice = credential_bytes.as_slice();
        let credential = <Credential as Deserialize>::tls_deserialize(&mut slice)
            .map_err(|e| JsValue::from_str(&format!("Error deserializing credential: {:?}", e)))?;

        let signature_keypair: SignatureKeyPair = serde_json::from_slice(&signature_key_bytes)
            .map_err(|e| JsValue::from_str(&format!("Error deserializing signature keypair: {:?}", e)))?;

        let bundle: KeyPackageBundle = serde_json::from_slice(&bundle_bytes)
            .map_err(|e| JsValue::from_str(&format!("Error deserializing bundle: {:?}", e)))?;

        let key_package = bundle.key_package();
        let hash = key_package.hash_ref(self.provider.crypto())
             .map_err(|e| JsValue::from_str(&format!("Error hashing key package: {:?}", e)))?;

        log(&format!("[WASM] restore_identity: Writing KeyPackage Hash: {}", hex::encode(hash.as_slice())));

        self.provider.storage().write_key_package(&hash, &bundle)
            .map_err(|e| JsValue::from_str(&format!("Error saving key package bundle: {:?}", e)))?;

        self.credential = Some(credential);
        self.signature_keypair = Some(signature_keypair);
        self.key_package = Some(key_package.clone());

        Ok(())
    }

    /// Regenerate a new KeyPackage using the existing credential and signature key
    /// Per OpenMLS Book: KeyPackages are single-use and must be regenerated after being consumed
    pub fn regenerate_key_package(&mut self) -> Result<(), JsValue> {
        let provider = &self.provider;

        let signature_keypair = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;

        let credential = self.credential.as_ref()
            .ok_or_else(|| JsValue::from_str("No credential available"))?;

        let credential_with_key = CredentialWithKey {
            credential: credential.clone(),
            signature_key: signature_keypair.to_public_vec().into(),
        };

        // Build a new key package
        let key_package_bundle = KeyPackage::builder()
            .key_package_lifetime(Lifetime::new(KEY_PACKAGE_LIFETIME_SECONDS))
            .key_package_extensions(Extensions::default())
            .build(
                Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
                provider,
                signature_keypair,
                credential_with_key,
            )
            .map_err(|e| JsValue::from_str(&format!("Error creating key package: {:?}", e)))?;

        let key_package_ref = key_package_bundle.key_package();
        let hash = key_package_ref.hash_ref(provider.crypto())
             .map_err(|e| JsValue::from_str(&format!("Error hashing key package: {:?}", e)))?;

        log(&format!("[WASM] regenerate_key_package: Writing new KeyPackage Hash: {}", hex::encode(hash.as_slice())));

        provider.storage().write_key_package(&hash, &key_package_bundle)
            .map_err(|e| JsValue::from_str(&format!("Error saving key package bundle: {:?}", e)))?;

        self.key_package = Some(key_package_ref.clone());

        log("[WASM] KeyPackage regenerated successfully");

        Ok(())
    }

    /// Generate a last-resort key package and return it with lifetime info
    /// Returns a JsValue containing { key_package_bytes, lifetime, hash }
    pub fn generate_last_resort_key_package(&mut self) -> Result<JsValue, JsValue> {
        let provider = &self.provider;

        let signature_keypair = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;

        let credential = self.credential.as_ref()
            .ok_or_else(|| JsValue::from_str("No credential available"))?;

        let credential_with_key = CredentialWithKey {
            credential: credential.clone(),
            signature_key: signature_keypair.to_public_vec().into(),
        };

        // Build capabilities that include LastResort extension type
        // Per RFC 9420, the leaf node must advertise support for any extension types
        // used in the key package. mark_as_last_resort() adds LastResort to key_package_extensions.
        let capabilities = Capabilities::new(
            None, // versions - use defaults
            None, // ciphersuites - use defaults
            Some(&[ExtensionType::LastResort]), // extensions - advertise LastResort support
            None, // proposals - use defaults
            None, // credentials - use defaults
        );

        let key_package_bundle = KeyPackage::builder()
            .key_package_lifetime(Lifetime::new(KEY_PACKAGE_LIFETIME_SECONDS))
            .leaf_node_capabilities(capabilities)
            .mark_as_last_resort()
            .build(
                Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
                provider,
                signature_keypair,
                credential_with_key,
            )
            .map_err(|e| JsValue::from_str(&format!("Error creating last-resort key package: {:?}", e)))?;

        let key_package_ref = key_package_bundle.key_package();
        let hash = key_package_ref.hash_ref(provider.crypto())
            .map_err(|e| JsValue::from_str(&format!("Error hashing key package: {:?}", e)))?;
        let hash_hex = hex::encode(hash.as_slice());

        log(&format!("[WASM] generate_last_resort_key_package: Writing KeyPackage Hash: {}", &hash_hex));

        provider.storage().write_key_package(&hash, &key_package_bundle)
            .map_err(|e| JsValue::from_str(&format!("Error saving last-resort key package bundle: {:?}", e)))?;

        let key_package_bytes = key_package_ref.tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing last-resort key package: {:?}", e)))?;

        // Return the key package bytes along with lifetime info (we know it since we set it)
        let lifetime = key_package_ref.life_time();
        let result = KeyPackageInfo {
            key_package_bytes,
            hash: hash_hex,
            lifetime: lifetime_info_from(lifetime),
            is_last_resort: true,
        };

        serde_wasm_bindgen::to_value(&result)
            .map_err(|e| JsValue::from_str(&format!("Error serializing result: {:?}", e)))
    }

    /// Generate multiple key packages at once (for pooling)
    /// Returns a JsValue containing { key_packages: [{ key_package_bytes, lifetime, hash, is_last_resort }] }
    /// Per MLS best practices, clients should maintain a pool of pre-uploaded key packages
    pub fn generate_key_packages(&mut self, count: u32) -> Result<JsValue, JsValue> {
        if count == 0 || count > 100 {
            return Err(JsValue::from_str("Count must be between 1 and 100"));
        }

        let provider = &self.provider;

        let signature_keypair = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;

        let credential = self.credential.as_ref()
            .ok_or_else(|| JsValue::from_str("No credential available"))?;

        let mut key_packages = Vec::with_capacity(count as usize);

        for i in 0..count {
            let credential_with_key = CredentialWithKey {
                credential: credential.clone(),
                signature_key: signature_keypair.to_public_vec().into(),
            };

            let key_package_bundle = KeyPackage::builder()
                .key_package_lifetime(Lifetime::new(KEY_PACKAGE_LIFETIME_SECONDS))
                .key_package_extensions(Extensions::default())
                .build(
                    Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
                    provider,
                    signature_keypair,
                    credential_with_key,
                )
                .map_err(|e| JsValue::from_str(&format!("Error creating key package {}: {:?}", i, e)))?;

            let key_package_ref = key_package_bundle.key_package();
            let hash = key_package_ref.hash_ref(provider.crypto())
                .map_err(|e| JsValue::from_str(&format!("Error hashing key package {}: {:?}", i, e)))?;
            let hash_hex = hex::encode(hash.as_slice());

            provider.storage().write_key_package(&hash, &key_package_bundle)
                .map_err(|e| JsValue::from_str(&format!("Error saving key package {}: {:?}", i, e)))?;

            let key_package_bytes = key_package_ref.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing key package {}: {:?}", i, e)))?;

            let lifetime = key_package_ref.life_time();
            key_packages.push(KeyPackageInfo {
                key_package_bytes,
                hash: hash_hex,
                lifetime: lifetime_info_from(lifetime),
                is_last_resort: false,
            });
        }

        log(&format!("[WASM] Generated {} key packages", count));

        // Keep the first one as the "current" key package if we don't have one
        if self.key_package.is_none() {
            if let Some(first) = key_packages.first() {
                if let Ok(kp_in) = KeyPackageIn::tls_deserialize(&mut &first.key_package_bytes[..]) {
                    if let Ok(kp) = kp_in.validate(provider.crypto(), ProtocolVersion::Mls10) {
                        self.key_package = Some(kp);
                    }
                }
            }
        }

        let result = GeneratedKeyPackages { key_packages };
        serde_wasm_bindgen::to_value(&result)
            .map_err(|e| JsValue::from_str(&format!("Error serializing result: {:?}", e)))
    }

    // ... SOTA Security Features ...

    pub fn derive_key_argon2id(password: &str, salt: &[u8]) -> Result<Vec<u8>, JsValue> {
        let argon2 = Argon2::default();
        let mut output_key = [0u8; 32];
        argon2.hash_password_into(password.as_bytes(), salt, &mut output_key)
            .map_err(|e| JsValue::from_str(&format!("Argon2 error: {:?}", e)))?;
        Ok(output_key.to_vec())
    }

    pub fn get_identity_fingerprint(&self) -> Result<String, JsValue> {
        let credential = self.credential.as_ref()
            .ok_or_else(|| JsValue::from_str("No credential available"))?;
        
        let credential_bytes = credential.tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing credential: {:?}", e)))?;
            
        let mut hasher = Sha256::new();
        hasher.update(credential_bytes);
        let result = hasher.finalize();
        Ok(hex::encode(result))
    }

    // ... Group Management ...

    pub fn add_member(&mut self, group_id_bytes: &[u8], key_package_bytes: &[u8]) -> Result<js_sys::Array, JsValue> {
        let signer = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;
            
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
        
        let provider = &self.provider;
        
        // Use KeyPackageIn to deserialize and convert to KeyPackage
        let key_package_in = KeyPackageIn::tls_deserialize(&mut &key_package_bytes[..])
             .map_err(|e| JsValue::from_str(&format!("Error deserializing key package: {:?}", e)))?;

        let key_package = key_package_in.validate(provider.crypto(), ProtocolVersion::Mls10)
             .map_err(|e| JsValue::from_str(&format!("Error validating key package: {:?}", e)))?;

        if !key_package.life_time().has_acceptable_range() {
            return Err(JsValue::from_str("KeyPackage lifetime exceeds acceptable range"));
        }

        let (commit, welcome_msg, group_info) = group.add_members(
            provider,
            signer,
            &[key_package],
        ).map_err(|e| JsValue::from_str(&format!("Error adding member: {:?}", e)))?;

        // Serialize as full MlsMessage (includes type tag)
        let commit_bytes = commit.tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing commit: {:?}", e)))?;

        // Serialize welcome as full MlsMessage (includes type tag for Welcome)
        let welcome_bytes = welcome_msg.tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing welcome: {:?}", e)))?;

        log(&format!("[WASM] add_member: Welcome MlsMessage serialized to {} bytes", welcome_bytes.len()));

        let array = js_sys::Array::new();
        array.push(&js_sys::Uint8Array::from(&welcome_bytes[..]));
        array.push(&js_sys::Uint8Array::from(&commit_bytes[..]));
        if let Some(group_info) = group_info {
            let group_info_bytes = group_info.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing group info: {:?}", e)))?;
            array.push(&js_sys::Uint8Array::from(&group_info_bytes[..]));
        }
        Ok(array)
    }

    pub fn recover_fork_by_readding(
        &mut self,
        group_id_bytes: &[u8],
        own_leaf_indices: js_sys::Array,
        key_packages: js_sys::Array,
    ) -> Result<JsValue, JsValue> {
        let signer = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;

        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;

        let provider = &self.provider;
        let own_partition = parse_leaf_indices(&own_leaf_indices)?;
        let key_packages = parse_key_packages(provider, &key_packages)?;

        let builder = group
            .recover_fork_by_readding(&own_partition)
            .map_err(|e| JsValue::from_str(&format!("Error preparing readd: {:?}", e)))?;

        let message_bundle = builder
            .provide_key_packages(key_packages)
            .load_psks(provider.storage())
            .map_err(|e| JsValue::from_str(&format!("Error loading PSKs: {:?}", e)))?
            .build(provider.rand(), provider.crypto(), signer, |_| true)
            .map_err(|e| JsValue::from_str(&format!("Error building readd commit: {:?}", e)))?
            .stage_commit(provider)
            .map_err(|e| JsValue::from_str(&format!("Error staging readd commit: {:?}", e)))?;

        let (commit_msg, welcome_msg, group_info_msg) = message_bundle.into_messages();
        let commit_bytes = commit_msg
            .tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing commit: {:?}", e)))?;

        let welcome_bytes = match welcome_msg {
            Some(msg) => Some(msg.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing welcome: {:?}", e)))?),
            None => None,
        };

        let group_info_bytes = match group_info_msg {
            Some(msg) => Some(msg.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing group info: {:?}", e)))?),
            None => None,
        };

        let result = CommitBundleResult {
            group_id_hex: hex::encode(group.group_id().as_slice()),
            commit: commit_bytes,
            welcome: welcome_bytes,
            group_info: group_info_bytes,
            epoch: group.epoch().as_u64(),
        };

        serde_wasm_bindgen::to_value(&result)
            .map_err(|e| JsValue::from_str(&format!("Error serializing readd result: {:?}", e)))
    }

    pub fn reboot_group(
        &mut self,
        group_id_bytes: &[u8],
        new_group_id_bytes: &[u8],
        key_packages: js_sys::Array,
        aad_bytes: Vec<u8>,
    ) -> Result<JsValue, JsValue> {
        let signer = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;

        let credential = self.credential.as_ref()
            .ok_or_else(|| JsValue::from_str("No credential available"))?;

        let group = self.groups.get(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;

        let provider = &self.provider;
        let new_members = parse_key_packages(provider, &key_packages)?;

        let join_config = group.configuration().clone();
        let mut group_builder = MlsGroup::builder()
            .with_wire_format_policy(join_config.wire_format_policy())
            .padding_size(join_config.padding_size())
            .max_past_epochs(5)
            .number_of_resumption_psks(RESUMPTION_PSK_WINDOW)
            .use_ratchet_tree_extension(true)
            .sender_ratchet_configuration(join_config.sender_ratchet_configuration().clone())
            .ciphersuite(group.ciphersuite())
            .with_group_id(GroupId::from_slice(new_group_id_bytes));

        let group_info_msg = group
            .export_group_info(provider.crypto(), signer, false)
            .map_err(|e| JsValue::from_str(&format!("Error exporting group info: {:?}", e)))?;
        let group_info = match group_info_msg.body() {
            MlsMessageBodyOut::GroupInfo(info) => info,
            _ => return Err(JsValue::from_str("Exported MLS message did not contain GroupInfo")),
        };
        let extensions = group_info.group_context().extensions().clone();
        group_builder = group_builder
            .with_group_context_extensions(extensions)
            .map_err(|e| JsValue::from_str(&format!("Error setting group extensions: {:?}", e)))?;

        let credential_with_key = CredentialWithKey {
            credential: credential.clone(),
            signature_key: signer.to_public_vec().into(),
        };

        let mut new_group = group_builder
            .build(provider, signer, credential_with_key)
            .map_err(|e| JsValue::from_str(&format!("Error creating reboot group: {:?}", e)))?;

        if !aad_bytes.is_empty() {
            new_group.set_aad(aad_bytes);
        }

        let message_bundle = new_group
            .commit_builder()
            .propose_adds(new_members)
            .load_psks(provider.storage())
            .map_err(|e| JsValue::from_str(&format!("Error loading PSKs: {:?}", e)))?
            .build(provider.rand(), provider.crypto(), signer, |_| true)
            .map_err(|e| JsValue::from_str(&format!("Error building reboot commit: {:?}", e)))?
            .stage_commit(provider)
            .map_err(|e| JsValue::from_str(&format!("Error staging reboot commit: {:?}", e)))?;

        let new_group_id = new_group.group_id().as_slice().to_vec();
        let commit_epoch = new_group.epoch().as_u64();
        self.groups.insert(new_group_id.clone(), new_group);

        let (commit_msg, welcome_msg, group_info_msg) = message_bundle.into_messages();
        let commit_bytes = commit_msg
            .tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing commit: {:?}", e)))?;

        let welcome_bytes = match welcome_msg {
            Some(msg) => Some(msg.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing welcome: {:?}", e)))?),
            None => None,
        };

        let group_info_bytes = match group_info_msg {
            Some(msg) => Some(msg.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing group info: {:?}", e)))?),
            None => None,
        };

        let result = CommitBundleResult {
            group_id_hex: hex::encode(new_group_id),
            commit: commit_bytes,
            welcome: welcome_bytes,
            group_info: group_info_bytes,
            epoch: commit_epoch,
        };

        serde_wasm_bindgen::to_value(&result)
            .map_err(|e| JsValue::from_str(&format!("Error serializing reboot result: {:?}", e)))
    }

    pub fn remove_group(&mut self, group_id_bytes: &[u8]) -> Result<(), JsValue> {
        self.groups.remove(group_id_bytes);
        Ok(())
    }

    pub fn merge_pending_commit(&mut self, group_id_bytes: &[u8]) -> Result<(), JsValue> {
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
        let provider = &self.provider;

        group.merge_pending_commit(provider)
            .map_err(|e| JsValue::from_str(&format!("Error merging pending commit: {:?}", e)))?;

        Ok(())
    }

    pub fn clear_pending_commit(&mut self, group_id_bytes: &[u8]) -> Result<(), JsValue> {
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
        let storage = self.provider.storage();

        group.clear_pending_commit(storage)
            .map_err(|e| JsValue::from_str(&format!("Error clearing pending commit: {:?}", e)))?;

        Ok(())
    }

    /// Update own leaf node (key rotation for Post-Compromise Security)
    /// Returns [commit_bytes, optional_welcome_bytes, optional_group_info_bytes]
    pub fn self_update(&mut self, group_id_bytes: &[u8]) -> Result<js_sys::Array, JsValue> {
        let signer = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;

        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;

        let provider = &self.provider;

        // Use default LeafNodeParameters (only updates HPKE encryption key)
        let leaf_node_params = LeafNodeParameters::default();

        let commit_bundle = group.self_update(
            provider,
            signer,
            leaf_node_params,
        ).map_err(|e| JsValue::from_str(&format!("Error performing self update: {:?}", e)))?;

        let (commit, welcome_option, group_info_option) = commit_bundle.into_contents();

        // Serialize commit
        let commit_bytes = commit.tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing commit: {:?}", e)))?;

        let array = js_sys::Array::new();
        array.push(&js_sys::Uint8Array::from(&commit_bytes[..]));

        // Serialize welcome if present (may exist if there were pending Add proposals)
        if let Some(welcome) = welcome_option {
            let welcome_bytes = welcome.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing welcome: {:?}", e)))?;
            array.push(&js_sys::Uint8Array::from(&welcome_bytes[..]));
        } else {
            array.push(&JsValue::NULL);
        }

        // Serialize group info if present
        if let Some(group_info) = group_info_option {
            let group_info_bytes = group_info.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing group info: {:?}", e)))?;
            array.push(&js_sys::Uint8Array::from(&group_info_bytes[..]));
        }

        log(&format!("[WASM] self_update: key rotation commit created for group, new epoch pending"));
        Ok(array)
    }

    /// Remove a member from the group by their leaf index
    /// Returns [commit_bytes, optional_welcome_bytes, optional_group_info_bytes]
    pub fn remove_member(&mut self, group_id_bytes: &[u8], leaf_index: u32) -> Result<js_sys::Array, JsValue> {
        let signer = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;

        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;

        let provider = &self.provider;

        // Convert u32 to LeafNodeIndex
        let leaf_node_index = LeafNodeIndex::new(leaf_index);

        let (commit, welcome_option, group_info_option) = group.remove_members(
            provider,
            signer,
            &[leaf_node_index],
        ).map_err(|e| JsValue::from_str(&format!("Error removing member: {:?}", e)))?;

        // Serialize commit
        let commit_bytes = commit.tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing commit: {:?}", e)))?;

        let array = js_sys::Array::new();
        array.push(&js_sys::Uint8Array::from(&commit_bytes[..]));

        // Serialize welcome if present (may exist if there were pending Add proposals)
        if let Some(welcome) = welcome_option {
            let welcome_bytes = welcome.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing welcome: {:?}", e)))?;
            array.push(&js_sys::Uint8Array::from(&welcome_bytes[..]));
        } else {
            array.push(&JsValue::NULL);
        }

        // Serialize group info if present
        if let Some(group_info) = group_info_option {
            let group_info_bytes = group_info.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing group info: {:?}", e)))?;
            array.push(&js_sys::Uint8Array::from(&group_info_bytes[..]));
        }

        log(&format!("[WASM] remove_member: removed leaf index {} from group", leaf_index));
        Ok(array)
    }

    /// Leave the group voluntarily (creates a self-remove proposal)
    /// Returns the proposal message bytes (NOT a commit - another member must commit it)
    pub fn leave_group(&mut self, group_id_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        let signer = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;

        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;

        let provider = &self.provider;

        let proposal_message = group.leave_group(
            provider,
            signer,
        ).map_err(|e| JsValue::from_str(&format!("Error leaving group: {:?}", e)))?;

        let proposal_bytes = proposal_message.tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing leave proposal: {:?}", e)))?;

        log(&format!("[WASM] leave_group: self-remove proposal created, awaiting commit by another member"));
        Ok(proposal_bytes)
    }

    /// Get own leaf index in a group (needed for remove_member calls)
    pub fn get_own_leaf_index(&self, group_id_bytes: &[u8]) -> Result<u32, JsValue> {
        let group = self.groups.get(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;

        Ok(group.own_leaf_index().u32())
    }

    /// Stage a welcome for inspection before joining (two-phase join)
    /// Returns a staging_id that can be used with inspect/accept/reject functions
    pub fn stage_welcome(&mut self, welcome_bytes: &[u8], ratchet_tree_bytes: Option<Vec<u8>>) -> Result<String, JsValue> {
        let provider = &self.provider;

        // Deserialize the MLS message
        let mls_message_in = MlsMessageIn::tls_deserialize(&mut &welcome_bytes[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing MLS message: {:?}", e)))?;

        // Extract the Welcome
        let welcome = match mls_message_in.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            other => return Err(JsValue::from_str(&format!("Message is not a Welcome, got: {:?}", std::mem::discriminant(&other)))),
        };

        let ratchet_tree = if let Some(ref bytes) = ratchet_tree_bytes {
            Some(RatchetTreeIn::tls_deserialize(&mut &bytes[..])
                .map_err(|e| JsValue::from_str(&format!("Error deserializing ratchet tree: {:?}", e)))?)
        } else {
            None
        };

        let group_config = MlsGroupJoinConfig::builder()
            .wire_format_policy(WireFormatPolicy::default())
            .padding_size(MESSAGE_PADDING_SIZE)
            .max_past_epochs(5)
            .sender_ratchet_configuration(SenderRatchetConfiguration::new(10, 2000))
            .use_ratchet_tree_extension(true)
            .number_of_resumption_psks(RESUMPTION_PSK_WINDOW)
            .build();

        // Create staged welcome to extract info
        let staged_welcome = StagedWelcome::new_from_welcome(
            provider,
            &group_config,
            welcome,
            ratchet_tree,
        ).map_err(|e| JsValue::from_str(&format!("Error creating staged welcome: {:?}", e)))?;

        // Extract group info
        let group_context = staged_welcome.group_context();
        let group_id_hex = hex::encode(group_context.group_id().as_slice());
        let ciphersuite = format!("{:?}", group_context.ciphersuite());
        let epoch = group_context.epoch().as_u64();

        // Extract sender info (welcome_sender() returns Result<&LeafNode, _>)
        let sender: Option<WelcomeSenderInfo> = staged_welcome.welcome_sender()
            .ok()
            .map(|leaf_node| {
                let credential = leaf_node.credential();
                let (identity, is_basic) = if let Ok(basic) = BasicCredential::try_from(credential.clone()) {
                    (String::from_utf8(basic.identity().to_vec()).unwrap_or_else(|_| hex::encode(basic.identity())), true)
                } else {
                    (hex::encode(credential.serialized_content()), false)
                };
                let lifetime = match leaf_node.leaf_node_source() {
                    LeafNodeSource::KeyPackage(lifetime) => Some(lifetime_info_from(lifetime)),
                    _ => None,
                };
                WelcomeSenderInfo {
                    identity,
                    is_basic_credential: is_basic,
                    signature_key_hex: hex::encode(leaf_node.signature_key().as_slice()),
                    lifetime,
                }
            });

        // Extract member info
        let members: Vec<WelcomeMemberInfo> = staged_welcome.members()
            .map(|member| {
                let (identity, is_basic) = if let Ok(basic) = BasicCredential::try_from(member.credential.clone()) {
                    (String::from_utf8(basic.identity().to_vec()).unwrap_or_else(|_| hex::encode(basic.identity())), true)
                } else {
                    (hex::encode(member.credential.serialized_content()), false)
                };
                WelcomeMemberInfo {
                    leaf_index: member.index.u32(),
                    identity,
                    is_basic_credential: is_basic,
                    signature_key_hex: hex::encode(member.signature_key.as_slice()),
                    encryption_key_hex: hex::encode(member.encryption_key.as_slice()),
                }
            })
            .collect();

        let info = StagedWelcomeInfo {
            group_id_hex: group_id_hex.clone(),
            ciphersuite,
            epoch,
            sender,
            members,
        };

        // Generate a unique staging ID
        let staging_id = format!("welcome_{}", group_id_hex);

        // Store the actual StagedWelcome object for later accept/reject
        // This avoids needing to recreate it (which would fail since KeyPackage was consumed)
        self.staged_welcomes.insert(staging_id.clone(), PendingStagedWelcome {
            staged_welcome,
            info,
        });

        log(&format!("[WASM] Welcome staged with ID: {}", staging_id));
        Ok(staging_id)
    }

    /// Get info about a staged welcome for inspection
    /// Returns JSON with group_id, ciphersuite, epoch, sender, and members
    pub fn get_staged_welcome_info(&self, staging_id: &str) -> Result<JsValue, JsValue> {
        let pending = self.staged_welcomes.get(staging_id)
            .ok_or_else(|| JsValue::from_str("Staged welcome not found"))?;

        serde_wasm_bindgen::to_value(&pending.info)
            .map_err(|e| JsValue::from_str(&format!("Error serializing welcome info: {:?}", e)))
    }

    /// Accept a staged welcome and join the group
    /// Returns the group_id bytes
    pub fn accept_staged_welcome(&mut self, staging_id: &str) -> Result<Vec<u8>, JsValue> {
        let pending = self.staged_welcomes.remove(staging_id)
            .ok_or_else(|| JsValue::from_str("Staged welcome not found"))?;

        // Use the stored StagedWelcome directly (don't recreate - KeyPackage already consumed)
        let provider = &self.provider;

        let group = pending.staged_welcome.into_group(provider)
            .map_err(|e| JsValue::from_str(&format!("Error creating group from welcome: {:?}", e)))?;

        let group_id = group.group_id().as_slice().to_vec();
        self.groups.insert(group_id.clone(), group);

        log(&format!("[WASM] Accepted staged welcome, joined group: {}", hex::encode(&group_id)));
        Ok(group_id)
    }

    /// Reject a staged welcome (discard without joining)
    pub fn reject_staged_welcome(&mut self, staging_id: &str) -> Result<(), JsValue> {
        if self.staged_welcomes.remove(staging_id).is_some() {
            log(&format!("[WASM] Rejected staged welcome: {}", staging_id));
            Ok(())
        } else {
            Err(JsValue::from_str("Staged welcome not found"))
        }
    }

    /// List all pending staged welcomes
    pub fn list_staged_welcomes(&self) -> js_sys::Array {
        let array = js_sys::Array::new();
        for staging_id in self.staged_welcomes.keys() {
            array.push(&JsValue::from_str(staging_id));
        }
        array
    }

    pub fn process_welcome(&mut self, welcome_bytes: &[u8], ratchet_tree_bytes: Option<Vec<u8>>) -> Result<Vec<u8>, JsValue> {
        let provider = &self.provider;

        // First deserialize as MlsMessageIn (the full MLS message wrapper)
        let mls_message_in = MlsMessageIn::tls_deserialize(&mut &welcome_bytes[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing MLS message: {:?}", e)))?;

        // Extract the Welcome from the MLS message body
        let welcome = match mls_message_in.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            other => return Err(JsValue::from_str(&format!("Message is not a Welcome, got: {:?}", std::mem::discriminant(&other)))),
        };

        let ratchet_tree = if let Some(bytes) = ratchet_tree_bytes {
            Some(RatchetTreeIn::tls_deserialize(&mut &bytes[..])
                .map_err(|e| JsValue::from_str(&format!("Error deserializing ratchet tree: {:?}", e)))?)
        } else {
            None
        };

        let group_config = MlsGroupJoinConfig::builder()
            .wire_format_policy(WireFormatPolicy::default())
            .padding_size(MESSAGE_PADDING_SIZE)
            .max_past_epochs(5)  // Allow decrypting messages from up to 5 previous epochs
            .sender_ratchet_configuration(SenderRatchetConfiguration::new(
                10,  // out_of_order_tolerance
                2000 // maximum_forward_distance
            ))
            .use_ratchet_tree_extension(true)
            .number_of_resumption_psks(RESUMPTION_PSK_WINDOW)
            .build();

        log(&format!("[WASM] Processing Welcome with secrets count: {}", welcome.secrets().len()));
        for (i, secret) in welcome.secrets().iter().enumerate() {
            log(&format!("[WASM] Welcome secret #{} expects KeyPackage Hash: {:?}", i, secret.new_member()));
        }

        let staged_welcome = StagedWelcome::new_from_welcome(
            provider,
            &group_config,
            welcome,
            ratchet_tree,
        ).map_err(|e| JsValue::from_str(&format!("Error creating staged welcome: {:?}", e)))?;

        let group = staged_welcome.into_group(provider)
            .map_err(|e| JsValue::from_str(&format!("Error creating group from welcome: {:?}", e)))?;

        let group_id = group.group_id().as_slice().to_vec();
        self.groups.insert(group_id.clone(), group);

        Ok(group_id)
    }

    pub fn process_commit(&mut self, group_id_bytes: &[u8], commit_bytes: &[u8]) -> Result<JsValue, JsValue> {
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;

        if self.staged_commits.contains_key(group_id_bytes) {
            return Err(JsValue::from_str("Staged commit already pending for group"));
        }

        let provider = &self.provider;

        let message_in = MlsMessageIn::tls_deserialize(&mut &commit_bytes[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing commit message: {:?}", e)))?;

        let protocol_message = ProtocolMessage::try_from(message_in)
            .map_err(|e| JsValue::from_str(&format!("Error converting message: {:?}", e)))?;

        let processed_message = group.process_message(
            provider,
            protocol_message,
        ).map_err(|e| JsValue::from_str(&format!("Error processing message: {:?}", e)))?;

        let aad_hex = hex::encode(processed_message.aad());
        let message_epoch = processed_message.epoch().as_u64();

        match processed_message.into_content() {
            ProcessedMessageContent::StagedCommitMessage(staged_commit) => {
                let staged_commit = *staged_commit;
                let mut member_identities = HashMap::new();
                for member in group.members() {
                    member_identities.insert(
                        member.index.u32(),
                        credential_identity_summary(&member.credential),
                    );
                }

                let adds = staged_commit
                    .add_proposals()
                    .map(|proposal| {
                        let key_package = proposal.add_proposal().key_package();
                        let lifetime = Some(key_package.life_time());
                        commit_identity_summary(key_package.leaf_node().credential(), lifetime)
                    })
                    .collect::<Vec<_>>();

                let updates = staged_commit
                    .update_proposals()
                    .map(|proposal| {
                        let leaf_node = proposal.update_proposal().leaf_node();
                        let lifetime = match leaf_node.leaf_node_source() {
                            LeafNodeSource::KeyPackage(lifetime) => Some(lifetime),
                            _ => None,
                        };
                        commit_identity_summary(leaf_node.credential(), lifetime)
                    })
                    .collect::<Vec<_>>();

                let removes = staged_commit
                    .remove_proposals()
                    .map(|proposal| {
                        let leaf_index = proposal.remove_proposal().removed().u32();
                        CommitRemoveSummary {
                            leaf_index,
                            identity: member_identities.get(&leaf_index).cloned(),
                        }
                    })
                    .collect::<Vec<_>>();

                let summary = StagedCommitSummary {
                    adds,
                    removes,
                    updates,
                    self_removed: staged_commit.self_removed(),
                    epoch: message_epoch,
                    aad_hex,
                };

                self.staged_commits.insert(group_id_bytes.to_vec(), staged_commit);

                serde_wasm_bindgen::to_value(&summary)
                    .map_err(|e| JsValue::from_str(&format!("Error serializing commit summary: {:?}", e)))
            },
            _ => Err(JsValue::from_str("Message was not a commit")),
        }
    }

    pub fn process_proposal(&mut self, group_id_bytes: &[u8], proposal_bytes: &[u8]) -> Result<JsValue, JsValue> {
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
        let provider = &self.provider;

        let message_in = MlsMessageIn::tls_deserialize(&mut &proposal_bytes[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing proposal message: {:?}", e)))?;

        let protocol_message = ProtocolMessage::try_from(message_in)
            .map_err(|e| JsValue::from_str(&format!("Error converting message: {:?}", e)))?;

        let processed_message = group.process_message(provider, protocol_message)
            .map_err(|e| JsValue::from_str(&format!("Error processing proposal: {:?}", e)))?;

        let aad_hex = hex::encode(processed_message.aad());
        let message_epoch = processed_message.epoch().as_u64();
        let sender_type = match processed_message.sender() {
            Sender::Member(_) => "member",
            Sender::External(_) => "external",
            Sender::NewMemberCommit => "new_member_commit",
            Sender::NewMemberProposal => "new_member_proposal",
        }
        .to_string();

        match processed_message.into_content() {
            ProcessedMessageContent::ProposalMessage(proposal)
            | ProcessedMessageContent::ExternalJoinProposalMessage(proposal) => {
                let mut member_identities = HashMap::new();
                for member in group.members() {
                    member_identities.insert(
                        member.index.u32(),
                        credential_identity_summary(&member.credential),
                    );
                }

                let mut adds = Vec::new();
                let mut updates = Vec::new();
                let mut removes = Vec::new();
                let proposal_type = match proposal.proposal() {
                    Proposal::Add(add) => {
                        let key_package = add.key_package();
                        let lifetime = Some(key_package.life_time());
                        adds.push(commit_identity_summary(key_package.leaf_node().credential(), lifetime));
                        "add"
                    }
                    Proposal::Update(update) => {
                        let lifetime = match update.leaf_node().leaf_node_source() {
                            LeafNodeSource::KeyPackage(lifetime) => Some(lifetime),
                            _ => None,
                        };
                        updates.push(commit_identity_summary(update.leaf_node().credential(), lifetime));
                        "update"
                    }
                    Proposal::Remove(remove) => {
                        let leaf_index = remove.removed().u32();
                        let identity = member_identities.get(&leaf_index).cloned();
                        removes.push(CommitRemoveSummary { leaf_index, identity });
                        "remove"
                    }
                    Proposal::PreSharedKey(_) => "psk",
                    Proposal::GroupContextExtensions(_) => "group_context_extensions",
                    Proposal::ExternalInit(_) => "external_init",
                    Proposal::ReInit(_) => "reinit",
                    Proposal::Custom(_) => "custom",
                    Proposal::SelfRemove => "self_remove",
                    Proposal::AppAck(_) => "app_ack",
                }
                .to_string();

                group
                    .store_pending_proposal(provider.storage(), *proposal)
                    .map_err(|e| JsValue::from_str(&format!("Error storing proposal: {:?}", e)))?;

                let summary = ProposalSummary {
                    adds,
                    removes,
                    updates,
                    epoch: message_epoch,
                    aad_hex,
                    proposal_type,
                    sender_type,
                };

                serde_wasm_bindgen::to_value(&summary)
                    .map_err(|e| JsValue::from_str(&format!("Error serializing proposal summary: {:?}", e)))
            }
            _ => Err(JsValue::from_str("Processed message was not a proposal")),
        }
    }

    pub fn clear_pending_proposals(&mut self, group_id_bytes: &[u8]) -> Result<(), JsValue> {
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
        let storage = self.provider.storage();

        group
            .clear_pending_proposals(storage)
            .map_err(|e| JsValue::from_str(&format!("Error clearing pending proposals: {:?}", e)))
    }

    pub fn commit_pending_proposals(&mut self, group_id_bytes: &[u8]) -> Result<js_sys::Array, JsValue> {
        let signer = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
        let provider = &self.provider;

        let (commit, welcome, group_info) = group
            .commit_to_pending_proposals(provider, signer)
            .map_err(|e| JsValue::from_str(&format!("Error committing proposals: {:?}", e)))?;

        let commit_bytes = commit
            .tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing commit: {:?}", e)))?;

        let welcome_bytes = match welcome {
            Some(msg) => Some(msg.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing welcome: {:?}", e)))?),
            None => None,
        };

        let group_info_bytes = match group_info {
            Some(info) => Some(info.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing group info: {:?}", e)))?),
            None => None,
        };

        let array = js_sys::Array::new();
        array.push(&js_sys::Uint8Array::from(&commit_bytes[..]));
        if let Some(bytes) = welcome_bytes {
            array.push(&js_sys::Uint8Array::from(&bytes[..]));
        } else {
            array.push(&JsValue::NULL);
        }
        if let Some(bytes) = group_info_bytes {
            array.push(&js_sys::Uint8Array::from(&bytes[..]));
        } else {
            array.push(&JsValue::NULL);
        }

        Ok(array)
    }

    pub fn merge_staged_commit(&mut self, group_id_bytes: &[u8]) -> Result<(), JsValue> {
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
        let provider = &self.provider;

        let staged_commit = self.staged_commits.remove(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("No staged commit pending for group"))?;

        group.merge_staged_commit(provider, staged_commit)
            .map_err(|e| JsValue::from_str(&format!("Error merging staged commit: {:?}", e)))?;

        Ok(())
    }

    pub fn discard_staged_commit(&mut self, group_id_bytes: &[u8]) -> Result<(), JsValue> {
        if self.staged_commits.remove(group_id_bytes).is_some() {
            return Ok(());
        }
        Err(JsValue::from_str("No staged commit pending for group"))
    }

    pub fn get_group_epoch(&self, group_id_bytes: &[u8]) -> Result<u64, JsValue> {
        let group = self.groups.get(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
        Ok(group.epoch().as_u64())
    }

    pub fn get_group_confirmation_tag(&self, group_id_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        let group = self.groups.get(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
        group.confirmation_tag()
            .tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing confirmation tag: {:?}", e)))
    }

    pub fn get_group_member_identities(&self, group_id_bytes: &[u8]) -> Result<js_sys::Array, JsValue> {
        let group = self.groups.get(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;

        let array = js_sys::Array::new();
        for member in group.members() {
            let identity = credential_identity_summary(&member.credential).identity;
            array.push(&JsValue::from_str(&identity));
        }
        Ok(array)
    }

    pub fn get_group_members(&self, group_id_bytes: &[u8]) -> Result<JsValue, JsValue> {
        let group = self.groups.get(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;

        let members: Vec<WelcomeMemberInfo> = group.members()
            .map(|member| {
                let summary = credential_identity_summary(&member.credential);
                WelcomeMemberInfo {
                    leaf_index: member.index.u32(),
                    identity: summary.identity,
                    is_basic_credential: summary.is_basic,
                    signature_key_hex: hex::encode(member.signature_key),
                    encryption_key_hex: hex::encode(member.encryption_key),
                }
            })
            .collect();

        serde_wasm_bindgen::to_value(&members)
            .map_err(|e| JsValue::from_str(&format!("Error serializing group members: {:?}", e)))
    }

    pub fn set_group_aad(&mut self, group_id_bytes: &[u8], aad_bytes: &[u8]) -> Result<(), JsValue> {
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
        group.set_aad(aad_bytes.to_vec());
        Ok(())
    }

    pub fn encrypt_message(&mut self, group_id_bytes: &[u8], message: &[u8]) -> Result<Vec<u8>, JsValue> {
        let signer = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;
            
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
            
        let provider = &self.provider;
        
        let mls_message = group.create_message(
            provider,
            signer,
            message,
        ).map_err(|e| JsValue::from_str(&format!("Error creating message: {:?}", e)))?;

        let message_bytes = mls_message.tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing message: {:?}", e)))?;
            
        Ok(message_bytes)
    }

    pub fn decrypt_message(&mut self, group_id_bytes: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, JsValue> {
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;

        let provider = &self.provider;

        // Deserialize directly to MlsMessageIn
        let message_in = MlsMessageIn::tls_deserialize(&mut &ciphertext[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing message: {:?}", e)))?;

        let protocol_message = ProtocolMessage::try_from(message_in)
            .map_err(|e| JsValue::from_str(&format!("Error converting message: {:?}", e)))?;

        let processed_message = group.process_message(
            provider,
            protocol_message,
        ).map_err(|e| JsValue::from_str(&format!("Error processing message: {:?}", e)))?;

        match processed_message.into_content() {
            ProcessedMessageContent::ApplicationMessage(app_message) => {
                Ok(app_message.into_bytes())
            },
            _ => Err(JsValue::from_str("Message was not an application message")),
        }
    }

    pub fn decrypt_message_with_aad(&mut self, group_id_bytes: &[u8], ciphertext: &[u8]) -> Result<JsValue, JsValue> {
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;

        let provider = &self.provider;

        let message_in = MlsMessageIn::tls_deserialize(&mut &ciphertext[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing message: {:?}", e)))?;

        let protocol_message = ProtocolMessage::try_from(message_in)
            .map_err(|e| JsValue::from_str(&format!("Error converting message: {:?}", e)))?;

        let processed_message = group.process_message(
            provider,
            protocol_message,
        ).map_err(|e| JsValue::from_str(&format!("Error processing message: {:?}", e)))?;

        let aad_hex = hex::encode(processed_message.aad());
        let epoch = processed_message.epoch().as_u64();
        let group_id_hex = hex::encode(processed_message.group_id().as_slice());

        match processed_message.into_content() {
            ProcessedMessageContent::ApplicationMessage(app_message) => {
                let info = DecryptedMessageInfo {
                    plaintext: app_message.into_bytes(),
                    aad_hex,
                    epoch,
                    group_id_hex,
                };
                serde_wasm_bindgen::to_value(&info)
                    .map_err(|e| JsValue::from_str(&format!("Error serializing decrypted message: {:?}", e)))
            },
            _ => Err(JsValue::from_str("Message was not an application message")),
        }
    }

    /// Get list of all group IDs currently in memory
    /// Returns array of group ID byte arrays
    pub fn get_group_ids(&self) -> js_sys::Array {
        let array = js_sys::Array::new();
        for group_id in self.groups.keys() {
            array.push(&js_sys::Uint8Array::from(&group_id[..]));
        }
        array
    }

    /// Check if a specific group exists in memory
    pub fn has_group(&self, group_id_bytes: &[u8]) -> bool {
        self.groups.contains_key(group_id_bytes)
    }

    /// Clear all groups from memory (used when locking vault)
    pub fn clear_groups(&mut self) {
        self.groups.clear();
        self.staged_commits.clear();
        log("[WASM] All groups cleared from memory");
    }

    /// Export the entire storage state for vault persistence
    /// Returns a serialized blob that can be stored encrypted
    pub fn export_storage_state(&self) -> Result<Vec<u8>, JsValue> {
        let storage = self.provider.storage();

        // Debug: log what's in storage before export
        let groups_count = storage.groups.read().unwrap().len();
        let context_count = storage.context.read().unwrap().len();
        let trees_count = storage.trees.read().unwrap().len();
        let epoch_secrets_count = storage.epoch_secrets.read().unwrap().len();
        let sent_msgs_count = storage.sent_messages.read().unwrap().len();
        let own_leaf_nodes_count = storage.own_leaf_nodes.read().unwrap().len();
        let own_leaf_index_count = storage.own_leaf_index.read().unwrap().len();
        log(&format!("[WASM] export_storage_state: groups={}, context={}, trees={}, epoch_secrets={}, sent_messages={}, own_leaf_nodes={}, own_leaf_index={}",
            groups_count, context_count, trees_count, epoch_secrets_count, sent_msgs_count, own_leaf_nodes_count, own_leaf_index_count));

        // Use bincode for fast binary serialization (handles Vec<u8> keys natively)
        let storage_bytes = bincode::serialize(storage)
            .map_err(|e| JsValue::from_str(&format!("Error serializing storage: {:?}", e)))?;
        
        // Append group info for "snapshot" format compatibility
        let mut buffer = Vec::new();
        let s_len = storage_bytes.len() as u64;
        buffer.extend_from_slice(&s_len.to_be_bytes());
        buffer.extend_from_slice(&storage_bytes);
        
        let groups = self.groups.keys().collect::<Vec<_>>();
        let g_len = groups.len() as u64;
        buffer.extend_from_slice(&g_len.to_be_bytes());
        
        for g in groups {
             let len = g.len() as u64;
             buffer.extend_from_slice(&len.to_be_bytes());
             buffer.extend_from_slice(g);
        }
        
        Ok(buffer)
    }

    pub fn import_storage_state(&mut self, data: Vec<u8>) -> Result<(), JsValue> {
        if data.len() < 8 { return Ok(()); }
        let mut pos = 0;
        let s_len = u64::from_be_bytes(data[pos..pos+8].try_into().unwrap()) as usize;
        pos += 8;
        
        if pos + s_len > data.len() { return Err(JsValue::from_str("Truncated data")); }
        let storage_bytes = &data[pos..pos+s_len];
        pos += s_len;
        
        // Deserialize into a temporary GranularStorage using bincode
        let restored: GranularStorage = bincode::deserialize(storage_bytes)
             .map_err(|e| JsValue::from_str(&format!("Error deserializing: {:?}", e)))?;

        // Debug: log what was restored
        let groups_count = restored.groups.read().unwrap().len();
        let context_count = restored.context.read().unwrap().len();
        let trees_count = restored.trees.read().unwrap().len();
        let epoch_secrets_count = restored.epoch_secrets.read().unwrap().len();
        let sent_msgs_count = restored.sent_messages.read().unwrap().len();
        let own_leaf_nodes_count = restored.own_leaf_nodes.read().unwrap().len();
        let own_leaf_index_count = restored.own_leaf_index.read().unwrap().len();
        log(&format!("[WASM] import_storage_state: restored groups={}, context={}, trees={}, epoch_secrets={}, sent_messages={}, own_leaf_nodes={}, own_leaf_index={}",
            groups_count, context_count, trees_count, epoch_secrets_count, sent_msgs_count, own_leaf_nodes_count, own_leaf_index_count));

        // Debug: log the actual keys in ALL relevant HashMaps
        log("[WASM] === Storage HashMap Keys Debug ===");
        for key in restored.groups.read().unwrap().keys() {
            log(&format!("[WASM] groups key: {} (len={})", hex::encode(key), key.len()));
        }
        for key in restored.context.read().unwrap().keys() {
            log(&format!("[WASM] context key: {} (len={})", hex::encode(key), key.len()));
        }
        for key in restored.trees.read().unwrap().keys() {
            log(&format!("[WASM] trees key: {} (len={})", hex::encode(key), key.len()));
        }
        for key in restored.epoch_secrets.read().unwrap().keys() {
            log(&format!("[WASM] epoch_secrets key: {} (len={})", hex::encode(key), key.len()));
        }
        for key in restored.mls_join_configs.read().unwrap().keys() {
            log(&format!("[WASM] mls_join_configs key: {} (len={})", hex::encode(key), key.len()));
        }
        for key in restored.message_secrets.read().unwrap().keys() {
            log(&format!("[WASM] message_secrets key: {} (len={})", hex::encode(key), key.len()));
        }
        for key in restored.interim_transcript_hashes.read().unwrap().keys() {
            log(&format!("[WASM] interim_transcript_hashes key: {} (len={})", hex::encode(key), key.len()));
        }
        for key in restored.confirmation_tags.read().unwrap().keys() {
            log(&format!("[WASM] confirmation_tags key: {} (len={})", hex::encode(key), key.len()));
        }
        for key in restored.own_leaf_nodes.read().unwrap().keys() {
            log(&format!("[WASM] own_leaf_nodes key: {} (len={})", hex::encode(key), key.len()));
        }
        for key in restored.own_leaf_index.read().unwrap().keys() {
            log(&format!("[WASM] own_leaf_index key: {} (len={})", hex::encode(key), key.len()));
        }
        log("[WASM] === End Storage HashMap Keys Debug ===");

        // Copy to provider
        let target = self.provider.storage();
        *target.key_packages.write().unwrap() = restored.key_packages.read().unwrap().clone();
        *target.psks.write().unwrap() = restored.psks.read().unwrap().clone();
        *target.encryption_keys.write().unwrap() = restored.encryption_keys.read().unwrap().clone();
        *target.decryption_keys.write().unwrap() = restored.decryption_keys.read().unwrap().clone();
        *target.signatures.write().unwrap() = restored.signatures.read().unwrap().clone();
        *target.proposals.write().unwrap() = restored.proposals.read().unwrap().clone();
        *target.groups.write().unwrap() = restored.groups.read().unwrap().clone();
        *target.identity.write().unwrap() = restored.identity.read().unwrap().clone();
        *target.mls_join_configs.write().unwrap() = restored.mls_join_configs.read().unwrap().clone();
        *target.own_leaf_nodes.write().unwrap() = restored.own_leaf_nodes.read().unwrap().clone();
        *target.trees.write().unwrap() = restored.trees.read().unwrap().clone();
        *target.epoch_secrets.write().unwrap() = restored.epoch_secrets.read().unwrap().clone();
        *target.message_secrets.write().unwrap() = restored.message_secrets.read().unwrap().clone();
        *target.resumption_psks.write().unwrap() = restored.resumption_psks.read().unwrap().clone();
        *target.context.write().unwrap() = restored.context.read().unwrap().clone();
        *target.interim_transcript_hashes.write().unwrap() = restored.interim_transcript_hashes.read().unwrap().clone();
        *target.confirmation_tags.write().unwrap() = restored.confirmation_tags.read().unwrap().clone();
        *target.own_leaf_index.write().unwrap() = restored.own_leaf_index.read().unwrap().clone();
        *target.sent_messages.write().unwrap() = restored.sent_messages.read().unwrap().clone();

        // Restore groups
        if pos + 8 <= data.len() {
             let g_count = u64::from_be_bytes(data[pos..pos+8].try_into().unwrap()) as usize;
             pos += 8;
             log(&format!("[WASM] import_storage_state: restoring {} groups", g_count));
             self.groups.clear();
             for i in 0..g_count {
                 if pos + 8 > data.len() { break; }
                 let len = u64::from_be_bytes(data[pos..pos+8].try_into().unwrap()) as usize;
                 pos += 8;
                 if pos + len > data.len() { break; }
                 let gid = data[pos..pos+len].to_vec();
                 pos += len;

                 let group_id = GroupId::from_slice(&gid);
                 // Debug: show what key MlsGroup::load will look for
                 let lookup_key = server_ser(&group_id).unwrap_or_default();
                 log(&format!("[WASM] Attempting to load group {}: raw={} lookup_key={} (len={})",
                     i, hex::encode(&gid), hex::encode(&lookup_key), lookup_key.len()));

                 // Debug: Check if this lookup key exists in each HashMap
                 let target = self.provider.storage();
                 let groups_map = target.groups.read().unwrap();
                 let has_group = groups_map.contains_key(&lookup_key);
                 log(&format!("[WASM] Lookup key in groups HashMap: {}", has_group));

                 // If not found, show what keys ARE in the HashMap
                 if !has_group && groups_map.len() > 0 {
                     log("[WASM] === KEY MISMATCH DEBUG ===");
                     // Show as JSON string for readability
                     let lookup_str = String::from_utf8_lossy(&lookup_key);
                     log(&format!("[WASM] Looking for (JSON): {}", lookup_str));
                     log(&format!("[WASM] Looking for (hex): {} (len={})", hex::encode(&lookup_key), lookup_key.len()));
                     for stored_key in groups_map.keys() {
                         let stored_str = String::from_utf8_lossy(stored_key);
                         log(&format!("[WASM] HashMap has (JSON): {}", stored_str));
                         log(&format!("[WASM] HashMap has (hex): {} (len={})", hex::encode(stored_key), stored_key.len()));
                         // Show byte-by-byte comparison
                         if lookup_key.len() == stored_key.len() {
                             let mut diff_positions = Vec::new();
                             for (pos, (a, b)) in lookup_key.iter().zip(stored_key.iter()).enumerate() {
                                 if a != b {
                                     diff_positions.push(format!("pos {}: {} vs {}", pos, a, b));
                                 }
                             }
                             if diff_positions.is_empty() {
                                 log("[WASM] Keys are identical but still not found?!");
                             } else {
                                 log(&format!("[WASM] Differences: {:?}", diff_positions));
                             }
                         } else {
                             log(&format!("[WASM] Length mismatch: lookup={} vs stored={}", lookup_key.len(), stored_key.len()));
                         }
                     }
                     log("[WASM] === END KEY MISMATCH DEBUG ===");
                 }
                 drop(groups_map);

                 // Debug: directly inspect hashmap values for this key
                 {
                     let storage = self.provider.storage();

                     // Check what values exist for this lookup key
                     // Field names from GranularStorage struct:
                     // groups, trees, context, mls_join_configs, epoch_secrets
                     let has_group = storage.groups.read().unwrap().contains_key(&lookup_key);
                     let has_tree = storage.trees.read().unwrap().contains_key(&lookup_key);
                     let has_ctx = storage.context.read().unwrap().contains_key(&lookup_key);
                     let has_cfg = storage.mls_join_configs.read().unwrap().contains_key(&lookup_key);
                     let has_ep_sec = storage.epoch_secrets.read().unwrap().contains_key(&lookup_key);

                     log(&format!("[WASM] Storage state for lookup key:"));
                     log(&format!("[WASM]   groups: {}", has_group));
                     log(&format!("[WASM]   trees: {}", has_tree));
                     log(&format!("[WASM]   context: {}", has_ctx));
                     log(&format!("[WASM]   mls_join_configs: {}", has_cfg));
                     log(&format!("[WASM]   epoch_secrets: {}", has_ep_sec));

                     // If any are missing, that's likely the cause of MlsGroup::load() failing
                     if !has_group || !has_tree || !has_ctx || !has_cfg {
                         log("[WASM] ⚠️  MISSING REQUIRED DATA - this is why MlsGroup::load() returns None!");
                     }
                 }

                 match MlsGroup::load(self.provider.storage(), &group_id) {
                     Ok(Some(group)) => {
                         log(&format!("[WASM] Successfully loaded group: {}", hex::encode(&gid)));
                         self.groups.insert(gid, group);
                     }
                     Ok(None) => {
                         log(&format!("[WASM] Group not found in storage: {}", hex::encode(&gid)));
                     }
                     Err(e) => {
                         log(&format!("[WASM] Error loading group {}: {:?}", hex::encode(&gid), e));
                     }
                 }
             }
             log(&format!("[WASM] Restored {} groups to memory", self.groups.len()));
        }
        Ok(())
    }

    pub fn import_granular_events(&mut self, events_value: JsValue) -> Result<(), JsValue> {
        let events: Vec<StorageEvent> = serde_wasm_bindgen::from_value(events_value)
            .map_err(|e| JsValue::from_str(&format!("Error deserializing events: {:?}", e)))?;
        
        let event_count = events.len();
        
        // Use a block to restrict the scope of the borrow if needed, but here we need storage for MlsGroup::load
        // We will borrow storage reference separately
        let storage = &self.provider.storage;

        for event in events {
            if let Ok(key_bytes) = hex::decode(&event.key) {
                 match event.category.as_str() {
                     "key_package" => Self::apply_event(&storage.key_packages, key_bytes, event.value),
                     "psk" => Self::apply_event(&storage.psks, key_bytes, event.value),
                     "encryption_key" => Self::apply_event(&storage.encryption_keys, key_bytes, event.value),
                     "signature_key" => Self::apply_event(&storage.signatures, key_bytes, event.value),
                     "app_proposal" | "proposal" => Self::apply_event(&storage.proposals, key_bytes, event.value),
                     "group_state" => Self::apply_event(&storage.groups, key_bytes, event.value),
                     "identity" => Self::apply_event(&storage.identity, key_bytes, event.value), 
                     "join_config" => Self::apply_event(&storage.mls_join_configs, key_bytes, event.value),
                     "own_leaf_nodes" => Self::apply_event(&storage.own_leaf_nodes, key_bytes, event.value),
                     "tree" => Self::apply_event(&storage.trees, key_bytes, event.value),
                     "epoch_secrets" => Self::apply_event(&storage.epoch_secrets, key_bytes, event.value),
                     "message_secrets" => Self::apply_event(&storage.message_secrets, key_bytes, event.value),
                     "resumption_psk_store" => Self::apply_event(&storage.resumption_psks, key_bytes, event.value),
                     "context" => Self::apply_event(&storage.context, key_bytes, event.value),
                     "interim_transcript_hash" => Self::apply_event(&storage.interim_transcript_hashes, key_bytes, event.value),
                     "confirmation_tag" => Self::apply_event(&storage.confirmation_tags, key_bytes, event.value),
                     "own_leaf_index" => Self::apply_event(&storage.own_leaf_index, key_bytes, event.value),
                     "sent_message" => Self::apply_event(&storage.sent_messages, key_bytes, event.value),
                     _ => {
                         log(&format!("[WASM] Unknown category in import: {}", event.category));
                     }
                 }
            } else {
                log(&format!("[WASM] Failed to decode hex key: {}", event.key));
            }
        }

        // Restore High-Level Group Objects
        // We need to collect keys first to avoid holding the lock while loading groups
        let group_keys: Vec<Vec<u8>> = {
             let groups_map = storage.groups.read().unwrap();
             groups_map.keys().cloned().collect()
        };
        
        let mut loaded_count = 0;
        for key_bytes in group_keys {
            if let Ok(group_id) = server_de::<GroupId>(&key_bytes) {
                 // self.provider.storage() creates a temporary StorageProviderImpl wrapper in some implementations or returns reference
                 // In our struct GranularProvider, storage() returns &GranularStorage.
                 // safe to call MlsGroup::load(self.provider.storage(), ...)
                 // We pass &self.provider.storage to avoid borrowing all of self.provider
                 
                 match MlsGroup::load(&self.provider.storage, &group_id) {
                     Ok(Some(group)) => {
                         let gid_vec = group.group_id().as_slice().to_vec();
                         self.groups.insert(gid_vec, group);
                         loaded_count += 1;
                     },
                     Ok(None) => log(&format!("[WASM] Group load returned None for key: {}", hex::encode(&key_bytes))),
                     Err(e) => log(&format!("[WASM] Group load failed for key: {}: {:?}", hex::encode(&key_bytes), e)),
                 }
            }
        }
        
        log(&format!("[WASM] Granular hydration complete: {} events, {} groups loaded", event_count, loaded_count));
        Ok(())
    }

    fn apply_event(map_lock: &RwLock<HashMap<Vec<u8>, Vec<u8>>>, key: Vec<u8>, value: Option<Vec<u8>>) {
        let mut map = map_lock.write().unwrap();
        match value {
            Some(v) => { map.insert(key, v); },
            None => { map.remove(&key); },
        }
    }
}

// --- High Performance Storage ---

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct StorageEvent {
    pub key: String,
    pub value: Option<Vec<u8>>, // None means Delete
    pub category: String, // e.g., "key_package", "group_state"
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct GranularStorage {
    pub key_packages: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub psks: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub encryption_keys: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub decryption_keys: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub signatures: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub proposals: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub groups: RwLock<HashMap<Vec<u8>, Vec<u8>>>, // group_state
    pub identity: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    
    // Additional fields for full StorageProvider coverage
    pub mls_join_configs: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub own_leaf_nodes: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub trees: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub epoch_secrets: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub message_secrets: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub resumption_psks: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub context: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub interim_transcript_hashes: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
    pub confirmation_tags: RwLock<HashMap<Vec<u8>, Vec<u8>>>,

    // Own leaf index per group (required for MlsGroup::load)
    pub own_leaf_index: RwLock<HashMap<Vec<u8>, Vec<u8>>>,

    // Sent message plaintexts (for own message history)
    // Key: group_id || msg_id bytes, Value: plaintext bytes
    #[serde(default)]
    pub sent_messages: RwLock<HashMap<Vec<u8>, Vec<u8>>>,

    // The "Dirty Log"
    #[serde(skip)]
    pub dirty_events: RwLock<Vec<StorageEvent>>,
}

// Imports for traits
use openmls_traits::storage::traits as st;

// Error type
#[derive(Debug)]
pub struct StorageError(String);

impl StorageError {
    pub fn decoding_error() -> Self {
        Self("Decoding error".to_string())
    }
}
impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { write!(f, "{}", self.0) }
}
impl std::error::Error for StorageError {}

// Helpers
fn server_ser<T: serde::Serialize + ?Sized>(t: &T) -> Result<Vec<u8>, StorageError> {
    serde_json::to_vec(t).map_err(|e| StorageError(format!("Serde error: {:?}", e)))
}
fn server_de<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, StorageError> {
    serde_json::from_slice(bytes).map_err(|e| StorageError(format!("Serde error: {:?}", e)))
}

macro_rules! impl_read_kv {
    ($name:ident, $map:ident, $K:ident, $V:ident, $K_bound:path, $V_bound:path) => {
        fn $name<$K, $V>(&self, key: &$K) -> Result<Option<$V>, Self::Error>
        where $K: $K_bound + serde::Serialize,
              $V: $V_bound + serde::de::DeserializeOwned
        {
            let k = server_ser(key)?;
            let map = self.$map.read().unwrap();
            match map.get(&k) {
                Some(v) => Ok(Some(server_de(v)?)),
                None => Ok(None),
            }
        }
    };
}

macro_rules! impl_read_vk {
    ($name:ident, $map:ident, $K:ident, $V:ident, $K_bound:path, $V_bound:path) => {
        fn $name<$V, $K>(&self, key: &$K) -> Result<Option<$V>, Self::Error>
        where $V: $V_bound + serde::de::DeserializeOwned,
              $K: $K_bound + serde::Serialize
        {
            let k = server_ser(key)?;
            let map = self.$map.read().unwrap();
            match map.get(&k) {
                Some(v) => Ok(Some(server_de(v)?)),
                None => Ok(None),
            }
        }
    };
}

macro_rules! impl_write_kv {
    ($name:ident, $map:ident, $K:ident, $V:ident, $K_bound:path, $V_bound:path, $cat:expr) => {
        fn $name<$K, $V>(&self, key: &$K, value: &$V) -> Result<(), Self::Error>
        where $K: $K_bound + serde::Serialize,
              $V: $V_bound + serde::Serialize
        {
            let k = server_ser(key)?;
            let v = server_ser(value)?;
            self.$map.write().unwrap().insert(k.clone(), v.clone());
            self.dirty_events.write().unwrap().push(StorageEvent {
                key: hex::encode(&k),
                value: Some(v),
                category: $cat.to_string(),
            });
            Ok(())
        }
    };
}

macro_rules! impl_write_vk {
    ($name:ident, $map:ident, $K:ident, $V:ident, $K_bound:path, $V_bound:path, $cat:expr) => {
        fn $name<$V, $K>(&self, key: &$K, value: &$V) -> Result<(), Self::Error>
        where $V: $V_bound + serde::Serialize,
              $K: $K_bound + serde::Serialize
        {
            let k = server_ser(key)?;
            let v = server_ser(value)?;
            self.$map.write().unwrap().insert(k.clone(), v.clone());
            self.dirty_events.write().unwrap().push(StorageEvent {
                key: hex::encode(&k),
                value: Some(v),
                category: $cat.to_string(),
            });
            Ok(())
        }
    };
}

macro_rules! impl_delete {
    ($name:ident, $map:ident, $K:ident, $K_bound:path, $cat:expr) => {
        fn $name<$K>(&self, key: &$K) -> Result<(), Self::Error>
        where $K: $K_bound + serde::Serialize
        {
            let k = server_ser(key)?;
            self.$map.write().unwrap().remove(&k);
            self.dirty_events.write().unwrap().push(StorageEvent {
                key: hex::encode(&k),
                value: None,
                category: $cat.to_string(),
            });
            Ok(())
        }
    };
}

impl StorageProvider<1> for GranularStorage {
    type Error = StorageError;

    // --- Key Package (KV) ---
    impl_read_kv!(key_package, key_packages, K, V, st::HashReference<1>, st::KeyPackage<1>);
    impl_write_kv!(write_key_package, key_packages, K, V, st::HashReference<1>, st::KeyPackage<1>, "key_package");
    impl_delete!(delete_key_package, key_packages, K, st::HashReference<1>, "key_package");

    // --- PSK (Read: VK, Write: KV) ---
    impl_read_vk!(psk, psks, K, V, st::PskId<1>, st::PskBundle<1>);
    impl_write_kv!(write_psk, psks, K, V, st::PskId<1>, st::PskBundle<1>, "psk");
    impl_delete!(delete_psk, psks, K, st::PskId<1>, "psk");

    // --- Encryption Keys (Read: VK, Write: KV) ---
    impl_read_vk!(encryption_key_pair, encryption_keys, K, V, st::EncryptionKey<1>, st::HpkeKeyPair<1>);
    impl_write_kv!(write_encryption_key_pair, encryption_keys, K, V, st::EncryptionKey<1>, st::HpkeKeyPair<1>, "encryption_key");
    impl_delete!(delete_encryption_key_pair, encryption_keys, K, st::EncryptionKey<1>, "encryption_key");

    // --- Signature Keys (KV) ---
    impl_read_kv!(signature_key_pair, signatures, K, V, st::SignaturePublicKey<1>, st::SignatureKeyPair<1>);
    impl_write_kv!(write_signature_key_pair, signatures, K, V, st::SignaturePublicKey<1>, st::SignatureKeyPair<1>, "signature_key");
    impl_delete!(delete_signature_key_pair, signatures, K, st::SignaturePublicKey<1>, "signature_key");

    // --- MlsGroupState (VK) ---
    // Explicit implementation with debugging instead of macro
    fn group_state<V, K>(&self, key: &K) -> Result<Option<V>, Self::Error>
    where V: st::GroupState<1> + serde::de::DeserializeOwned,
          K: st::GroupId<1> + serde::Serialize
    {
        let k = server_ser(key)?;
        log(&format!("[WASM] group_state() called with key len={}", k.len()));
        let map = self.groups.read().unwrap();
        log(&format!("[WASM] group_state() groups map has {} entries", map.len()));
        match map.get(&k) {
            Some(v) => {
                log(&format!("[WASM] group_state() found value, len={}", v.len()));
                match server_de(v) {
                    Ok(val) => {
                        log("[WASM] group_state() deserialization SUCCESS");
                        Ok(Some(val))
                    }
                    Err(e) => {
                        log(&format!("[WASM] group_state() deserialization FAILED: {:?}", e));
                        Err(e)
                    }
                }
            }
            None => {
                log("[WASM] group_state() key NOT FOUND");
                Ok(None)
            }
        }
    }
    impl_write_vk!(write_group_state, groups, K, V, st::GroupId<1>, st::GroupState<1>, "group_state");
    impl_delete!(delete_group_state, groups, K, st::GroupId<1>, "group_state");

    // --- Join Config (KV) ---
    // Read: mls_group_join_config, Write: write_mls_join_config, Delete: delete_group_config
    // Explicit implementation with debugging
    fn mls_group_join_config<K, V>(&self, key: &K) -> Result<Option<V>, Self::Error>
    where K: st::GroupId<1> + serde::Serialize,
          V: st::MlsGroupJoinConfig<1> + serde::de::DeserializeOwned
    {
        let k = server_ser(key)?;
        log(&format!("[WASM] mls_group_join_config() called with key len={}", k.len()));
        let map = self.mls_join_configs.read().unwrap();
        log(&format!("[WASM] mls_group_join_config() map has {} entries", map.len()));
        match map.get(&k) {
            Some(v) => {
                log(&format!("[WASM] mls_group_join_config() found value, len={}", v.len()));
                match server_de(v) {
                    Ok(val) => {
                        log("[WASM] mls_group_join_config() deserialization SUCCESS");
                        Ok(Some(val))
                    }
                    Err(e) => {
                        log(&format!("[WASM] mls_group_join_config() deserialization FAILED: {:?}", e));
                        Err(e)
                    }
                }
            }
            None => {
                log("[WASM] mls_group_join_config() key NOT FOUND");
                Ok(None)
            }
        }
    }
    impl_write_kv!(write_mls_join_config, mls_join_configs, K, V, st::GroupId<1>, st::MlsGroupJoinConfig<1>, "join_config");
    impl_delete!(delete_group_config, mls_join_configs, K, st::GroupId<1>, "join_config");

    // --- Own Leaf Nodes (KV) ---
    fn own_leaf_nodes<GroupId, LeafNode>(&self, key: &GroupId) -> Result<Vec<LeafNode>, Self::Error>
    where GroupId: st::GroupId<1> + serde::Serialize, LeafNode: st::LeafNode<1> + serde::de::DeserializeOwned
    {
         let k = server_ser(key)?;
         log(&format!("[WASM] own_leaf_nodes() called with key len={}", k.len()));
         let map = self.own_leaf_nodes.read().unwrap();
         log(&format!("[WASM] own_leaf_nodes() map has {} entries", map.len()));
         match map.get(&k) {
             Some(v) => {
                 log(&format!("[WASM] own_leaf_nodes() found value, len={}", v.len()));
                 match server_de::<Vec<LeafNode>>(v) {
                     Ok(nodes) => {
                         log(&format!("[WASM] own_leaf_nodes() deserialization SUCCESS, {} nodes", nodes.len()));
                         Ok(nodes)
                     }
                     Err(e) => {
                         log(&format!("[WASM] own_leaf_nodes() deserialization FAILED: {:?}", e));
                         Err(e)
                     }
                 }
             }
             None => {
                 log("[WASM] own_leaf_nodes() key NOT FOUND, returning empty Vec");
                 Ok(Vec::new())
             }
         }
    }
    fn append_own_leaf_node<GroupId, LeafNode>(&self, key: &GroupId, node: &LeafNode) -> Result<(), Self::Error>
    where GroupId: st::GroupId<1> + serde::Serialize, LeafNode: st::LeafNode<1> + serde::Serialize + serde::de::DeserializeOwned
    {
         let k = server_ser(key)?;
         log(&format!("[WASM] append_own_leaf_node() called with key len={}", k.len()));

         // Helper:
         let mut nodes_vec: Vec<LeafNode> = if let Some(existing) = self.own_leaf_nodes.read().unwrap().get(&k) {
             log(&format!("[WASM] append_own_leaf_node() found existing nodes"));
             server_de(existing)?
         } else {
             log(&format!("[WASM] append_own_leaf_node() no existing nodes, starting fresh"));
             Vec::new()
         };

         // Clone node via serde (since LeafNode doesn't implement Clone)
         let node_clone: LeafNode = server_de(&server_ser(node)?)?;
         nodes_vec.push(node_clone);
         log(&format!("[WASM] append_own_leaf_node() now has {} nodes", nodes_vec.len()));

         let new_val = server_ser(&nodes_vec)?;
         self.own_leaf_nodes.write().unwrap().insert(k.clone(), new_val.clone());

         self.dirty_events.write().unwrap().push(StorageEvent {
            key: hex::encode(&k),
            value: Some(new_val),
            category: "own_leaf_nodes".to_string(),
         });
         log(&format!("[WASM] append_own_leaf_node() successfully stored"));
         Ok(())
    }
    impl_delete!(delete_own_leaf_nodes, own_leaf_nodes, K, st::GroupId<1>, "own_leaf_nodes");

    // --- Trees (KV) ---
    // Read: tree, Write: write_tree, Delete: delete_tree. Type: TreeSync
    // Explicit implementation with debugging instead of macro
    fn tree<K, V>(&self, key: &K) -> Result<Option<V>, Self::Error>
    where K: st::GroupId<1> + serde::Serialize,
          V: st::TreeSync<1> + serde::de::DeserializeOwned
    {
        let k = server_ser(key)?;
        log(&format!("[WASM] tree() called with key len={}", k.len()));
        let map = self.trees.read().unwrap();
        log(&format!("[WASM] tree() trees map has {} entries", map.len()));
        match map.get(&k) {
            Some(v) => {
                log(&format!("[WASM] tree() found value, len={}", v.len()));
                match server_de(v) {
                    Ok(val) => {
                        log("[WASM] tree() deserialization SUCCESS");
                        Ok(Some(val))
                    }
                    Err(e) => {
                        log(&format!("[WASM] tree() deserialization FAILED: {:?}", e));
                        Err(e)
                    }
                }
            }
            None => {
                log("[WASM] tree() key NOT FOUND");
                Ok(None)
            }
        }
    }
    impl_write_kv!(write_tree, trees, K, V, st::GroupId<1>, st::TreeSync<1>, "tree");
    impl_delete!(delete_tree, trees, K, st::GroupId<1>, "tree");

    // --- Epoch Secrets (KV) ---
    impl_read_kv!(group_epoch_secrets, epoch_secrets, K, V, st::GroupId<1>, st::GroupEpochSecrets<1>);
    impl_write_kv!(write_group_epoch_secrets, epoch_secrets, K, V, st::GroupId<1>, st::GroupEpochSecrets<1>, "epoch_secrets");
    impl_delete!(delete_group_epoch_secrets, epoch_secrets, K, st::GroupId<1>, "epoch_secrets");

    // --- Message Secrets (KV) ---
    impl_read_kv!(message_secrets, message_secrets, K, V, st::GroupId<1>, st::MessageSecrets<1>);
    impl_write_kv!(write_message_secrets, message_secrets, K, V, st::GroupId<1>, st::MessageSecrets<1>, "message_secrets");
    impl_delete!(delete_message_secrets, message_secrets, K, st::GroupId<1>, "message_secrets");

    // --- Resumption PSKs (KV) ---
    impl_read_kv!(resumption_psk_store, resumption_psks, K, V, st::GroupId<1>, st::ResumptionPskStore<1>);
    impl_write_kv!(write_resumption_psk_store, resumption_psks, K, V, st::GroupId<1>, st::ResumptionPskStore<1>, "resumption_psk_store");
    impl_delete!(delete_all_resumption_psk_secrets, resumption_psks, K, st::GroupId<1>, "resumption_psk_store");

    // --- Context (KV) ---
    // Read: group_context, Write: write_context, Delete: delete_context.
    // Explicit implementation with debugging
    fn group_context<K, V>(&self, key: &K) -> Result<Option<V>, Self::Error>
    where K: st::GroupId<1> + serde::Serialize,
          V: st::GroupContext<1> + serde::de::DeserializeOwned
    {
        let k = server_ser(key)?;
        log(&format!("[WASM] group_context() called with key len={}", k.len()));
        let map = self.context.read().unwrap();
        log(&format!("[WASM] group_context() map has {} entries", map.len()));
        match map.get(&k) {
            Some(v) => {
                log(&format!("[WASM] group_context() found value, len={}", v.len()));
                match server_de(v) {
                    Ok(val) => {
                        log("[WASM] group_context() deserialization SUCCESS");
                        Ok(Some(val))
                    }
                    Err(e) => {
                        log(&format!("[WASM] group_context() deserialization FAILED: {:?}", e));
                        Err(e)
                    }
                }
            }
            None => {
                log("[WASM] group_context() key NOT FOUND");
                Ok(None)
            }
        }
    }
    impl_write_kv!(write_context, context, K, V, st::GroupId<1>, st::GroupContext<1>, "context");
    impl_delete!(delete_context, context, K, st::GroupId<1>, "context");

    // --- Interim Transcript Hash (KV) ---
    impl_read_kv!(interim_transcript_hash, interim_transcript_hashes, K, V, st::GroupId<1>, st::InterimTranscriptHash<1>);
    impl_write_kv!(write_interim_transcript_hash, interim_transcript_hashes, K, V, st::GroupId<1>, st::InterimTranscriptHash<1>, "interim_transcript_hash");
    impl_delete!(delete_interim_transcript_hash, interim_transcript_hashes, K, st::GroupId<1>, "interim_transcript_hash");

    // --- Confirmation Tag (KV) ---
    impl_read_kv!(confirmation_tag, confirmation_tags, K, V, st::GroupId<1>, st::ConfirmationTag<1>);
    impl_write_kv!(write_confirmation_tag, confirmation_tags, K, V, st::GroupId<1>, st::ConfirmationTag<1>, "confirmation_tag");
    impl_delete!(delete_confirmation_tag, confirmation_tags, K, st::GroupId<1>, "confirmation_tag");

    // --- Proposals (KV) ---
    fn queue_proposal<GroupId, ProposalRef, Proposal>(&self, group_id: &GroupId, proposal_ref: &ProposalRef, proposal: &Proposal) -> Result<(), Self::Error> 
    where GroupId: st::GroupId<1> + serde::Serialize,
          ProposalRef: st::ProposalRef<1> + serde::Serialize,
          Proposal: st::QueuedProposal<1> + serde::Serialize
    {
        let mut k = server_ser(group_id)?;
        k.extend_from_slice(&server_ser(proposal_ref)?);
        let v = server_ser(proposal)?;
        
        self.proposals.write().unwrap().insert(k.clone(), v.clone());
        self.dirty_events.write().unwrap().push(StorageEvent {
            key: hex::encode(&k),
            value: Some(v),
            category: "proposal".to_string(),
        });
        Ok(())
    }
    
    fn remove_proposal<GroupId, ProposalRef>(&self, group_id: &GroupId, proposal_ref: &ProposalRef) -> Result<(), Self::Error> 
    where GroupId: st::GroupId<1> + serde::Serialize,
          ProposalRef: st::ProposalRef<1> + serde::Serialize
    {
        let mut k = server_ser(group_id)?;
        k.extend_from_slice(&server_ser(proposal_ref)?);
        self.proposals.write().unwrap().remove(&k);
        self.dirty_events.write().unwrap().push(StorageEvent {
            key: hex::encode(&k),
            value: None,
            category: "proposal".to_string(),
        });
        Ok(())
    }

    fn queued_proposals<GroupId, ProposalRef, QueuedProposal>(&self, group_id: &GroupId) -> Result<Vec<(ProposalRef, QueuedProposal)>, Self::Error>
    where GroupId: st::GroupId<1> + serde::Serialize,
          ProposalRef: st::ProposalRef<1> + serde::de::DeserializeOwned,
          QueuedProposal: st::QueuedProposal<1> + serde::de::DeserializeOwned
    {
        // Must scan keys starting with group_id + proposal_ref?
        // ProposalRef is variable length?
        // Actually, our key strategy `group_id + proposal_ref` makes efficient iteration hard without prefix scan.
        // HashMap scan is slow (O(N)). Wire app approach would just list them.
        // For now, scan all proposals.
        // But `ProposalRef` is Part 2 of key.
        // `server_ser(group_id)` gives prefix.
        
        let prefix = server_ser(group_id)?;
        let map = self.proposals.read().unwrap();
        let mut res = Vec::new();
        
        for (k, v) in map.iter() {
            if k.starts_with(&prefix) {
                // Key = prefix + proposal_ref_bytes.
                // We need to deserialize proposal_ref_bytes.
                let ref_bytes = &k[prefix.len()..];
                // Deserialize ref
                let p_ref: ProposalRef = serde_json::from_slice(ref_bytes).map_err(|_| StorageError::decoding_error())?;
                let p_val: QueuedProposal = server_de(v)?;
                res.push((p_ref, p_val));
            }
        }
        Ok(res)
    }
    
    fn queued_proposal_refs<GroupId, ProposalRef>(&self, group_id: &GroupId) -> Result<Vec<ProposalRef>, Self::Error> 
    where GroupId: st::GroupId<1> + serde::Serialize,
          ProposalRef: st::ProposalRef<1> + serde::de::DeserializeOwned 
    { 
        let prefix = server_ser(group_id)?;
        let map = self.proposals.read().unwrap();
        let mut res = Vec::new();
        
        for k in map.keys() {
            if k.starts_with(&prefix) {
                let ref_bytes = &k[prefix.len()..];
                let p_ref: ProposalRef = serde_json::from_slice(ref_bytes).map_err(|_| StorageError::decoding_error())?;
                res.push(p_ref);
            }
        }
        Ok(res)
    }
    
    fn clear_proposal_queue<GroupId, ProposalRef>(&self, group_id: &GroupId) -> Result<(), Self::Error> 
    where GroupId: st::GroupId<1> + serde::Serialize,
          ProposalRef: st::ProposalRef<1> + serde::Serialize
    {
        // Scan and remove
        let prefix = server_ser(group_id)?;
        let mut map = self.proposals.write().unwrap();
        // Collect keys to remove
        let keys_to_remove: Vec<Vec<u8>> = map.keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
            
        for k in keys_to_remove {
            map.remove(&k);
            self.dirty_events.write().unwrap().push(StorageEvent {
                key: hex::encode(&k),
                value: None,
                category: "proposal".to_string(),
            });
        }
        Ok(())
    }
    
    fn encryption_epoch_key_pairs<GroupId, EpochKey, HpkeKeyPair>(&self, _group_id: &GroupId, _epoch_key: &EpochKey, _leaf_index: u32) -> Result<Vec<HpkeKeyPair>, Self::Error> 
    where GroupId: st::GroupId<1>, EpochKey: st::EpochKey<1>, HpkeKeyPair: st::HpkeKeyPair<1>
    {
        Ok(Vec::new()) 
    }
    
    fn write_encryption_epoch_key_pairs<GroupId, EpochKey, HpkeKeyPair>(&self, _group_id: &GroupId, _epoch_key: &EpochKey, _leaf_index: u32, _key_pairs: &[HpkeKeyPair]) -> Result<(), Self::Error> 
    where GroupId: st::GroupId<1>, EpochKey: st::EpochKey<1>, HpkeKeyPair: st::HpkeKeyPair<1>
    {
       Ok(())
    }
    
    fn delete_encryption_epoch_key_pairs<GroupId, EpochKey>(&self, _group_id: &GroupId, _epoch_key: &EpochKey, _leaf_index: u32) -> Result<(), Self::Error> 
    where GroupId: st::GroupId<1>, EpochKey: st::EpochKey<1>
    {
       Ok(())
    }

    fn own_leaf_index<GroupId, LeafNodeIndex>(&self, group_id: &GroupId) -> Result<Option<LeafNodeIndex>, Self::Error>
    where GroupId: st::GroupId<1> + serde::Serialize, LeafNodeIndex: st::LeafNodeIndex<1> + serde::de::DeserializeOwned
    {
        let k = server_ser(group_id)?;
        log(&format!("[WASM] own_leaf_index() called with key len={}", k.len()));
        let map = self.own_leaf_index.read().unwrap();
        log(&format!("[WASM] own_leaf_index() map has {} entries", map.len()));
        match map.get(&k) {
            Some(v) => {
                log(&format!("[WASM] own_leaf_index() found value, len={}", v.len()));
                match server_de(v) {
                    Ok(val) => {
                        log("[WASM] own_leaf_index() deserialization SUCCESS");
                        Ok(Some(val))
                    }
                    Err(e) => {
                        log(&format!("[WASM] own_leaf_index() deserialization FAILED: {:?}", e));
                        Err(e)
                    }
                }
            }
            None => {
                log("[WASM] own_leaf_index() key NOT FOUND");
                Ok(None)
            }
        }
    }

    fn write_own_leaf_index<GroupId, LeafNodeIndex>(&self, group_id: &GroupId, index: &LeafNodeIndex) -> Result<(), Self::Error>
    where GroupId: st::GroupId<1> + serde::Serialize, LeafNodeIndex: st::LeafNodeIndex<1> + serde::Serialize
    {
        let k = server_ser(group_id)?;
        let v = server_ser(index)?;
        log(&format!("[WASM] write_own_leaf_index() called with key len={}, value len={}", k.len(), v.len()));
        self.own_leaf_index.write().unwrap().insert(k.clone(), v.clone());
        self.dirty_events.write().unwrap().push(StorageEvent {
            key: hex::encode(&k),
            value: Some(v),
            category: "own_leaf_index".to_string(),
        });
        log("[WASM] write_own_leaf_index() stored successfully");
        Ok(())
    }

    fn delete_own_leaf_index<GroupId>(&self, group_id: &GroupId) -> Result<(), Self::Error>
    where GroupId: st::GroupId<1> + serde::Serialize
    {
        let k = server_ser(group_id)?;
        log(&format!("[WASM] delete_own_leaf_index() called with key len={}", k.len()));
        self.own_leaf_index.write().unwrap().remove(&k);
        self.dirty_events.write().unwrap().push(StorageEvent {
            key: hex::encode(&k),
            value: None,
            category: "own_leaf_index".to_string(),
        });
        Ok(())
    }
     
    fn version() -> u16 { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmls_traits::storage::StorageProvider;
    use openmls::ciphersuite::hash_ref::{make_proposal_ref, ProposalRef};

    #[test]
    fn key_package_roundtrip_records_events() {
        let provider = GranularProvider::default();
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
        let signature_keypair = SignatureKeyPair::new(ciphersuite.signature_algorithm())
            .expect("signature keypair");
        let credential = Credential::new(CredentialType::Basic, b"test-user".to_vec());
        let credential_with_key = CredentialWithKey {
            credential: credential.clone(),
            signature_key: signature_keypair.to_public_vec().into(),
        };
        let key_package_bundle = KeyPackage::builder()
            .key_package_extensions(Extensions::default())
            .build(ciphersuite, &provider, &signature_keypair, credential_with_key)
            .expect("key package bundle");
        let hash = key_package_bundle
            .key_package()
            .hash_ref(provider.crypto())
            .expect("hash");

        let storage = provider.storage();
        let initial_len = storage.dirty_events.read().unwrap().len();

        storage
            .write_key_package(&hash, &key_package_bundle)
            .expect("write key package");
        let read: Option<KeyPackageBundle> = storage.key_package(&hash).expect("read key package");

        assert!(read.is_some());

        let events = storage.dirty_events.read().unwrap();
        assert_eq!(events.len(), initial_len + 1);
        assert_eq!(events.last().unwrap().category, "key_package");

        drop(events);

        storage.delete_key_package(&hash).expect("delete key package");
        let events = storage.dirty_events.read().unwrap();
        assert_eq!(events.len(), initial_len + 2);
        assert!(events.last().unwrap().value.is_none());
    }

    #[test]
    fn join_config_roundtrip_records_events() {
        let storage = GranularStorage::default();
        let group_id = GroupId::from_slice(b"test-group");
        let join_config = MlsGroupJoinConfig::builder()
            .wire_format_policy(WireFormatPolicy::default())
            .max_past_epochs(5)
            .build();

        let initial_len = storage.dirty_events.read().unwrap().len();

        storage
            .write_mls_join_config(&group_id, &join_config)
            .expect("write join config");
        let read: Option<MlsGroupJoinConfig> =
            storage.mls_group_join_config(&group_id).expect("read join config");

        assert!(read.is_some());

        let events = storage.dirty_events.read().unwrap();
        assert_eq!(events.len(), initial_len + 1);
        assert_eq!(events.last().unwrap().category, "join_config");

        drop(events);

        storage
            .delete_group_config(&group_id)
            .expect("delete join config");
        let events = storage.dirty_events.read().unwrap();
        assert_eq!(events.len(), initial_len + 2);
        assert!(events.last().unwrap().value.is_none());
    }

    #[test]
    fn signature_key_pair_roundtrip_records_events() {
        let storage = GranularStorage::default();
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
        let signature_keypair = SignatureKeyPair::new(ciphersuite.signature_algorithm())
            .expect("signature keypair");
        let storage_id = signature_keypair.id();

        let initial_len = storage.dirty_events.read().unwrap().len();

        storage
            .write_signature_key_pair(&storage_id, &signature_keypair)
            .expect("write signature key");
        let read: Option<SignatureKeyPair> = storage
            .signature_key_pair(&storage_id)
            .expect("read signature key");

        assert!(read.is_some());
        assert_eq!(
            read.unwrap().to_public_vec(),
            signature_keypair.to_public_vec()
        );

        let events = storage.dirty_events.read().unwrap();
        assert_eq!(events.len(), initial_len + 1);
        assert_eq!(events.last().unwrap().category, "signature_key");

        drop(events);

        storage
            .delete_signature_key_pair(&storage_id)
            .expect("delete signature key");
        let events = storage.dirty_events.read().unwrap();
        assert_eq!(events.len(), initial_len + 2);
        assert!(events.last().unwrap().value.is_none());
    }

    #[test]
    fn group_state_roundtrip_records_events() {
        let storage = GranularStorage::default();
        let group_id = GroupId::from_slice(b"group-state");
        let state = MlsGroupState::Operational;

        let initial_len = storage.dirty_events.read().unwrap().len();

        storage
            .write_group_state(&group_id, &state)
            .expect("write group state");
        let read: Option<MlsGroupState> = storage
            .group_state(&group_id)
            .expect("read group state");

        assert!(matches!(read, Some(MlsGroupState::Operational)));

        let events = storage.dirty_events.read().unwrap();
        assert_eq!(events.len(), initial_len + 1);
        assert_eq!(events.last().unwrap().category, "group_state");

        drop(events);

        storage
            .delete_group_state(&group_id)
            .expect("delete group state");
        let events = storage.dirty_events.read().unwrap();
        assert_eq!(events.len(), initial_len + 2);
        assert!(events.last().unwrap().value.is_none());
    }

    #[test]
    fn queued_proposal_refs_scoped_to_group() {
        let storage = GranularStorage::default();
        let group_a = GroupId::from_slice(b"group-a");
        let group_b = GroupId::from_slice(b"group-b");
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
        let crypto = RustCrypto::default();
        let ref_a = make_proposal_ref(b"proposal-a", ciphersuite, &crypto)
            .expect("proposal ref a");
        let ref_b = make_proposal_ref(b"proposal-b", ciphersuite, &crypto)
            .expect("proposal ref b");

        let mut key_a = server_ser(&group_a).expect("serialize group a");
        key_a.extend_from_slice(&server_ser(&ref_a).expect("serialize proposal a"));
        let mut key_b = server_ser(&group_b).expect("serialize group b");
        key_b.extend_from_slice(&server_ser(&ref_b).expect("serialize proposal b"));

        {
            let mut proposals = storage.proposals.write().unwrap();
            proposals.insert(key_a, vec![1]);
            proposals.insert(key_b, vec![2]);
        }

        let refs: Vec<ProposalRef> = storage
            .queued_proposal_refs(&group_a)
            .expect("proposal refs");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0], ref_a);

        storage
            .clear_proposal_queue::<GroupId, ProposalRef>(&group_a)
            .expect("clear proposal queue");

        let prefix = server_ser(&group_a).expect("serialize group a");
        let proposals = storage.proposals.read().unwrap();
        assert!(proposals.keys().all(|k| !k.starts_with(&prefix)));
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn export_import_roundtrip_restores_groups() {
        let mut client = MlsClient::new();
        client.create_identity("alice").expect("create identity");
        let group_id = client
            .create_group(b"roundtrip-group")
            .expect("create group");

        assert_eq!(client.groups.len(), 1);

        let blob = client.export_storage_state().expect("export storage");
        let mut restored = MlsClient::new();
        restored.import_storage_state(blob).expect("import storage");

        assert_eq!(restored.groups.len(), 1);
        assert!(restored.groups.contains_key(&group_id));
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn import_storage_state_rejects_truncated_blob() {
        let mut client = MlsClient::new();
        let mut data = Vec::new();
        data.extend_from_slice(&10u64.to_be_bytes());
        assert!(client.import_storage_state(data).is_err());
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn regenerate_key_package_records_event() {
        let mut client = MlsClient::new();
        client.create_identity("bob").expect("create identity");

        let before = client.provider.storage().dirty_events.read().unwrap().len();
        client
            .regenerate_key_package()
            .expect("regenerate key package");
        let after = client.provider.storage().dirty_events.read().unwrap().len();

        assert_eq!(after, before + 1);
    }
}
